#!/usr/bin/env python3
"""Exercise the running Ishtirak Compose prototype without deleting its data.

Run from the project root: python scripts/evaluate.py
Requires the local dashboard/control API, Python 3.10+, and Docker Compose CLI.
Uses only Python's standard library.

Expected runtime (estimate, not measured here): a healthy run takes roughly
8-12 minutes; the sum of all phase deadlines bounds an unhealthy run to about
30 minutes (see EXPECTED_RUNTIME_MINUTES). Deadlines: initial readiness <=120s;
gateway reclaim <=35s (x3 trials); failover <=45s (x3 trials); majority-loss
hold 13s; PostgreSQL recovery <=45s; capacity reclaim <=35s; each load settles
10s, runs 5 measured trials of 200 requests, and observes MQTT for 5s; the
concurrency sweep settles 10s and runs 4 levels; the end-to-end phase takes
about 1 minute. Explicit failures can consume these deadlines.

Repeated trials: each load runs 5 trials, leader failover and gateway
reclamation run 3 trials each. Every trial is recorded under "trials" and
summarised (n, mean, sample stdev, min, max) under "summary". The existing
top-level fields are taken from the MEDIAN trial, named in "headline_basis".
Trials come from one run on one stack, so the spread describes run-to-run
noise on this machine, not independent samples.

Percentile method: p50/p95 use linear interpolation between order statistics
(rank = (n - 1) * fraction), the same as numpy's default; reported in the JSON
as percentile_method = "linear interpolation".

The runner temporarily stops owned services and restores all controlled services
in finally, also restoring the original meter configuration. It never removes
containers or volumes. Request timing measures HTTP allocation decisions (both
accepted and rejected); it is not end-to-end MQTT-to-grant latency. The
end_to_end_latency phase measures the meter demand change -> gateway-observed
demand path (served amps are lease-capped, so they are recorded only when they
also move) by polling the dashboard overview at E2E_POLL_INTERVAL_SECONDS; the result is an
upper bound at that resolution (plus one overview round trip and any dashboard
caching). The sampled capacity invariant is observational evidence, not an
exhaustive safety proof.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid


COORDINATORS = ("coordinator1", "coordinator2", "coordinator3")
GATEWAYS = ("gateway-hamra", "gateway-mar-mikhael", "gateway-achrafieh")
BUILDINGS = ("hamra", "mar_mikhael", "achrafieh")
SERVICES = ("postgres", "mosquitto", *COORDINATORS, *GATEWAYS, "meters")

PERCENTILE_METHOD = "linear interpolation"
LOAD_TRIALS = 5                    # measured trials per load (settled once per load)
REQUESTS_PER_TRIAL = 200
LOAD_WORKERS = 4
SWEEP_WORKERS = (1, 4, 16, 64)     # concurrency sweep at 50 meters
SAFETY_TRIALS = 3                  # leader failover and gateway reclamation repeats
E2E_SAMPLES = 5
E2E_POLL_INTERVAL_SECONDS = 0.1    # sleep between overview polls; detection is an upper bound
E2E_LOW_FACTOR, E2E_HIGH_FACTOR = 0.5, 1.0
E2E_SETTLE_SECONDS = 8
E2E_MIN_STEP_AMPS = 1.0            # smaller served-amps step cannot be told from noise
E2E_MOVE_FRACTION = 0.1            # "moved" = 10% of the calibrated step (and >= 0.25 A)
E2E_MOVE_FLOOR_AMPS = 0.25
E2E_TIMEOUT_SECONDS = 20
RECOVERY_SPIKE_SECONDS = 10        # hold the 200-meter spike so a large reservation can form
RECOVERY_TIMEOUT_SECONDS = 90      # two 12 s holds plus renewal and retry margins, with slack
RECOVERY_RATIO, RECOVERY_SLACK_AMPS = 1.5, 3
RECOVERY_QUIET_METERS, RECOVERY_QUIET_SECONDS = 10, 20   # reservations decay to a few amps before the spike
RECOVERY_SPIKE_MIN_AMPS = 60       # a single reservation this large means the first-come hold was reproduced
# Estimate only (not measured): typical healthy run and the sum-of-deadlines bound.
EXPECTED_RUNTIME_MINUTES = {"typical": [8, 12], "deadline_bound": 30}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def percentile(values, fraction):
    """Linear interpolation over actual samples; empty populations stay null."""
    if not values:
        return None
    ordered = sorted(values)
    point = (len(ordered) - 1) * fraction
    lo, hi = math.floor(point), math.ceil(point)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (point - lo), 3)


def summarize(values):
    """n, mean, sample stdev (0.0 for one value), min, max; Nones when empty."""
    values = list(values)
    if not values:
        return {"n": 0, "mean": None, "stdev": None, "min": None, "max": None}
    stdev = statistics.stdev(values) if len(values) > 1 else 0.0
    return {"n": len(values), "mean": round(statistics.fmean(values), 3),
            "stdev": round(stdev, 3), "min": min(values), "max": max(values)}


def median_index(values):
    """Index of the median element (lower middle for even counts)."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    return order[(len(order) - 1) // 2]


