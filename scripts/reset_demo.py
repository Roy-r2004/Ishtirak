"""Reset building allocations after a demand spike (for demonstrations).

A renewal never shrinks an existing reservation (a deliberate safety trade-off: an older,
larger grant may still be valid at the gateway), so a building that once reserved a large
amount, for example during a 200-meter run, keeps it while its session renews and can starve
the other buildings. Restarting the gateways starts fresh sessions: the old reservations
expire through the normal committed lease expiry, then each building asks for its current demand.

Every building has a primary and a standby gateway (same code, same building). A standby takes
a building over about 12 s after its serving gateway stops renewing, so stopping only the three
primaries would hand each building to its standby: the leases would never empty and a stale
standby session would keep the old reservation alive. All six gateways are therefore stopped
together; once the old reservations have expired the primaries are started first and the
standbys after them, so the primaries normally serve and the standbys idle.

Only the six named gateway services are stopped and started through the project's
label-checked local controller. Raft state and volumes are untouched.
Usage: python -I scripts/reset_demo.py [--base-url http://127.0.0.1:8088]
"""
import argparse
import json
import sys
import time
import urllib.request

GATEWAYS = ("gateway-hamra", "gateway-mar-mikhael", "gateway-achrafieh")
GATEWAY_STANDBYS = ("gateway-hamra-standby", "gateway-mar-mikhael-standby", "gateway-achrafieh-standby")
ALL_GATEWAYS = (*GATEWAYS, *GATEWAY_STANDBYS)   # start order: primaries first, so they normally serve


def call(base, path, body=None):
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())


def leader_leases(overview):
    leader = next((n for n in overview["nodes"] if n.get("online") and n["data"]["state"] == "Leader"), None)
    return None if leader is None else leader["data"]["leases"]


def serving_gateways(overview):
    """One gateway entry per building: the standby's if it reports role "serving" (and the primary does
    not), else the primary's. Equal to overview["buildings"] on a stack without standbys."""
    standbys = {e.get("id"): e for e in overview.get("standbys", [])}
    rows = []
    for primary in overview["buildings"]:
        standby = standbys.get(primary.get("id"))
        standby_serves = bool(standby and standby.get("online") and standby["data"].get("role") == "serving")
        primary_serves = bool(primary.get("online") and primary["data"].get("role") == "serving")
        rows.append(standby if standby_serves and not primary_serves else primary)
    return rows


def all_ready(overview):
    """Every building is served by an online gateway in state "active" and every standby gateway is up."""
    return (all(b.get("online") and b["data"]["state"] == "active" for b in serving_gateways(overview))
            and all(s.get("online") for s in overview.get("standbys", [])))


def wait(description, condition, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            if condition(call(base, "/api/overview")):
                return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit(f"timed out waiting for {description}")


def main():
    global base
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8088")
    base = parser.parse_args().base_url
    if not call(base, "/api/overview").get("demo_enabled"):
        raise SystemExit("demo controls are disabled")
    try:
        for service in ALL_GATEWAYS:
            call(base, "/api/actions", {"service": service, "action": "stop"})
        wait("old reservations to expire", lambda o: leader_leases(o) == [], 60)
    finally:
        for service in ALL_GATEWAYS:
            call(base, "/api/actions", {"service": service, "action": "start"})
    wait("all buildings to receive a budget", all_ready, 90)
    overview = call(base, "/api/overview")
    leader = next(n for n in overview["nodes"] if n.get("online") and n["data"]["state"] == "Leader")["data"]
    print("granted", leader["granted_amps"], "of", leader["capacity_amps"], "A:",
          ", ".join(f"{l['building_id']} {l['amps']} A" for l in leader["leases"]))


if __name__ == "__main__":
    sys.exit(main())
