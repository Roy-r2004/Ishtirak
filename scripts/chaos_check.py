#!/usr/bin/env python3
"""Randomized fault checker for the running Ishtirak Compose prototype.

Run from the project root: python scripts/chaos_check.py --seed 1 --duration 90
Preview the deterministic fault schedule without any network access:
    python scripts/chaos_check.py --seed 1 --duration 90 --dry-run

While a seeded schedule of single-service stop/start faults runs (coordinators,
gateways, PostgreSQL, plus one explicit majority-loss window), worker threads
send randomized grants, renewals, replayed duplicates and one conflicting-payload
replay to random coordinators using synthetic chaos-* building and session ids.
A sampler records granted totals from /api/overview. At the end every service is
restarted, the cluster is awaited, coordinators must agree on one applied index,
and the recorded history is checked. The report is artifacts/chaos-check.json.

Limits: sampling is not proof (transients between polls are invisible), and
unknown outcomes (HTTP 503, timeouts, transport errors) are not rejections.
Uses only the standard library. Talks to the dashboard proxy and its
label-checked /api/actions controller only; never removes containers or volumes.
"""

from __future__ import annotations

import argparse
from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid


COORDINATORS = ("coordinator1", "coordinator2", "coordinator3")
GATEWAYS = ("gateway-hamra", "gateway-mar-mikhael", "gateway-achrafieh")
FAULTABLE = ("postgres", *COORDINATORS, *GATEWAYS)
CAPACITY = 120
MAJORITY_WINDOW_SECONDS = 16
LIMITS = [
    "Sampling is not proof: the sampler polls /api/overview about once a second and cannot see transients between polls.",
    "Unknown outcomes are not rejections: HTTP 503, timeouts and transport errors may have committed and are counted separately.",
    "Synthetic chaos-* buildings share the 120 A capacity with the real gateways, so many rejections are expected capacity_exhausted decisions.",
    "Convergence is a point-in-time comparison of applied indexes after healing; gateways keep renewing, so it is retried until the values agree.",
    "No gateway disk persistence, database failover or physical breaker is evaluated.",
]


# ---------------------------------------------------------------- pure logic

def check_history(samples, grants, capacity):
    """Check recorded observations; unknown outcomes (status != 200) are ignored."""
    violations, max_granted = [], 0
    for sample in samples:
        granted = sample["granted"]
        max_granted = max(max_granted, granted)
        bound = min(capacity, sample["capacity"]) if "capacity" in sample else capacity
        if granted > bound:
            violations.append(f"sample t={sample.get('t')}: granted {granted} A exceeds capacity {bound} A")
        elif granted < 0:
            violations.append(f"sample t={sample.get('t')}: negative granted total {granted} A")
        if "lease_sum" in sample and sample["lease_sum"] != granted:
            violations.append(f"sample t={sample.get('t')}: lease sum {sample['lease_sum']} A != granted {granted} A")

    by_request, ids_by_version = {}, {}
    for row in grants:
        accepted = row.get("accepted")
        if row.get("status") != 200 or not isinstance(accepted, bool):
            continue
        request_id, version = row.get("request_id"), row.get("version")
        if accepted:
            if not isinstance(version, int) or isinstance(version, bool) or version <= 0:
                violations.append(f"request {request_id}: accepted without a positive committed version ({version!r})")
            else:
                ids_by_version.setdefault(version, set()).add(request_id)
        by_request.setdefault(request_id, []).append((accepted, version if accepted else None, row.get("payload_hash")))

    duplicate_versions = sorted(v for v, ids in ids_by_version.items() if len(ids) > 1)
    for version in duplicate_versions:
        violations.append(f"committed version {version} granted to {len(ids_by_version[version])} different requests")
    for request_id, rows in by_request.items():
        by_hash = {}
        for accepted, version, payload_hash in rows:
            by_hash.setdefault(payload_hash, set()).add((accepted, version))
        for payload_hash, outcomes in by_hash.items():
            if len(outcomes) > 1:
                violations.append(f"request {request_id}: replay returned different outcomes {sorted(map(str, outcomes))}")
        if len({h for h, o in by_hash.items() if any(a for a, _ in o)}) > 1:
            violations.append(f"request {request_id}: conflicting payload accepted under the same request_id")
    return {"violations": violations, "max_granted": max_granted, "duplicate_versions": duplicate_versions,
            "samples": len(samples), "grants": len(grants)}