def non_200_summary(rows):
    """Non-200 responses are unknown outcomes, never counted as rejections."""
    by_status = {}
    for row in rows:
        if row["status"] != 200:
            by_status[str(row["status"])] = by_status.get(str(row["status"]), 0) + 1
    return {"count": sum(by_status.values()), "by_status": by_status,
            "unknown_outcomes": sum(1 for r in rows if r.get("accepted") is None),
            "note": "status 0 = transport error/timeout; outcome unknown, not a rejection"}


def latency_summary(rows, elapsed, workers=LOAD_WORKERS):
    def population(selected):
        times = [row["latency_ms"] for row in selected]
        return {"count": len(times), "p50_ms": percentile(times, .5),
                "p95_ms": percentile(times, .95)}
    return {"all_decisions": population(rows),
            "accepted": population([r for r in rows if r.get("accepted") is True]),
            "rejected": population([r for r in rows if r.get("accepted") is False]),
            "transport_or_http_errors": population([r for r in rows if r.get("accepted") is None]),
            "elapsed_seconds": round(elapsed, 3),
            "decision_requests_per_second": round(len(rows) / elapsed, 3) if elapsed > 0 else None,
            "measurement": "HTTP decision latency, including denied decisions; "
                           + ("four" if workers == 4 else str(workers))
                           + (" concurrent client" if workers == 1 else " concurrent clients")}


