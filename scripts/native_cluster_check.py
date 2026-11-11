"""Fair-sharing check on three REAL coordinator processes, without Docker.

Starts the compiled coordinator three times on localhost (real Raft over TCP, real HTTP API, no database), then
plays the roles of the building gateways against it:
  1. the cluster forms, and `fair_share` is committed on its own once every peer reports support;
  2. the policy endpoint refuses a missing or wrong admin token;
  3. first_come lets one building hold 102 A while two others are starved (7 A and 4 A);
  4. after switching to fair_share the three buildings converge on the max-min shares (40/40/40) within a bound;
  5. a changed demand mix (10/100/100) converges on 10/55/55;
  6. the leader is killed under load: a new leader is elected, grants continue, the old node restarts and rejoins;
  7. every replica ends with the same leases, wants and applied index.
At every sample the granted total is checked against the capacity (120 A) on every live node.
Usage: python -I scripts/native_cluster_check.py --binary D:/path/coordinator.exe [--work D:/path/work]
The result is written to artifacts/native-cluster-check.json. Sampling is evidence, not a proof.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

NODES = ("coordinator1", "coordinator2", "coordinator3")
HTTP_PORT = {n: 18081 + i for i, n in enumerate(NODES)}
RAFT_PORT = {n: 19001 + i for i, n in enumerate(NODES)}
TOKEN = "native-check-token"
CAPACITY = 120
BUILDINGS = ("hamra", "mar_mikhael", "achrafieh")
ROOT = Path(__file__).resolve().parents[1]


def call(method, url, body=None, headers=None, timeout=5):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return 0, None


class Cluster:
    def __init__(self, binary, work):
        self.binary, self.work = binary, Path(work)
        self.procs = {}
        self.logs = {}

    def env(self, node):
        peers = ",".join(f"{n}=127.0.0.1:{RAFT_PORT[n]}" for n in NODES)
        http = ",".join(f"{n}=http://127.0.0.1:{HTTP_PORT[n]}" for n in NODES)
        return {**os.environ, "NODE_ID": node, "HTTP_ADDR": f"127.0.0.1:{HTTP_PORT[node]}", "RAFT_ADDR": f"127.0.0.1:{RAFT_PORT[node]}",
                "RAFT_BIND": f"127.0.0.1:{RAFT_PORT[node]}", "DATA_DIR": str(self.work / node), "CAPACITY_AMPS": str(CAPACITY),
                "LEASE_MS": "12000", "FAIR_SHARE": "true", "ADMIN_TOKEN": TOKEN, "PEERS": peers, "HTTP_PEERS": http,
                "BOOTSTRAP": "true" if node == NODES[0] else "false", "DATABASE_URL": ""}

    def start(self, node):
        (self.work / node).mkdir(parents=True, exist_ok=True)
        log = open(self.work / f"{node}.log", "ab")
        self.logs[node] = log
        self.procs[node] = subprocess.Popen([self.binary], env=self.env(node), stdout=log, stderr=log, cwd=str(self.work))

    def kill(self, node):
        proc = self.procs.get(node)
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=15)

    def alive(self, node):
        proc = self.procs.get(node)
        return bool(proc and proc.poll() is None)

    def stop_all(self):
        for node in NODES:
            self.kill(node)
        for log in self.logs.values():
            log.close()

    def status(self, node):
        code, body = call("GET", f"http://127.0.0.1:{HTTP_PORT[node]}/api/status", timeout=3)
        return body if code == 200 else None

    def leader(self):
        for node in NODES:
            st = self.status(node) if self.alive(node) else None
            if st and st.get("state") == "Leader" and st.get("quorum"):
                return node, st
        return None, None

    def leader_or_none(self):
        node, st = self.leader()
        return (node, st) if node else None

    def wait(self, what, predicate, seconds, interval=0.5):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            value = predicate()
            if value:
                return value
            time.sleep(interval)
        raise AssertionError(f"timed out waiting for {what}")

    def set_policy(self, policy, token=TOKEN):
        node, _ = self.leader()
        if not node:
            return 0, None
        headers = {"X-Ishtirak-Admin": token} if token is not None else {}
        return call("POST", f"http://127.0.0.1:{HTTP_PORT[node]}/api/policy", {"policy": policy}, headers)


class Gateways:
    """One thread per building, asking for ceil(demand) the way a real gateway does: every second while it holds less
    than it wants, every 3 s otherwise."""

    def __init__(self, cluster):
        self.cluster = cluster
        self.demand = {b: 0 for b in BUILDINGS}
        self.session = {b: f"s-{b}-{uuid.uuid4().hex[:6]}" for b in BUILDINGS}
        self.held = {b: 0 for b in BUILDINGS}
        self.stop_flag = threading.Event()
        self.threads = []
        self.counts = {"requests": 0, "accepted": 0, "partial": 0, "refused": 0, "unreachable": 0}
        self.lock = threading.Lock()

    def loop(self, building):
        last = 0.0
        while not self.stop_flag.is_set():
            want = self.demand[building]
            wait = 1.0 if self.held[building] < want else 3.0
            if want > 0 and time.monotonic() - last >= wait:
                last = time.monotonic()
                node, _ = self.cluster.leader()
                if not node:
                    with self.lock:
                        self.counts["unreachable"] += 1
                else:
                    code, body = call("POST", f"http://127.0.0.1:{HTTP_PORT[node]}/api/grants",
                                      {"request_id": uuid.uuid4().hex, "building_id": building, "session_id": self.session[building], "amps": want})
                    with self.lock:
                        self.counts["requests"] += 1
                        if code == 200 and body and body.get("accepted"):
                            self.counts["accepted"] += 1
                            self.held[building] = max(0, body["lease"]["amps"])
                            if body.get("reason") == "granted_partial":
                                self.counts["partial"] += 1
                        elif code == 200:
                            self.counts["refused"] += 1
                        else:
                            self.counts["unreachable"] += 1
            time.sleep(0.1)

    def start(self):
        self.threads = [threading.Thread(target=self.loop, args=(b,), daemon=True) for b in BUILDINGS]
        for t in self.threads:
            t.start()

    def stop(self):
        self.stop_flag.set()
        for t in self.threads:
            t.join(timeout=5)


class Sampler:
    """Polls every live node about twice a second and records the largest granted total it ever saw."""

    def __init__(self, cluster):
        self.cluster, self.samples, self.max_granted, self.violations = cluster, 0, 0, []
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop_flag.is_set():
            for node in NODES:
                st = self.cluster.status(node) if self.cluster.alive(node) else None
                if st:
                    self.samples += 1
                    granted = sum(lease["amps"] for lease in st.get("leases", []))
                    self.max_granted = max(self.max_granted, granted)
                    if granted > st.get("capacity_amps", CAPACITY) or st.get("granted_amps", 0) > st.get("capacity_amps", CAPACITY):
                        self.violations.append({"node": node, "granted": granted})
            time.sleep(0.5)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_flag.set()
        self.thread.join(timeout=5)


def reserved(status):
    return {lease["building_id"]: lease["amps"] for lease in status.get("leases", []) if lease["building_id"] in BUILDINGS}


def max_min(demand, capacity=CAPACITY):
    """Independent water-filling oracle (real-valued) for the max-min fair share of each demand."""
    left, share, remaining = float(capacity), {}, dict(demand)
    while remaining:
        level = left / len(remaining)
        small = {b: d for b, d in remaining.items() if d <= level}
        if not small:
            for b in remaining:
                share[b] = level
            break
        for b, d in small.items():
            share[b] = d
            left -= d
            del remaining[b]
    return share


def converged(status, demand, tolerance=1):
    """The ledger has registered the new demand, and every building holds its max-min share (within one amp)."""
    wants = {w["building_id"]: w["amps"] for w in status.get("wants", [])}
    if wants != demand:
        return False
    expected = max_min(demand)
    held = reserved(status)
    return all(abs(held.get(b, 0) - expected[b]) <= tolerance for b in BUILDINGS) and sum(held.values()) <= CAPACITY


def converge_seconds(cluster, demand, seconds, tolerance=1):
    started = time.monotonic()

    def done():
        _, st = cluster.leader()
        return st if st and converged(st, dict(demand), tolerance) else None
    st = cluster.wait(f"max-min shares for demand {dict(demand)}", done, seconds)
    return round(time.monotonic() - started, 2), reserved(st), {b: round(v, 1) for b, v in max_min(demand).items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--work", default=str(ROOT / "artifacts" / "native-cluster-work"))
    parser.add_argument("--out", default=str(ROOT / "artifacts" / "native-cluster-check.json"))
    args = parser.parse_args()
    work = Path(args.work)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    report = {"started_at": datetime.now(timezone.utc).isoformat(), "environment": "three coordinator processes on localhost, no Docker, no database",
              "capacity_amps": CAPACITY, "checks": [], "passed": False}
    cluster, gateways, sampler = Cluster(args.binary, work), None, None

    def record(name, ok, **details):
        report["checks"].append({"name": name, "passed": bool(ok), **details})
        print(("PASS " if ok else "FAIL ") + name + (" " + json.dumps(details) if details else ""), flush=True)
        if not ok:
            raise AssertionError(name)
    try:
        for node in NODES:
            cluster.start(node)
        leader, st = cluster.wait("a leader with quorum", cluster.leader_or_none, 40)
        record("cluster forms with a leader and quorum", True, leader=leader)
        sampler = Sampler(cluster)
        sampler.start()
        cluster.wait("fair_share committed on every node", lambda: all((cluster.status(n) or {}).get("fair_share") is True for n in NODES), 40)
        record("fair_share is committed on its own once every peer supports it", True)
        no_token, _ = cluster.set_policy("first_come", token=None)
        wrong, _ = cluster.set_policy("first_come", token="wrong")
        _, after = cluster.leader()
        record("the policy endpoint refuses a missing or wrong admin token", no_token == 403 and wrong == 403 and (after or {}).get("fair_share") is True, missing=no_token, wrong=wrong)

        code, _ = cluster.set_policy("first_come")
        cluster.wait("first_come committed", lambda: (cluster.leader()[1] or {}).get("fair_share") is False, 20)
        gateways = Gateways(cluster)
        results = {}
        for building, amps in (("hamra", 102), ("mar_mikhael", 7), ("achrafieh", 4)):
            node, _ = cluster.leader()
            c, body = call("POST", f"http://127.0.0.1:{HTTP_PORT[node]}/api/grants", {"request_id": uuid.uuid4().hex, "building_id": building, "session_id": gateways.session[building], "amps": amps})
            results[building] = (body or {}).get("lease", {}).get("amps") if c == 200 and body and body.get("accepted") else None
        _, st = cluster.leader()
        record("first_come lets one building hold 102 A while the others get 7 A and 4 A", reserved(st) == {"hamra": 102, "mar_mikhael": 7, "achrafieh": 4}, reserved=reserved(st))

        cluster.set_policy("fair_share")
        cluster.wait("fair_share committed", lambda: (cluster.leader()[1] or {}).get("fair_share") is True, 20)
        demand = {"hamra": 102, "mar_mikhael": 99, "achrafieh": 98}
        gateways.demand.update(demand)
        gateways.held.update({"hamra": 102, "mar_mikhael": 7, "achrafieh": 4})
        gateways.start()
        seconds, final, shares = converge_seconds(cluster, demand, 60)
        record("fair_share moves a hog (102/7/4 A) to the max-min shares (40 A each)", True, seconds=seconds, reserved=final, expected=shares)

        demand = {"hamra": 10, "mar_mikhael": 100, "achrafieh": 100}
        gateways.demand.update(demand)
        seconds, final, shares = converge_seconds(cluster, demand, 60)
        record("a changed demand mix (10/100/100 A) converges to 10/55/55 A", True, seconds=seconds, reserved=final, expected=shares)

        old_leader, _ = cluster.leader()
        demand = {"hamra": 100, "mar_mikhael": 100, "achrafieh": 100}
        gateways.demand.update(demand)
        converge_seconds(cluster, demand, 60)
        started = time.monotonic()
        cluster.kill(old_leader)
        new_leader, _ = cluster.wait("a new leader", lambda: (lambda n_s: n_s if n_s[0] and n_s[0] != old_leader else None)(cluster.leader()), 30)
        record("a new leader is elected within a bound after the leader is killed", True, old=old_leader, new=new_leader, seconds=round(time.monotonic() - started, 2))
        before = gateways.counts["accepted"]
        cluster.wait("new grants accepted by the new leader", lambda: gateways.counts["accepted"] >= before + 6, 30)
        seconds, final, shares = converge_seconds(cluster, demand, 60)
        record("grants continue under the new leader and the shares hold", True, new_grants_accepted=gateways.counts["accepted"] - before, seconds=seconds, reserved=final, expected=shares)
        report["gateway_requests"] = dict(gateways.counts)

        cluster.start(old_leader)
        cluster.wait("the restarted node to report", lambda: cluster.status(old_leader), 40)
        gateways.stop()
        gateways = None
        time.sleep(4)

        def same_state():
            sts = [cluster.status(n) for n in NODES]
            if any(s is None for s in sts):
                return None
            key = lambda s: (s["raft"].get("applied_index"), json.dumps(sorted((l["building_id"], l["amps"], l.get("tiers")) for l in s["leases"])),
                             json.dumps(sorted((w["building_id"], w["amps"]) for w in s.get("wants", []))), s.get("fair_share"))
            return sts if len({key(s) for s in sts}) == 1 else None
        sts = cluster.wait("identical replica state", same_state, 60)
        record("the restarted node rejoins and every replica ends in the same state", True, applied_index=sts[0]["raft"].get("applied_index"), reserved=reserved(sts[0]))

        sampler.stop()
        record("the granted total never exceeded the capacity on any live node", not sampler.violations and sampler.max_granted <= CAPACITY,
               samples=sampler.samples, max_granted=sampler.max_granted, violations=sampler.violations[:3])
        report["passed"] = True
    except Exception as error:  # noqa: BLE001 - report every failure with its cause
        report["error"] = f"{type(error).__name__}: {error}"
        print("FAIL:", report["error"], file=sys.stderr, flush=True)
    finally:
        if gateways:
            gateways.stop()
        if sampler and not sampler.stop_flag.is_set():
            sampler.stop()
        if sampler:
            report["sampling"] = {"samples": sampler.samples, "max_granted_amps": sampler.max_granted, "violations": sampler.violations[:5]}
        cluster.stop_all()
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        report["limits"] = ["Sampling about twice a second is evidence, not a proof.", "One run on one machine; the processes share a clock and a loopback network.",
                            "No gateways, MQTT, PostgreSQL, nginx or control service: those are covered by their own tests and the Docker evaluation."]
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
        print("Report:", args.out, "|", "PASS" if report["passed"] else "FAIL", flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