def classify_response(status, data):
    """Map an HTTP reply to a request outcome. 503, timeouts and transport errors are unknown."""
    if status == 307:
        return "redirect"
    if status == 200:
        accepted = data.get("accepted") if isinstance(data, dict) else None
        if accepted is True:
            return "accepted"
        if accepted is False:
            return "rejected"
        return "unknown"
    if status == 409:
        return "rejected"
    if 400 <= status < 500:
        return "invalid"
    return "unknown"


def count_outcomes(rows):
    outcomes = Counter(row["outcome"] for row in rows)
    return {"requests": len(rows), "accepted": outcomes["accepted"], "rejected": outcomes["rejected"],
            "unknown_outcome": outcomes["unknown"], "redirect_not_processed": outcomes["redirect"],
            "invalid": outcomes["invalid"]}


def build_schedule(seed, duration):
    """Deterministic single-service faults; one explicit majority-loss window when duration >= 60."""
    rng = random.Random(seed)
    events, segments = [], []
    if duration >= 60:
        start = rng.randint(int(duration * 0.35), int(duration * 0.55))
        first, second = rng.sample(COORDINATORS, 2)
        end = start + MAJORITY_WINDOW_SECONDS
        for at, service, action in ((start, first, "stop"), (start + 1, second, "stop"),
                                    (end, first, "start"), (end + 1, second, "start")):
            events.append({"at": at, "service": service, "action": action, "window": "majority_loss"})
        segments = [(4, start - 3), (end + 5, duration - 2)]
    else:
        segments = [(3, duration - 2)]
    for low, high in segments:
        at = low + rng.randint(0, 3)
        while True:
            kind = rng.choices(("coordinator", "gateway", "postgres"), weights=(4, 4, 2))[0]
            service = rng.choice({"coordinator": COORDINATORS, "gateway": GATEWAYS, "postgres": ("postgres",)}[kind])
            dwell = rng.randint(5, 10)
            if at + dwell > high:
                break
            events.append({"at": at, "service": service, "action": "stop"})
            events.append({"at": at + dwell, "service": service, "action": "start"})
            at += dwell + rng.randint(3, 7)
    return sorted(events, key=lambda event: event["at"])


# ------------------------------------------------------------------- runner

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_json(base, path, payload=None, timeout=6):
    """Same conventions as scripts/evaluate.py: no proxy, never follow redirects."""
    started = time.perf_counter()
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    try:
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
    return {"status": status, "data": result, "latency_ms": round((time.perf_counter() - started) * 1000, 3)}


