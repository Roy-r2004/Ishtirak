"""Reset building allocations after a demand spike (for demonstrations).

A renewal never shrinks an existing reservation (a deliberate safety trade-off: an older,
larger grant may still be valid at the gateway), so a building that once reserved a large
amount, for example during a 200-meter run, keeps it while its session renews and can starve
the other buildings. Restarting the three gateways starts fresh sessions: the old reservations
expire through the normal committed lease expiry, then each building asks for its current demand.

Only the three named gateway services are stopped and started through the project's
label-checked local controller. Raft state and volumes are untouched.
Usage: python -I scripts/reset_demo.py [--base-url http://127.0.0.1:8088]
"""
import argparse
import json
import sys
import time
import urllib.request

GATEWAYS = ("gateway-hamra", "gateway-mar-mikhael", "gateway-achrafieh")


def call(base, path, body=None):
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read())


def leader_leases(overview):
    leader = next((n for n in overview["nodes"] if n.get("online") and n["data"]["state"] == "Leader"), None)
    return None if leader is None else leader["data"]["leases"]


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
        for service in GATEWAYS:
            call(base, "/api/actions", {"service": service, "action": "stop"})
        wait("old reservations to expire", lambda o: leader_leases(o) == [], 60)
    finally:
        for service in GATEWAYS:
            call(base, "/api/actions", {"service": service, "action": "start"})
    wait("all buildings to receive a budget", lambda o: all(
        b.get("online") and b["data"]["state"] == "active" for b in o["buildings"]), 90)
    overview = call(base, "/api/overview")
    leader = next(n for n in overview["nodes"] if n.get("online") and n["data"]["state"] == "Leader")["data"]
    print("granted", leader["granted_amps"], "of", leader["capacity_amps"], "A:",
          ", ".join(f"{l['building_id']} {l['amps']} A" for l in leader["leases"]))


if __name__ == "__main__":
    sys.exit(main())