class Evaluation:
    def __init__(self, base, project_dir, output):
        self.base = base.rstrip("/")
        self.project_dir, self.output = project_dir, output
        self.run_id = uuid.uuid4().hex[:12]
        self.stop_sampler = threading.Event()
        self.lock = threading.Lock()
        self.invariant_failures = []
        self.sample_errors = 0
        self.samples = 0
        self.node_samples = 0
        self.max_granted = 0
        self.original_config = {"meter_count": 50, "demand_factor": 1.0}
        self.report = {"run_id": self.run_id, "started_at": datetime.now(timezone.utc).isoformat(),
                       "base_url": self.base, "phases": {}, "restoration": [], "passed": False,
                       "percentile_method": PERCENTILE_METHOD,
                       "design": {"load_trials": LOAD_TRIALS, "requests_per_trial": REQUESTS_PER_TRIAL,
                                  "load_workers": LOAD_WORKERS, "sweep_workers": list(SWEEP_WORKERS),
                                  "safety_trials": SAFETY_TRIALS, "e2e_samples": E2E_SAMPLES,
                                  "e2e_poll_interval_seconds": E2E_POLL_INTERVAL_SECONDS,
                                  "expected_runtime_minutes": EXPECTED_RUNTIME_MINUTES},
                       "limitations": ["Sampled state cannot prove absence of transients between polls.",
                                        "Trials come from one run on one stack; stdev shows run-to-run spread, not independent samples.",
                                        "Decision latency includes both accepted and rejected HTTP responses.",
                                        "No gateway disk persistence, database failover, or physical breaker is evaluated."]}

    def request(self, path, payload=None, timeout=8):
        started = time.perf_counter()
        data = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(self.base + path, data=data,
                                         headers={"Content-Type": "application/json"})
        try:
            # Never follow a coordinator redirect into an internal Docker hostname.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=timeout) as response:
                status, body = response.status, response.read(2_000_001)
        except urllib.error.HTTPError as error:
            status, body = error.code, error.read(16_384)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            return {"status": 0, "data": {}, "error": str(error),
                    "latency_ms": round((time.perf_counter() - started) * 1000, 3)}
        try:
            result = json.loads(body) if len(body) <= 2_000_000 else {}
            if not isinstance(result, dict):
                result = {"error": "response is not an object"}
        except (ValueError, UnicodeDecodeError):
            result = {"error": body[:200].decode(errors="replace")}
        return {"status": status, "data": result,
                "latency_ms": round((time.perf_counter() - started) * 1000, 3)}

    def overview(self):
        response = self.request("/api/overview", timeout=5)
        if response["status"] != 200 or "nodes" not in response["data"]:
            raise RuntimeError(f"overview unavailable: {response}")
        return response["data"]

    @staticmethod
    def leader_in(overview):
        leaders = [n for n in overview.get("nodes", []) if n.get("online")
                   and n.get("data", {}).get("state") == "Leader" and n["data"].get("quorum")]
        return leaders[0] if len(leaders) == 1 else None

    def wait(self, description, predicate, deadline=30, interval=.5):
        end, last = time.monotonic() + deadline, None
        while time.monotonic() < end:
            self.assert_invariants()
            try:
                result = predicate()
                if result:
                    return result
            except (RuntimeError, OSError, ValueError, KeyError) as error:
                last = str(error)
            self.stop_sampler.wait(min(interval, max(0, end - time.monotonic())))
        raise AssertionError(f"deadline exceeded waiting for {description}; last={last}")

    def leader(self, deadline=30):
        return self.wait("one leader with quorum", lambda: self.leader_in(self.overview()), deadline)

    def sample(self, overview):
        failures, count, maximum = [], 0, 0
        for node in overview.get("nodes", []):
            if not node.get("online"):
                continue
            state = node.get("data", {})
            leases = state.get("leases", [])
            if isinstance(leases, dict):
                leases = list(leases.values())
            total = sum(lease["amps"] for lease in leases)
            granted, capacity = state["granted_amps"], state["capacity_amps"]
            count += 1
            maximum = max(maximum, granted)
            if total != granted or not 0 <= granted <= capacity or any(l["amps"] < 0 for l in leases):
                failures.append({"node": node["id"], "sum_leases": total,
                                 "granted": granted, "capacity": capacity})
        for building in overview.get("buildings", []):
            if not building.get("online"):
                continue
            state = building["data"]
            served, granted = state["served_amps"], state["granted_amps"]
            if served < 0 or served > min(state["demand_amps"], granted) + 1e-6 or (
                    state["lease_remaining_ms"] <= 0 and served != 0):
                failures.append({"building": building["id"], "invalid_service": state})
        with self.lock:
            self.samples += 1
            self.node_samples += count
            self.max_granted = max(self.max_granted, maximum)
            self.invariant_failures.extend(failures)

    def sampler(self):
        while not self.stop_sampler.is_set():
            try:
                self.sample(self.overview())
            except Exception as error:
                with self.lock:
                    self.sample_errors += 1
                    if isinstance(error, (KeyError, TypeError)):
                        self.invariant_failures.append({"invalid_status_contract": str(error)})
            self.stop_sampler.wait(1)

    def assert_invariants(self):
        with self.lock:
            if self.invariant_failures:
                raise AssertionError(f"observed invariant failure: {self.invariant_failures[0]}")

    def action(self, service, action):
        assert service in SERVICES and action in ("stop", "start", "restart")
        response = self.request("/api/actions", {"service": service, "action": action}, timeout=12)
        if response["status"] != 200:
            raise RuntimeError(f"{action} {service} failed: {response}")

    def config(self, meter_count, demand_factor=1.0):
        response = self.request("/api/meters/config", {"meter_count": meter_count,
                                                     "demand_factor": demand_factor})
        if response["status"] != 200:
            raise RuntimeError(f"meter config failed: {response}")

    def grant(self, node_id, payload):
        assert node_id in COORDINATORS
        response = self.request(f"/nodes/{node_id}/api/grants", payload)
        value = response["data"]
        accepted = value.get("accepted")
        response["accepted"] = accepted if response["status"] == 200 and isinstance(accepted, bool) else None
        if response["accepted"] is True:
            lease = value.get("lease", {})
            if (value.get("request_id") != payload["request_id"]
                    or lease.get("session_id") != payload["session_id"]
                    or lease.get("building_id") != payload["building_id"]
                    or lease.get("amps", 0) < payload["amps"] or lease.get("version", 0) <= 0):
                raise AssertionError(f"accepted response identity/budget mismatch: {response}")
        return response

    def payload(self, building, amps=1, session=None):
        return {"request_id": str(uuid.uuid4()), "building_id": f"eval-{self.run_id}-{building}",
                "session_id": session or str(uuid.uuid4()), "amps": amps}

    def sql(self, query):
        command = ["docker", "compose", "--project-directory", str(self.project_dir), "exec", "-T",
                   "postgres", "psql", "-U", "ishtirak", "-d", "ishtirak", "-At", "-v", "ON_ERROR_STOP=1", "-c", query]
        result = subprocess.run(command, cwd=self.project_dir, text=True, capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError(f"SQL probe failed: {result.stderr[-500:]}")
        return int(result.stdout.strip())

    @staticmethod
    def totals(overview):
        return {"meters": sum(b["data"].get("meter_count", 0) for b in overview["buildings"] if b.get("online")),
                "readings": sum(b["data"].get("readings_total", 0) for b in overview["buildings"] if b.get("online")),
                "pending": sum(b["data"].get("pending_readings", 0) for b in overview["buildings"] if b.get("online")),
                "served": sum(b["data"].get("served_amps", 0) for b in overview["buildings"] if b.get("online"))}

    def phase(self, name, function):
        print(f"[{name}] running", flush=True)
        started = time.monotonic()
        try:
            result = function()
            self.assert_invariants()
            self.report["phases"][name] = {"passed": True, "seconds": round(time.monotonic() - started, 3), **(result or {})}
            print(f"[{name}] PASS ({time.monotonic() - started:.1f}s)", flush=True)
        except Exception as error:
            self.report["phases"][name] = {"passed": False, "seconds": round(time.monotonic() - started, 3), "error": str(error)}
            raise

    def readiness(self):
        def ready():
            overview = self.overview()
            return overview if (self.leader_in(overview) and len(overview["nodes"]) == 3
                                and all(n.get("online") for n in overview["nodes"])
                                and all(b.get("online") for b in overview["buildings"])
                                and overview.get("meters", {}).get("online")) else None
        overview = self.wait("all project components", ready, 120)
        if not overview.get("demo_enabled"):
            raise AssertionError("owned demo controls are disabled")
        if {node["data"].get("capacity_amps") for node in overview["nodes"]} != {120}:
            raise AssertionError("this experiment requires all three coordinators configured for 120 A")
        self.original_config = {k: overview["meters"]["data"][k] for k in ("meter_count", "demand_factor")}
        self.config(50)
        self.wait("real MQTT readings", lambda: self.totals(self.overview())["meters"] == 50, 30)
        baseline = self.totals(self.overview())["readings"]
        self.wait("growing real reading counter", lambda: self.totals(self.overview())["readings"] > baseline, 10)
        durable = self.sql("SELECT count(*) FROM readings")
        if durable <= 0:
            raise AssertionError("MQTT readings have not reached PostgreSQL")
        return {"leader": self.leader()["id"], "durable_readings": durable}

    def safe_start(self, service):
        """Best-effort restart after a failed trial; run()'s finally still verifies restoration."""
        try:
            self.action(service, "start")
        except Exception as error:
            print(f"WARN: could not restart {service} after failed trial: {error}", file=sys.stderr, flush=True)

    def repeat(self, name, trial, key, count=SAFETY_TRIALS):
        """Run trial() count times; headline = median trial by `key`; all trials recorded."""
        trials = []
        for index in range(1, count + 1):
            print(f"[{name}] trial {index}/{count}", flush=True)
            trials.append({"trial": index, **trial()})
        values = [t[key] for t in trials]
        middle = median_index(values)
        headline = {k: v for k, v in trials[middle].items() if k != "trial"}
        return {**headline, "trials": trials, "summary": {key: summarize(values)},
                "headline_basis": f"top-level fields are from the median trial by {key} "
                                  f"(trial {trials[middle]['trial']} of {count}); see trials and summary"}

    def gateway_crash(self):
        return self.repeat("gateway_crash_and_reclamation", self.gateway_crash_trial, "reclaim_seconds")

    def gateway_crash_trial(self):
        # Crash whichever real building currently holds a lease: allocation between buildings is
        # first-come (no fairness guarantee), so the holder cannot be assumed to be a fixed building.
        def held_lease():
            leases = self.leader()["data"]["leases"]
            return next((l for l in leases if l["building_id"] in BUILDINGS and l["amps"] > 0), None)
        previous = self.wait("a building capacity lease", held_lease, 25)
        building = previous["building_id"]
        service = "gateway-" + building.replace("_", "-")
        self.action(service, "stop")
        try:
            started = time.monotonic()
            self.wait("crashed gateway lease reclamation", lambda: not any(
                l["building_id"] == building for l in self.leader()["data"]["leases"]), 35)
            elapsed = time.monotonic() - started
        except BaseException:
            self.safe_start(service)
            raise
        self.action(service, "start")
        self.wait("restarted gateway's fresh readings", lambda: any(
            b.get("online") and b["id"] == building and b["data"]["meter_count"] > 0
            and b["data"]["session_id"] != previous["session_id"] for b in self.overview()["buildings"]), 25)
        return {"building": building, "reclaim_seconds": round(elapsed, 3), "previous_amps": previous["amps"],
                "fresh_session_verified": True}

    def failover(self):
        return self.repeat("leader_failure", self.failover_trial, "majority_grant_seconds")

    def failover_trial(self):
        old = self.leader()["id"]
        self.action(old, "stop")
        try:
            started = time.monotonic()
            node = self.wait("replacement leader", lambda: (lambda leader: leader if leader and leader["id"] != old else None)(
                self.leader_in(self.overview())), 45)
            # A fresh probe building per trial: a previous trial's lease is still held for 12 s and the
            # ledger correctly refuses a different session on a reserved building.
            request = self.payload(f"failover-{uuid.uuid4().hex[:8]}")
            result = self.grant(node["id"], request)
            if result["accepted"] is not True:
                raise AssertionError(f"replacement majority did not accept probe: {result}")
            elapsed = time.monotonic() - started
        except BaseException:
            self.safe_start(old)
            raise
        self.action(old, "start")
        self.wait("three coordinators restored", lambda: all(n.get("online") for n in self.overview()["nodes"]), 30)
        self.leader(45)  # one leader with quorum again before the next trial stops it
        return {"previous_leader": old, "replacement_leader": node["id"], "majority_grant_seconds": round(elapsed, 3)}

    def majority_loss(self):
        survivor = self.leader()["id"]
        stopped = [node for node in COORDINATORS if node != survivor]
        for node in stopped:
            self.action(node, "stop")
        started = time.monotonic()
        outcomes = []
        for index in range(3):
            response = self.grant(survivor, self.payload(f"no-majority-{index}"))
            if response["accepted"] is True:
                raise AssertionError("new grant was accepted without a majority")
            outcomes.append({"status": response["status"], "accepted": response["accepted"], "reason": response["data"].get("reason", response["data"].get("error"))})
        # Existing grants may serve briefly; all local safe leases must then expire.
        while time.monotonic() - started < 13:
            self.assert_invariants()
            self.stop_sampler.wait(.5)
        overview = self.overview()
        if self.totals(overview)["served"] != 0:
            raise AssertionError("gateway still served after majority-loss safe deadlines")
        for node in stopped:
            self.action(node, "start")
        self.leader(45)
        self.wait("service recovers after majority restoration", lambda: self.totals(self.overview())["served"] > 0, 35)
        return {"survivor": survivor, "new_grant_attempts": outcomes, "served_after_13s": 0}

    def postgres_outage(self):
        before = self.sql("SELECT count(*) FROM audit_events")
        readings_before = self.sql("SELECT count(*) FROM readings")
        self.action("postgres", "stop")
        self.wait("leader reports database outage", lambda: not self.leader()["data"].get("postgres_connected", True), 20)
        request = self.payload("sql-outage")
        response = self.grant(self.leader()["id"], request)
        if response["accepted"] is not True:
            raise AssertionError(f"database outage blocked authoritative grant: {response}")
        self.wait("gateway SQL backlog", lambda: self.totals(self.overview())["pending"] > 0, 15)
        if self.totals(self.overview())["served"] <= 0:
            raise AssertionError("database outage interrupted all leased service")
        pending = self.totals(self.overview())["pending"]
        self.action("postgres", "start")
        request_id = request["request_id"]  # Internally generated UUID; no user SQL interpolation.
        self.wait("exact outage grant audit catch-up", lambda: self.sql(
            "SELECT count(*) FROM audit_events WHERE payload->>'request_id' = '" + request_id + "'") == 1, 45, 1)
        after = self.sql("SELECT count(*) FROM audit_events")
        if after <= before:
            raise AssertionError("audit table did not advance after recovery")
        self.wait("buffered readings drain after recovery", lambda: self.totals(self.overview())["pending"] < pending, 30)
        readings_after = self.sql("SELECT count(*) FROM readings")
        if readings_after <= readings_before:
            raise AssertionError("readings did not reach PostgreSQL after recovery")
        return {"grant_accepted_without_postgres": True, "audit_rows_before": before,
                "audit_rows_after": after, "outage_request_durable": True,
                "durable_readings_delta": readings_after - readings_before, "observed_pending_during_outage": pending}

    def capacity_stress(self):
        for service in (*GATEWAYS, "meters"):
            self.action(service, "stop")
        self.wait("all existing capacity reclaimed", lambda: self.leader()["data"]["granted_amps"] == 0, 35)
        node = self.leader()
        payloads = [self.payload(f"stress-{i}", 7) for i in range(40)]
        barrier = threading.Barrier(40)
        def submit(payload):
            barrier.wait(timeout=10)
            return self.grant(node["id"], payload)
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=40) as workers:
            rows = list(workers.map(submit, payloads))
        elapsed = time.monotonic() - started
        if elapsed >= 10:
            raise AssertionError("capacity fanout exceeded safe experiment window; historical accepts may have expired")
        if any(row["accepted"] is None for row in rows):
            raise AssertionError("capacity fanout had transport/HTTP errors")
        accepted = [row for row in rows if row["accepted"] is True]
        granted = sum(row["data"]["lease"]["amps"] for row in accepted)
        capacity = node["data"]["capacity_amps"]
        if len(accepted) != capacity // 7 or granted > capacity:
            raise AssertionError(f"capacity admission result invalid: accepted={len(accepted)}, granted={granted}, capacity={capacity}")
        if any(row["data"].get("reason") != "capacity_exhausted" for row in rows if row["accepted"] is False):
            raise AssertionError("stress request was rejected for a reason other than exhausted capacity")
        snapshot = self.leader()["data"]
        if snapshot["granted_amps"] != granted:
            raise AssertionError("accepted stress allocations do not match authoritative committed total")
        index = next(i for i, row in enumerate(rows) if row["accepted"] is True)
        duplicate = self.grant(node["id"], payloads[index])
        if duplicate["accepted"] is not True or duplicate["data"]["lease"] != rows[index]["data"]["lease"]:
            raise AssertionError("duplicate request changed committed lease")
        conflict = self.grant(node["id"], {**payloads[index], "amps": 8})
        if conflict["accepted"] is True or (conflict["status"] != 409 and conflict["data"].get("reason") != "request_id_conflict"):
            raise AssertionError(f"conflicting request-ID reuse not explicitly rejected: {conflict}")
        self.wait("stress allocations reclaimed", lambda: self.leader()["data"]["granted_amps"] == 0, 35)
        for service in (*GATEWAYS, "meters"):
            self.action(service, "start")
        self.wait("MQTT gateways restored", lambda: self.totals(self.overview())["meters"] == 50, 30)
        return {"concurrent_requests": 40, "requested_amps_each": 7, "accepted": len(accepted),
                "rejected": 40 - len(accepted), "committed_amps": granted, "capacity_amps": capacity,
                "fanout_seconds": round(elapsed, 3), "duplicate_preserved_lease": True, "conflict_rejected": True}

    def pause(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.assert_invariants()
            self.stop_sampler.wait(min(.5, max(0, end - time.monotonic())))

    def prepare_load(self, meter_count):
        self.config(meter_count)
        self.pause(10)
        self.wait(f"{meter_count} real meters observed", lambda: self.totals(self.overview())["meters"] == meter_count, 15)

    def decisions(self, node, building, workers, count=REQUESTS_PER_TRIAL):
        """Fire `count` grant decisions from `workers` threads; returns (rows, elapsed_seconds)."""
        session = str(uuid.uuid4())
        payloads = [self.payload(building, session=session) for _ in range(count)]
        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            rows = list(pool.map(lambda payload: self.grant(node, payload), payloads))
        return rows, time.perf_counter() - started

    @staticmethod
    def flat_latency(summary):
        """Flat p50/p95/throughput of a latency_summary for per-trial summaries."""
        return {"p50_ms": summary["all_decisions"]["p50_ms"], "p95_ms": summary["all_decisions"]["p95_ms"],
                "decisions_per_second": summary["decision_requests_per_second"]}

    def load(self, meter_count):
        self.prepare_load(meter_count)
        trial_rows, summaries, trials = [], [], []
        for index in range(1, LOAD_TRIALS + 1):
            node = self.leader()["id"]
            rows, elapsed = self.decisions(node, f"load-{meter_count}-t{index}", LOAD_WORKERS)
            if any(row["accepted"] is None for row in rows):
                raise AssertionError(f"{meter_count}-meter benchmark trial {index} includes transport/HTTP errors")
            summary = latency_summary(rows, elapsed)
            trial_rows.append(rows)
            summaries.append(summary)
            trials.append({"trial": index, **self.flat_latency(summary), **summary})
        middle = median_index([t["p50_ms"] for t in trials])
        rows, headline = trial_rows[middle], summaries[middle]  # raw responses only for the headline trial
        durable_before = self.sql("SELECT count(*) FROM readings")
        observed = time.monotonic()
        before = self.totals(self.overview())
        while time.monotonic() - observed < 5:
            self.assert_invariants()
            self.stop_sampler.wait(.5)
        after = self.totals(self.overview())
        observation_seconds = time.monotonic() - observed
        durable_after = self.sql("SELECT count(*) FROM readings")
        delta = after["readings"] - before["readings"]
        if delta <= 0 or durable_after <= durable_before:
            raise AssertionError("load experiment did not observe growing MQTT and SQL reading counters")
        return {"meter_count": meter_count, "demand_factor": 1.0, "settle_seconds": 10,
                "headline_basis": f"top-level latency fields are from the median trial by p50_ms "
                                  f"(trial {trials[middle]['trial']} of {LOAD_TRIALS}); see trials and summary",
                "trials": trials,
                "summary": {key: summarize([t[key] for t in trials])
                            for key in ("p50_ms", "p95_ms", "decisions_per_second")},
                **headline, "gateway_meter_count": after["meters"],
                "reading_observation_seconds": round(observation_seconds, 3),
                "gateway_readings_delta": delta, "gateway_readings_per_second": round(delta / observation_seconds, 3),
                "sql_readings_delta": durable_after - durable_before,
                "served_amps_at_end": after["served"],
                "responses": [{"accepted": r["accepted"], "status": r["status"],
                               "latency_ms": r["latency_ms"], "reason": r["data"].get("reason")} for r in rows]}

    def concurrency_sweep(self):
        """Same 200-request decision method at 50 meters with 1/4/16/64 concurrent clients.

        Unlike load(), transport errors and non-200s do not abort: they are recorded
        separately as unknown outcomes. Identity/budget mismatches still raise.
        """
        self.prepare_load(50)
        levels = []
        for workers in SWEEP_WORKERS:
            node = self.leader()["id"]
            rows, elapsed = self.decisions(node, f"sweep-{workers}", workers)
            summary = latency_summary(rows, elapsed, workers)
            levels.append({"workers": workers, **self.flat_latency(summary), **summary,
                           "non_200": non_200_summary(rows),
                           "rejection_reasons": self.reason_counts(rows)})
        return {"meter_count": 50, "requests_per_level": REQUESTS_PER_TRIAL, "settle_seconds": 10,
                "worker_levels": list(SWEEP_WORKERS), "levels": levels,
                "note": "one run per level; non-200 responses are unknown outcomes, not rejections"}

    @staticmethod
    def reason_counts(rows):
        counts = {}
        for row in rows:
            if row.get("accepted") is False:
                reason = str(row["data"].get("reason"))
                counts[reason] = counts.get(reason, 0) + 1
        return counts

    def served_and_demand(self):
        """(started_at_perf_counter_after_response, served_amps, demand_amps) from one overview."""
        overview = self.overview()
        now = time.perf_counter()
        online = [b["data"] for b in overview["buildings"] if b.get("online")]
        return (now, sum(b.get("served_amps", 0) for b in online),
                sum(b.get("demand_amps", 0) for b in online))

    def level(self, factor):
        """Set 50 meters at `factor`, let it settle, return the median served/demand of 5 polls."""
        self.config(50, factor)
        self.pause(E2E_SETTLE_SECONDS)
        reads = []
        for _ in range(5):
            reads.append(self.served_and_demand())
            self.stop_sampler.wait(.2)
        return (statistics.median(r[1] for r in reads), statistics.median(r[2] for r in reads))

    def end_to_end_latency(self):
        """demand_factor step LOW -> HIGH, then poll the overview until gateway demand moves.

        Clock starts just before the config request is sent and stops when the overview
        response showing the change is received, so the figure includes the control
        request, meter publish, MQTT, gateway and dashboard refresh, and is an upper
        bound at E2E_POLL_INTERVAL_SECONDS (+ one overview round trip) resolution.
        """
        try:
            high_served, high_demand = self.level(E2E_HIGH_FACTOR)  # calibrate the target level
            samples, gaps = [], []
            for index in range(1, E2E_SAMPLES + 1):
                low_served, low_demand = self.level(E2E_LOW_FACTOR)
                # Gateway-observed demand is the primary signal: served amps are capped by the lease
                # budget, which a renewal never shrinks, so served can stay flat while demand moves.
                step = high_demand - low_demand
                if step < E2E_MIN_STEP_AMPS:
                    raise AssertionError(f"demand-factor step moved gateway demand by only {step:.3f} A "
                                         f"(low {low_demand}, high {high_demand}); cannot time it")
                threshold = max(E2E_MOVE_FRACTION * step, E2E_MOVE_FLOOR_AMPS)
                served_threshold = max(E2E_MOVE_FRACTION * (high_served - low_served), E2E_MOVE_FLOOR_AMPS)
                started, served_ms, demand_ms, polls, previous = time.perf_counter(), None, None, 0, None
                self.config(50, E2E_HIGH_FACTOR)
                while time.perf_counter() - started < E2E_TIMEOUT_SECONDS:
                    try:
                        at, served, demand = self.served_and_demand()
                    except RuntimeError:
                        self.stop_sampler.wait(E2E_POLL_INTERVAL_SECONDS)
                        continue
                    polls += 1
                    if previous is not None:
                        gaps.append((at - previous) * 1000)
                    previous = at
                    if served_ms is None and high_served - low_served >= E2E_MIN_STEP_AMPS \
                            and served - low_served > served_threshold:
                        served_ms = (at - started) * 1000
                    if demand - low_demand > threshold:
                        demand_ms = (at - started) * 1000
                        break
                    self.stop_sampler.wait(E2E_POLL_INTERVAL_SECONDS)
                if demand_ms is None:
                    raise AssertionError(f"gateway demand did not move within {E2E_TIMEOUT_SECONDS}s "
                                         f"(sample {index}, low {low_demand}, threshold {threshold})")
                samples.append({"sample": index, "baseline_demand_amps": round(low_demand, 3),
                                "demand_change_ms": round(demand_ms, 3),
                                "served_change_ms": None if served_ms is None else round(served_ms, 3),
                                "polls": polls, "move_threshold_amps": round(threshold, 3)})
        finally:
            try:
                self.config(50, 1.0)
            except Exception as error:
                print(f"WARN: could not reset demand factor: {error}", file=sys.stderr, flush=True)
        served_values = [s["served_change_ms"] for s in samples if s["served_change_ms"] is not None]
        return {"meter_count": 50, "low_demand_factor": E2E_LOW_FACTOR, "high_demand_factor": E2E_HIGH_FACTOR,
                "calibrated_high_demand_amps": round(high_demand, 3), "samples": samples,
                "summary": {"demand_change_ms": summarize([s["demand_change_ms"] for s in samples]),
                            "served_change_ms": summarize(served_values)},
                "poll_interval_seconds": E2E_POLL_INTERVAL_SECONDS,
                "max_observed_poll_gap_ms": round(max(gaps), 3) if gaps else None,
                "measurement": "time from sending the demand_factor config request to receiving an "
                               "/api/overview response whose total gateway-observed demand moved by more than "
                               f"max({E2E_MOVE_FRACTION:.0%} of the low->high step, {E2E_MOVE_FLOOR_AMPS} A); "
                               "served_change_ms is recorded only when served amps also moved by then, because "
                               "served is capped by the lease budget (renewals never shrink a reservation)",
                "resolution_note": f"polled every {E2E_POLL_INTERVAL_SECONDS}s; each figure is an upper "
                                   "bound at that resolution plus one overview round trip and any dashboard "
                                   "caching (see max_observed_poll_gap_ms)"}

    def allocation_recovery(self):
        """Spike demand (200 meters), return to 50 meters, and time how long until every real building again
        holds a budget that tracks its demand. With first-come allocation and reservations that never shrank,
        a building could keep its spike reservation indefinitely; with lease tiers it decays once the older,
        larger grants can no longer be in use (one 12 s hold after the last large grant)."""
        def reserved():
            leases = self.leader()["data"]["leases"]
            return {l["building_id"]: l["amps"] for l in leases if l["building_id"] in BUILDINGS}

        def balanced():
            overview = self.overview()
            held = reserved()
            rows = [b for b in overview["buildings"] if b.get("online")]
            return len(rows) == len(BUILDINGS) and all(
                b["data"]["state"] == "active" and 1 <= held.get(b["id"], 0)
                <= math.ceil(RECOVERY_RATIO * b["data"]["demand_amps"]) + RECOVERY_SLACK_AMPS for b in rows)
        try:
            # Start quiet so reservations are small, then jump to 200 meters: the first building to ask takes
            # most of the free capacity (first-come) and the others are refused until demand falls again.
            self.config(RECOVERY_QUIET_METERS)
            self.pause(RECOVERY_QUIET_SECONDS)
            self.config(200)
            end, peak, starved = time.monotonic() + RECOVERY_SPIKE_SECONDS, 0, 0
            while time.monotonic() < end:
                held = reserved()
                peak = max([peak, *held.values()])
                starved = max(starved, len(BUILDINGS) - sum(1 for amps in held.values() if amps > 0))
                self.stop_sampler.wait(.5)
            self.config(50)
            started = time.monotonic()
            self.wait("every building to hold a budget that tracks its demand", balanced, RECOVERY_TIMEOUT_SECONDS, 1)
            seconds = time.monotonic() - started
            final = reserved()
        finally:
            try:
                self.config(50, 1.0)
            except Exception as error:
                print(f"WARN: could not reset meters after allocation recovery: {error}", file=sys.stderr, flush=True)
        return {"quiet_meters": RECOVERY_QUIET_METERS, "spike_meters": 200, "peak_reserved_amps_per_building": peak,
                "buildings_without_a_reservation_during_spike": starved,
                "spike_reproduced": peak >= RECOVERY_SPIKE_MIN_AMPS, "recovery_seconds": round(seconds, 3),
                "reserved_after_recovery": final,
                "criterion": f"every building 'active' with 1 <= reserved <= ceil({RECOVERY_RATIO} x demand) + "
                             f"{RECOVERY_SLACK_AMPS} A; timeout {RECOVERY_TIMEOUT_SECONDS}s"}

    def restore(self):
        # Start only the named, project-ownership-checked services. Never delete data.
        for service in SERVICES:
            try:
                self.action(service, "start")
                self.report["restoration"].append({"service": service, "started": True})
            except Exception as error:
                self.report["restoration"].append({"service": service, "started": False, "error": str(error)})
        try:
            self.config(**self.original_config)
            self.report["meter_config_restored"] = self.original_config
        except Exception as error:
            self.report["meter_config_restore_error"] = str(error)

    def run(self):
        worker = threading.Thread(target=self.sampler, daemon=True)
        worker.start()
        try:
            self.phase("readiness_and_real_mqtt", self.readiness)
            self.phase("gateway_crash_and_reclamation", self.gateway_crash)
            self.phase("leader_failure", self.failover)
            self.phase("majority_loss", self.majority_loss)
            self.phase("postgres_outage_and_audit_catchup", self.postgres_outage)
            self.phase("capacity_stress_and_idempotency", self.capacity_stress)
            for count in (10, 50, 200):
                self.phase(f"load_{count}_meters", lambda count=count: self.load(count))
            self.phase("concurrency_sweep", self.concurrency_sweep)
            self.phase("end_to_end_latency", self.end_to_end_latency)
            self.phase("allocation_recovery_after_spike", self.allocation_recovery)
            self.assert_invariants()
            if self.node_samples <= 0:
                raise AssertionError("no actual node state was sampled")
            self.report["passed"] = True
        except Exception as error:
            self.report["error"] = str(error)
            print(f"FAIL: {error}", file=sys.stderr, flush=True)
        finally:
            self.restore()
            self.stop_sampler.set()
            worker.join(timeout=7)
            with self.lock:
                self.report["invariant_sampling"] = {"overview_samples": self.samples,
                    "node_samples": self.node_samples, "transport_errors": self.sample_errors,
                    "max_observed_granted_amps": self.max_granted, "violations": self.invariant_failures}
            if self.invariant_failures or any(not r["started"] for r in self.report["restoration"]) or "meter_config_restore_error" in self.report:
                self.report["passed"] = False
            self.report["finished_at"] = datetime.now(timezone.utc).isoformat()
            self.output.parent.mkdir(parents=True, exist_ok=True)
            self.output.write_text(json.dumps(self.report, indent=2) + "\n", encoding="utf-8")
            print(f"Report: {self.output} | {'PASS' if self.report['passed'] else 'FAIL'}", flush=True)
        return 0 if self.report["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8088")
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("artifacts/evaluation.json"))
    arguments = parser.parse_args()
    return Evaluation(arguments.base_url, arguments.project_dir.resolve(), arguments.output.resolve()).run()


if __name__ == "__main__":
    sys.exit(main())