def payload_hash(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


class Chaos:
    def __init__(self, base, seed, duration, workers, output):
        self.base, self.seed, self.duration, self.workers = base.rstrip("/"), seed, duration, workers
        self.output = output
        self.run_id = uuid.uuid4().hex[:8]
        self.schedule = build_schedule(seed, duration)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.t0 = time.monotonic()
        self.samples, self.status_samples, self.rows = [], [], []
        self.sample_errors = 0
        self.runner_violations = []
        self.actions = []
        self.restoration = []
        self.recent = deque(maxlen=300)
        self.accepted_payloads = deque(maxlen=100)
        self.leader_hint = None
        self.conflict = {"attempted": False, "observed": False, "outcome": None, "reason": None}
        self.convergence = {"converged": False}
        self.errors = []
        self.passed = False
        self.stop_sampler = threading.Event()

    def now(self):
        return round(time.monotonic() - self.t0, 2)

    # ---- observation
    def overview(self):
        response = http_json(self.base, "/api/overview", timeout=5)
        if response["status"] != 200 or "nodes" not in response["data"]:
            raise RuntimeError(f"overview unavailable: status {response['status']}")
        return response["data"]

    @staticmethod
    def leader_in(overview):
        leaders = [n for n in overview.get("nodes", []) if n.get("online")
                   and n.get("data", {}).get("state") == "Leader" and n["data"].get("quorum")]
        return leaders[0] if len(leaders) == 1 else None

    def sample_once(self):
        overview = self.overview()
        at, rows = self.now(), []
        for node in overview.get("nodes", []):
            if not node.get("online"):
                continue
            state = node["data"]
            leases = state.get("leases", [])
            if isinstance(leases, dict):
                leases = list(leases.values())
            rows.append({"t": at, "node": node["id"], "granted": state["granted_amps"],
                         "capacity": state["capacity_amps"], "lease_sum": sum(lease["amps"] for lease in leases)})
        leader = self.leader_in(overview)
        status = {"t": at, "coordinators_up": sum(1 for n in overview["nodes"] if n.get("online")),
                  "gateways_up": sum(1 for b in overview.get("buildings", []) if b.get("online")),
                  "leader": leader["id"] if leader else None}
        with self.lock:
            self.samples.extend(rows)
            self.status_samples.append(status)
            self.leader_hint = status["leader"] or self.leader_hint

    def sampler(self):
        while not self.stop_sampler.is_set():
            try:
                self.sample_once()
            except Exception:
                with self.lock:
                    self.sample_errors += 1
            self.stop_sampler.wait(1)

    # ---- faults
    def act(self, service, action):
        assert service in FAULTABLE and action in ("stop", "start")
        response = http_json(self.base, "/api/actions", {"service": service, "action": action}, timeout=15)
        return response["status"] == 200, response["status"]

    def scheduler(self):
        for event in self.schedule:
            if self.stop.wait(max(0.0, self.t0 + event["at"] - time.monotonic())):
                return
            ok, status = self.act(event["service"], event["action"])
            with self.lock:
                self.actions.append({"at": event["at"], "ran_at": self.now(), "service": event["service"],
                                     "action": event["action"], "ok": ok, "http_status": status})
            print(f"[{self.now():6.1f}s] {event['action']:5} {event['service']} -> {'ok' if ok else 'HTTP ' + str(status)}", flush=True)

    # ---- load
    def send(self, payload, rng):
        """Try a coordinator; follow a 307 by trying the others (never the internal redirect URL)."""
        with self.lock:
            hint = self.leader_hint
        order = list(COORDINATORS)
        rng.shuffle(order)
        if hint in order and rng.random() < 0.7:
            order.remove(hint)
            order.insert(0, hint)
        response, node = None, None
        for node in order:
            response = http_json(self.base, f"/nodes/{node}/api/grants", payload, timeout=6)
            if response["status"] != 307:
                break
        return response, node

    def record(self, payload, kind, response, node):
        data, status = response["data"], response["status"]
        outcome = classify_response(status, data)
        accepted = (outcome == "accepted") if status == 200 and outcome in ("accepted", "rejected") else None
        lease = data.get("lease") if isinstance(data.get("lease"), dict) else {}
        row = {"t": self.now(), "kind": kind, "node": node, "request_id": payload["request_id"],
               "building_id": payload["building_id"], "amps": payload["amps"], "status": status,
               "outcome": outcome, "accepted": accepted, "version": lease.get("version") if accepted else None,
               "reason": data.get("reason") if outcome == "rejected" else None,
               "payload_hash": payload_hash(payload), "latency_ms": response["latency_ms"]}
        with self.lock:
            self.rows.append(row)
            if accepted is True:
                if (data.get("request_id") != payload["request_id"] or lease.get("session_id") != payload["session_id"]
                        or lease.get("building_id") != payload["building_id"]
                        or lease.get("amps", 0) < payload["amps"]):
                    self.runner_violations.append(f"accepted response identity/budget mismatch for {payload['request_id']}")
                if kind in ("new", "renew"):
                    self.accepted_payloads.append(payload)
        return row

    def worker(self, index):
        rng = random.Random(self.seed * 1000 + index)
        buildings = [{"id": f"chaos-{self.run_id}-w{index}-b{k}", "session": f"chaos-{self.run_id}-w{index}-s{k}"}
                     for k in range(4)]
        counter, pending_retry = 0, None
        while not self.stop.is_set() and self.now() < self.duration:
            roll = rng.random()
            with self.lock:
                recent = list(self.recent)
            if pending_retry is not None and roll < 0.5:
                payload, kind, pending_retry = pending_retry, "retry", None
            elif recent and roll < 0.25:
                payload, kind = rng.choice(recent), "duplicate"
            elif (index == 0 and not self.conflict["observed"] and self.conflict.get("tries", 0) < 6
                  and self.now() >= self.duration * 0.3 and self.accepted_payloads):
                with self.lock:
                    original = rng.choice(list(self.accepted_payloads))
                payload, kind = {**original, "amps": original["amps"] + 1}, "conflict"
            else:
                counter += 1
                building = rng.choice(buildings)
                payload = {"request_id": f"chaos-{self.run_id}-w{index}-{counter}", "building_id": building["id"],
                           "session_id": building["session"], "amps": rng.randint(1, 12)}
                kind = "new"
            response, node = self.send(payload, rng)
            row = self.record(payload, kind, response, node)
            if kind == "conflict":
                self.conflict.update(attempted=True, tries=self.conflict.get("tries", 0) + 1)
                if row["outcome"] in ("accepted", "rejected"):
                    self.conflict.update(observed=True, outcome=row["outcome"], reason=row["reason"])
            elif kind in ("new", "retry", "duplicate"):
                with self.lock:
                    if kind == "new":
                        self.recent.append(payload)
                if row["outcome"] in ("unknown", "redirect") and kind == "new":
                    pending_retry = payload
            self.stop.wait(rng.uniform(0.05, 0.4))

    # ---- healing and verification
    def heal(self):
        for service in FAULTABLE:
            ok = False
            for _ in range(3):
                try:
                    ok, _status = self.act(service, "start")
                except Exception:
                    ok = False
                if ok:
                    break
                time.sleep(1)
            self.restoration.append({"service": service, "started": ok})
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                overview = self.overview()
                nodes_up = sum(1 for n in overview["nodes"] if n.get("online"))
                gateways_up = sum(1 for b in overview.get("buildings", []) if b.get("online"))
                if nodes_up == 3 and gateways_up >= 3 and self.leader_in(overview):
                    return True
            except Exception:
                pass
            time.sleep(1)
        return False

    def converge(self, deadline_seconds=30):
        deadline, attempts, last = time.monotonic() + deadline_seconds, 0, {}
        while time.monotonic() < deadline:
            attempts += 1
            try:
                nodes = [n for n in self.overview()["nodes"] if n.get("online")]
                last = {n["id"]: n["data"].get("raft", {}).get("applied_index") for n in nodes}
                if len(nodes) == 3 and None not in last.values() and len(set(last.values())) == 1:
                    return {"converged": True, "attempts": attempts, "applied_index": last}
            except Exception as error:
                last = {"error": str(error)}
            time.sleep(0.3)
        return {"converged": False, "attempts": attempts, "last_applied_indexes": last}

    def run(self):
        threads = [threading.Thread(target=self.sampler, daemon=True)]
        threads += [threading.Thread(target=self.scheduler, daemon=True)]
        threads += [threading.Thread(target=self.worker, args=(i,), daemon=True) for i in range(self.workers)]
        started_at, interrupted, ready = datetime.now(timezone.utc).isoformat(), False, False
        try:
            overview = self.overview()
            if not overview.get("demo_enabled"):
                raise RuntimeError("owned demo controls are disabled; /api/actions would refuse")
            if len(overview["nodes"]) != 3 or not self.leader_in(overview):
                raise RuntimeError("cluster is not healthy (3 coordinators and a leader required) before the run")
            self.t0 = time.monotonic()
            for thread in threads:
                thread.start()
            self.stop.wait(self.duration)
        except KeyboardInterrupt:
            interrupted = True
            self.errors.append("interrupted by KeyboardInterrupt")
        except Exception as error:
            self.errors.append(str(error))
        finally:
            self.stop.set()
            for thread in threads[1:]:
                if thread.is_alive():
                    thread.join(timeout=20)
            try:
                ready = self.heal()
                if ready:
                    self.convergence = self.converge()
            except BaseException as error:  # restoration must not be skipped by a second interrupt
                self.errors.append(f"healing aborted: {error!r}")
            self.stop_sampler.set()
            if threads[0].is_alive():
                threads[0].join(timeout=7)
            self.write_report(started_at, interrupted, ready)
        return 0 if self.passed else 1

    def write_report(self, started_at, interrupted, ready):
        with self.lock:
            history = check_history(self.samples, self.rows, CAPACITY)
            counts = count_outcomes(self.rows)
            reasons = Counter(row["reason"] for row in self.rows if row["outcome"] == "rejected")
            failures = list(history["violations"]) + list(self.runner_violations) + list(self.errors)
            if self.conflict.get("outcome") == "accepted":
                failures.append("conflicting-payload replay was accepted")
            if any(not item["started"] for item in self.restoration) or not self.restoration:
                failures.append("failed restoration: not every service was restarted")
            if not ready:
                failures.append("cluster did not return to 3 coordinators, 3 gateways and a leader")
            if not self.convergence.get("converged"):
                failures.append("coordinators did not converge on one applied index after healing")
            if not self.samples:
                failures.append("no node state was sampled")
            self.passed = not failures
            report = {"seed": self.seed, "duration_seconds": self.duration, "workers": self.workers,
                      "run_id": self.run_id, "started_at": started_at,
                      "finished_at": datetime.now(timezone.utc).isoformat(), "base_url": self.base,
                      "result": "PASS" if self.passed else "FAIL", "failures": failures,
                      "interrupted": interrupted, "schedule": self.schedule, "actions_executed": self.actions,
                      "counts": {**counts, "rejection_reasons": dict(reasons)},
                      "conflict_replay": self.conflict, "history": history,
                      "sampling": {"node_samples": len(self.samples), "sample_errors": self.sample_errors,
                                   "coordinator_status": self.status_samples},
                      "restoration": self.restoration, "convergence": self.convergence, "limits": LIMITS}
        self.output.parent.mkdir(parents=True, exist_ok=True)
        with open(self.output, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(report, indent=2) + "\n")
        print(f"Report: {self.output} | {report['result']} | requests={counts['requests']} "
              f"accepted={counts['accepted']} rejected={counts['rejected']} unknown={counts['unknown_outcome']}", flush=True)
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr, flush=True)


def print_schedule(seed, duration):
    print(f"seed={seed} duration={duration}s (dry run: no network access)")
    for event in build_schedule(seed, duration):
        window = "  [majority-loss window]" if event.get("window") else ""
        print(f"+{event['at']:4d}s  {event['action']:5}  {event['service']}{window}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:8088")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--duration", type=int, default=90, help="seconds of faults and load (>= 10)")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--output", type=Path,
                        default=Path(__file__).resolve().parents[1] / "artifacts" / "chaos-check.json")
    parser.add_argument("--dry-run", action="store_true", help="print the schedule and exit; no network access")
    arguments = parser.parse_args()
    if arguments.duration < 10 or arguments.workers < 1:
        parser.error("--duration must be >= 10 and --workers >= 1")
    if arguments.dry_run:
        print_schedule(arguments.seed, arguments.duration)
        return 0
    return Chaos(arguments.base_url, arguments.seed, arguments.duration, arguments.workers,
                 arguments.output.resolve()).run()


if __name__ == "__main__":
    sys.exit(main())
