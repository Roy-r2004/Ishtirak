"""Scripted-stack tests for scripts/reset_demo.py: no network, no Docker, no real waiting.

A ResetFake answers the controller API in memory. A building keeps a lease while either of its two
gateways runs (a standby takes a building over once its serving gateway stops), so the old
reservations can only expire when every gateway of every building has been stopped.

Run from the project root: python -I -m unittest discover -s scripts -p "test_*.py"
"""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest import mock


def load_reset_demo():
    path = Path(__file__).resolve().parent / "reset_demo.py"
    spec = importlib.util.spec_from_file_location("reset_demo_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reset_demo = load_reset_demo()
BUILDINGS = ("hamra", "mar_mikhael", "achrafieh")
PAIRS = list(zip(BUILDINGS, reset_demo.GATEWAYS, reset_demo.GATEWAY_STANDBYS))


class Clock:
    """Stands in for the time module: every monotonic() call is one second later, sleep() does nothing."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        self.now += 1.0
        return self.now

    def sleep(self, seconds):
        pass


class ResetFake:
    def __init__(self, stubborn=()):
        self.online = {service: True for _, primary, standby in PAIRS for service in (primary, standby)}
        self.stubborn = set(stubborn)     # services whose "stop" does not take effect
        self.log = []

    def call(self, base, path, body=None):
        if path == "/api/actions":
            service, action = body["service"], body["action"]
            self.log.append((service, action))
            if action == "start" or service not in self.stubborn:
                self.online[service] = action == "start"
            return {}
        if path == "/api/overview":
            return self.overview()
        raise AssertionError(f"unexpected request {path}")

    def overview(self):
        leases = [{"building_id": b, "amps": 10} for b, primary, standby in PAIRS
                  if self.online[primary] or self.online[standby]]
        leader = {"id": "coordinator1", "online": True,
                  "data": {"state": "Leader", "leases": leases, "granted_amps": 10 * len(leases),
                           "capacity_amps": 120}}
        buildings, standbys = [], []
        for building, primary, standby in PAIRS:
            primary_serves = self.online[primary]
            buildings.append({"id": building, "online": self.online[primary],
                              "data": {"state": "active", "role": "serving"}})
            standbys.append({"id": building, "online": self.online[standby],
                             "data": {"state": "active" if not primary_serves and self.online[standby] else "idle",
                                      "role": "serving" if not primary_serves and self.online[standby] else "standby"}})
        return {"demo_enabled": True, "nodes": [leader], "buildings": buildings, "standbys": standbys}


class ResetMainTests(unittest.TestCase):
    def run_main(self, fake):
        with mock.patch.object(reset_demo, "call", fake.call), mock.patch.object(reset_demo, "time", Clock()), \
                mock.patch.object(sys, "argv", ["reset_demo.py"]), contextlib.redirect_stdout(io.StringIO()):
            return reset_demo.main()

    def test_every_gateway_of_every_building_is_stopped_then_restarted_primaries_first(self):
        fake = ResetFake()
        self.run_main(fake)
        everything = list(reset_demo.ALL_GATEWAYS)
        self.assertEqual(len(everything), 6)
        self.assertEqual(everything, [*reset_demo.GATEWAYS, *reset_demo.GATEWAY_STANDBYS])
        self.assertEqual(fake.log, [(s, "stop") for s in everything] + [(s, "start") for s in everything])
        self.assertTrue(all(fake.online.values()))

    def test_standbys_that_keep_running_stop_the_reservations_from_expiring(self):
        # If a standby were left running it would take its building over and keep the lease alive.
        fake = ResetFake(stubborn=reset_demo.GATEWAY_STANDBYS[:1])
        with self.assertRaises(SystemExit) as caught:
            self.run_main(fake)
        self.assertIn("old reservations to expire", str(caught.exception))
        started = [service for service, action in fake.log if action == "start"]
        self.assertEqual(started, list(reset_demo.ALL_GATEWAYS))   # the finally block still restarts every gateway

    def test_a_standby_that_serves_after_the_restart_counts_as_a_served_building(self):
        fake = ResetFake()
        fake.online[reset_demo.GATEWAYS[0]] = False      # hamra is served by its standby
        self.assertTrue(reset_demo.all_ready(fake.overview()))


class ReadinessTests(unittest.TestCase):
    @staticmethod
    def overview(primary_state="active", standby_online=True, standby_role="standby", primary_role="serving"):
        return {"buildings": [{"id": "hamra", "online": True, "data": {"state": primary_state, "role": primary_role}}],
                "standbys": [{"id": "hamra", "online": standby_online,
                              "data": {"state": "active", "role": standby_role}}]}

    def test_ready_when_the_primary_serves_and_the_standby_is_up(self):
        self.assertTrue(reset_demo.all_ready(self.overview()))

    def test_not_ready_while_a_standby_is_down(self):
        self.assertFalse(reset_demo.all_ready(self.overview(standby_online=False)))

    def test_not_ready_while_the_serving_gateway_is_not_active(self):
        self.assertFalse(reset_demo.all_ready(self.overview(primary_state="starting")))

    def test_ready_on_a_stack_without_standbys(self):
        old = {"buildings": [{"id": "hamra", "online": True, "data": {"state": "active"}}]}
        self.assertTrue(reset_demo.all_ready(old))
        self.assertEqual(reset_demo.serving_gateways(old), old["buildings"])

    def test_the_serving_standby_is_judged_instead_of_its_idle_primary(self):
        view = self.overview(primary_state="starting", primary_role="standby", standby_role="serving")
        self.assertTrue(reset_demo.all_ready(view))
        self.assertIs(reset_demo.serving_gateways(view)[0], view["standbys"][0])


if __name__ == "__main__":
    unittest.main()
