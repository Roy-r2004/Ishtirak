"""Scripted-stack tests for the standby-gateway handling in scripts/evaluate.py.

Every building has a primary gateway and a standby gateway. A GatewayFake replaces
Evaluation.request/overview with an in-memory model of that pair: the ledger lets one
gateway hold a building's lease, frees it HOLD seconds after the holder stops, and the
idle partner then takes it over. No network, Docker or live stack is used and the real
deadlines are patched down to fractions of a second. These check the phase logic
(which service is stopped, restarted, in what order, what is recorded and when it
fails), not the Ishtirak backend; nothing here has run against a Docker stack.

Run from the project root: python -I -m unittest discover -s scripts -p "test_*.py"
"""

import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock


def load_evaluate():
    path = Path(__file__).resolve().parent / "evaluate.py"
    spec = importlib.util.spec_from_file_location("evaluate_standby_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evaluate = load_evaluate()
PRIMARY, STANDBY = evaluate.PRIMARY_SERVICE, evaluate.STANDBY_SERVICE
HAMRA, HAMRA_STANDBY = PRIMARY["hamra"], STANDBY["hamra"]


class GatewayFake(evaluate.Evaluation):
    """One leader plus a primary and a standby gateway per building. Only one gateway of a building holds
    its lease; the lease lapses HOLD seconds after the holder stops, then the idle partner (if it is allowed
    to) acquires it RETRY seconds later under its own session. An idle gateway reports role "standby" and
    does not read; a serving one reads on every overview."""

    HOLD, RETRY = 0.25, 0.05

    def __init__(self, standby_takes_over=True, steals_back=False, readings_stall=False,
                 with_standbys=True, fail_on=None, violate_on_stop=False):
        super().__init__("http://stack.invalid", Path("."), Path("out.json"))
        self.standby_takes_over, self.steals_back, self.readings_stall = standby_takes_over, steals_back, readings_stall
        self.with_standbys, self.fail_on, self.violate_on_stop = with_standbys, fail_on, violate_on_stop
        self.log, self.sessions, self.version, self.fair = [], 0, 0, True
        self.guard = threading.Lock()
        self.gw, self.holder, self.lease, self.lapsed_at, self.readings = {}, {}, {}, {}, {}
        for building in evaluate.BUILDINGS:
            for service in (PRIMARY[building], STANDBY[building]):
                self.gw[service] = {"building": building, "online": True, "session": self.new_session(service),
                                    "stopped_at": None, "started_at": time.monotonic() - 10}
                self.readings[service] = 100
            self.holder[building] = PRIMARY[building]
            self.version += 1
            self.lease[building] = {"session_id": self.gw[PRIMARY[building]]["session"], "amps": 10,
                                    "version": self.version}

    def new_session(self, service):
        self.sessions += 1
        return f"{service}-s{self.sessions}"

    # ---- the API surface evaluate.py uses
    def request(self, path, payload=None, timeout=8):
        reply = lambda status, data: {"status": status, "data": data, "latency_ms": 1.0}
        if path == "/api/actions":
            service, action = payload["service"], payload["action"]
            self.log.append((service, action))
            if self.fail_on == (service, action):
                return reply(500, {"error": "injected failure"})
            with self.guard:
                if service in self.gw:
                    self.apply(service, action)
            if self.violate_on_stop and action == "stop":
                with self.lock:
                    self.invariant_failures.append({"injected": "capacity"})
            return reply(200, {})
        if path == "/api/policy":
            self.fair = payload["policy"] == "fair_share"
            return reply(200, {"policy": payload["policy"]})
        if path == "/api/meters/config":
            return reply(200, {})
        raise AssertionError(f"unexpected request {path}")

    def apply(self, service, action):
        now, gw = time.monotonic(), self.gw[service]
        if action == "stop" and gw["online"]:
            gw.update(online=False, stopped_at=now)
        elif action == "start" and not gw["online"]:
            gw.update(online=True, session=self.new_session(service), started_at=now)
            building = gw["building"]
            if self.steals_back and service == PRIMARY[building] and self.holder[building] not in (None, service):
                self.holder[building] = service     # the bug this models: a restarted primary seizes the building
                self.version += 1
                self.lease[building] = {"session_id": gw["session"], "amps": 10, "version": self.version}

    def advance(self):
        now = time.monotonic()
        for building in evaluate.BUILDINGS:
            holder = self.holder[building]
            if holder and not self.gw[holder]["online"] and now - self.gw[holder]["stopped_at"] >= self.HOLD:
                self.holder[building] = None
                self.lapsed_at[building] = self.gw[holder]["stopped_at"] + self.HOLD
                self.lease.pop(building, None)
            if self.holder[building] is None:
                order = [PRIMARY[building]] + ([STANDBY[building]] if self.standby_takes_over else [])
                for service in order:
                    gw = self.gw[service]
                    if gw["online"] and now - max(self.lapsed_at[building], gw["started_at"]) >= self.RETRY:
                        self.holder[building] = service
                        self.version += 1
                        self.lease[building] = {"session_id": gw["session"], "amps": 10, "version": self.version}
                        break

    def entry(self, service):
        gw = self.gw[service]
        building = gw["building"]
        if not gw["online"]:
            return {"id": building, "online": False, "data": {}}
        serving = self.holder[building] == service
        if serving and not self.readings_stall:
            self.readings[service] += 5
        amps = self.lease[building]["amps"] if serving else 0
        data = {"session_id": gw["session"], "meter_count": 17, "readings_total": self.readings[service],
                "pending_readings": 0, "state": "active" if serving else "standby", "mqtt_connected": True,
                "demand_amps": 8, "granted_amps": amps, "served_amps": min(8, amps),
                "lease_remaining_ms": 5000 if serving else 0}
        if self.with_standbys:
            data["role"] = "serving" if serving else ("standby" if self.holder[building] else "waiting")
        return {"id": building, "online": True, "data": data}

    def overview(self):
        with self.guard:
            self.advance()
            leases = [{"building_id": b, **lease} for b, lease in self.lease.items()]
            node = {"id": "coordinator1", "online": True,
                    "data": {"state": "Leader", "quorum": True, "capacity_amps": 120, "fair_share": self.fair,
                             "granted_amps": sum(l["amps"] for l in leases), "leases": leases, "fair_shares": []}}
            view = {"nodes": [node], "buildings": [self.entry(PRIMARY[b]) for b in evaluate.BUILDINGS]}
            if self.with_standbys:
                view["standbys"] = [self.entry(STANDBY[b]) for b in evaluate.BUILDINGS]
            return view

    def online(self, service):
        return self.gw[service]["online"]


class FastDeadlines(unittest.TestCase):
    """Real deadlines shrunk so that a failing phase gives up within a second or two."""

    def setUp(self):
        quiet = contextlib.redirect_stdout(io.StringIO())   # repeat() announces each trial
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        for name, value in (("STANDBY_READY_TIMEOUT_SECONDS", 1), ("STANDBY_TAKEOVER_TIMEOUT_SECONDS", 2),
                            ("STANDBY_SERVING_TIMEOUT_SECONDS", 1), ("STANDBY_RETURN_SECONDS", 1),
                            ("STANDBY_POLL_SECONDS", 0.02)):
            patch = mock.patch.object(evaluate, name, value)
            patch.start()
            self.addCleanup(patch.stop)


class StandbyTakeoverPhaseTests(FastDeadlines):
    def test_three_trials_record_the_takeover_and_alternate_the_stopped_gateway(self):
        stack = GatewayFake()
        result = stack.gateway_standby_takeover()
        self.assertEqual(len(result["trials"]), 3)
        self.assertEqual(result["summary"]["takeover_seconds"]["n"], 3)
        self.assertIn("takeover_seconds", result["headline_basis"])
        for trial in result["trials"]:
            self.assertEqual(trial["building"], "hamra")
            self.assertGreaterEqual(trial["takeover_seconds"], stack.HOLD - 0.05)   # held until the lease lapsed
            self.assertLess(trial["takeover_seconds"], 2)
            self.assertNotEqual(trial["previous_session_id"], trial["new_session_id"])
            self.assertTrue(trial["readings_continued"] and trial["primary_returned_as_standby"])
            self.assertGreater(trial["readings_after"], trial["readings_before"])
        # The restarted gateway stays the standby, so the next trial stops the gateway that took over.
        self.assertEqual([t["stopped_service"] for t in result["trials"]], [HAMRA, HAMRA_STANDBY, HAMRA])
        self.assertEqual([t["taken_over_by"] for t in result["trials"]], [HAMRA_STANDBY, HAMRA, HAMRA_STANDBY])
        self.assertIn(result["new_session_id"], [t["new_session_id"] for t in result["trials"]])  # median trial's keys
        self.assertEqual(stack.holder["hamra"], HAMRA_STANDBY)
        self.assertTrue(all(stack.online(service) for service in stack.gw))

    def test_one_trial_stops_the_serving_primary_then_restarts_it(self):
        stack = GatewayFake()
        previous = stack.lease["hamra"]["session_id"]
        trial = stack.standby_takeover_trial()
        self.assertEqual(stack.log, [(HAMRA, "stop"), (HAMRA, "start")])
        self.assertEqual((trial["building"], trial["previous_session_id"]), ("hamra", previous))
        self.assertEqual(trial["new_session_id"], stack.lease["hamra"]["session_id"])
        self.assertEqual(stack.holder["hamra"], HAMRA_STANDBY)

    def test_a_building_whose_standby_is_not_idle_is_skipped(self):
        stack = GatewayFake()
        stack.apply(HAMRA_STANDBY, "stop")
        trial = stack.standby_takeover_trial()
        self.assertEqual(trial["building"], "mar_mikhael")
        self.assertEqual(stack.log, [(PRIMARY["mar_mikhael"], "stop"), (PRIMARY["mar_mikhael"], "start")])

    def test_a_standby_that_never_takes_over_fails_cleanly_and_restarts_the_primary(self):
        stack = GatewayFake(standby_takes_over=False)
        with self.assertRaises(AssertionError) as caught:
            stack.gateway_standby_takeover()
        self.assertIn("take the building over", str(caught.exception))
        self.assertEqual(stack.log, [(HAMRA, "stop"), (HAMRA, "start")])   # stopped once, restarted, no retry loop
        self.assertTrue(stack.online(HAMRA))

    def test_a_primary_that_takes_the_building_back_fails(self):
        stack = GatewayFake(steals_back=True)
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("took hamra back", str(caught.exception))
        self.assertTrue(stack.online(HAMRA))

    def test_a_lease_that_moves_to_a_third_session_after_the_restart_fails(self):
        stack = GatewayFake()
        real_apply = stack.apply

        def apply(service, action):
            real_apply(service, action)
            if (service, action) == (HAMRA, "start"):   # someone else replaces the lease, primary stays "standby"
                stack.version += 1
                stack.lease["hamra"] = {"session_id": "intruder", "amps": 10, "version": stack.version}
        stack.apply = apply
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("lease moved", str(caught.exception))

    def test_readings_that_do_not_advance_fail_and_restart_the_primary(self):
        stack = GatewayFake(readings_stall=True)
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("growing readings", str(caught.exception))
        self.assertEqual(stack.log[-1], (HAMRA, "start"))
        self.assertTrue(stack.online(HAMRA))

    def test_a_primary_that_never_rejoins_as_standby_fails(self):
        stack = GatewayFake()
        real_entry = stack.entry
        stack.entry = lambda service: (
            {"id": "hamra", "online": True, "data": {"role": "waiting", "session_id": "x"}}
            if service == HAMRA and stack.log.count((HAMRA, "start")) else real_entry(service))
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("rejoin as standby", str(caught.exception))

    def test_an_invariant_failure_during_the_wait_aborts_and_restarts_the_primary(self):
        stack = GatewayFake(violate_on_stop=True)
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("observed invariant failure", str(caught.exception))
        self.assertEqual(stack.log, [(HAMRA, "stop"), (HAMRA, "start")])

    def test_a_failed_stop_request_still_restarts_the_primary(self):
        stack = GatewayFake(fail_on=(HAMRA, "stop"))
        with self.assertRaises(RuntimeError):
            stack.standby_takeover_trial()
        self.assertEqual(stack.log[-1], (HAMRA, "start"))

    def test_without_standbys_in_the_overview_nothing_is_stopped(self):
        stack = GatewayFake(with_standbys=False)
        with self.assertRaises(AssertionError) as caught:
            stack.standby_takeover_trial()
        self.assertIn("idle standby gateway", str(caught.exception))
        self.assertEqual(stack.log, [])


class GatewayCrashTrialTests(unittest.TestCase):
    def test_the_standby_is_stopped_first_and_restored_last(self):
        stack = GatewayFake()
        result = stack.gateway_crash_trial()
        self.assertEqual(stack.log, [(HAMRA_STANDBY, "stop"), (HAMRA, "stop"), (HAMRA, "start"),
                                     (HAMRA_STANDBY, "start")])
        self.assertTrue(result["standby_stopped"] and result["fresh_session_verified"])
        self.assertEqual((result["building"], result["previous_amps"]), ("hamra", 10))
        self.assertGreaterEqual(result["reclaim_seconds"], stack.HOLD - 0.05)
        self.assertTrue(all(stack.online(service) for service in stack.gw))
        time.sleep(stack.RETRY * 3)
        stack.overview()                                  # let the ledger settle after the restarts
        self.assertEqual(stack.holder["hamra"], HAMRA)    # the restarted primary, not the standby, serves

    def test_keeps_the_existing_result_keys(self):
        result = GatewayFake().gateway_crash_trial()
        for key in ("building", "reclaim_seconds", "previous_amps", "fresh_session_verified"):
            self.assertIn(key, result)

    def test_the_standby_is_restored_when_the_primary_stop_fails(self):
        stack = GatewayFake(fail_on=(HAMRA, "stop"))
        with self.assertRaises(RuntimeError):
            stack.gateway_crash_trial()
        self.assertEqual(stack.log, [(HAMRA_STANDBY, "stop"), (HAMRA, "stop"), (HAMRA_STANDBY, "start")])
        self.assertTrue(stack.online(HAMRA_STANDBY))

    def test_both_gateways_are_restarted_when_reclamation_times_out(self):
        stack = GatewayFake()
        real_wait = stack.wait

        def wait(description, predicate, deadline=30, *args, **kwargs):
            if "reclamation" in description:
                raise AssertionError(f"deadline exceeded waiting for {description}; last=None")
            return real_wait(description, predicate, deadline, *args, **kwargs)
        stack.wait = wait
        with self.assertRaises(AssertionError):
            stack.gateway_crash_trial()
        self.assertEqual(stack.log, [(HAMRA_STANDBY, "stop"), (HAMRA, "stop"), (HAMRA, "start"),
                                     (HAMRA_STANDBY, "start")])
        self.assertTrue(stack.online(HAMRA) and stack.online(HAMRA_STANDBY))

    def test_the_standby_is_restored_when_the_primary_never_reports_fresh_readings(self):
        stack = GatewayFake()
        real_wait = stack.wait

        def wait(description, predicate, deadline=30, *args, **kwargs):
            if "fresh readings" in description:
                raise AssertionError(f"deadline exceeded waiting for {description}; last=None")
            return real_wait(description, predicate, deadline, *args, **kwargs)
        stack.wait = wait
        with self.assertRaises(AssertionError):
            stack.gateway_crash_trial()
        self.assertEqual(stack.log[-1], (HAMRA_STANDBY, "start"))

    def test_both_gateways_down_even_when_the_standby_was_the_one_serving(self):
        stack = GatewayFake()
        stack.holder["hamra"] = HAMRA_STANDBY       # a takeover left the standby serving
        stack.lease["hamra"]["session_id"] = stack.gw[HAMRA_STANDBY]["session"]
        result = stack.gateway_crash_trial()
        self.assertEqual(result["building"], "hamra")
        self.assertEqual(stack.log[:2], [(HAMRA_STANDBY, "stop"), (HAMRA, "stop")])
        self.assertGreaterEqual(result["reclaim_seconds"], stack.HOLD - 0.05)


class RestoreAndTotalsTests(unittest.TestCase):
    def test_every_standby_is_a_known_service_and_restored(self):
        self.assertEqual(len(evaluate.GATEWAY_STANDBYS), 3)
        for service in evaluate.GATEWAY_STANDBYS:
            self.assertIn(service, evaluate.SERVICES)
        stack = GatewayFake()
        stack.restore()
        started = [service for service, action in stack.log if action == "start"]
        self.assertEqual(started, list(evaluate.SERVICES))                 # primaries before standbys
        self.assertTrue(set(evaluate.GATEWAY_STANDBYS) <= {r["service"] for r in stack.report["restoration"]
                                                           if r["started"]})
        self.assertLess(started.index(HAMRA), started.index(HAMRA_STANDBY))

    def test_a_stopped_standby_is_started_again_by_restore(self):
        stack = GatewayFake()
        stack.apply(HAMRA_STANDBY, "stop")
        stack.restore()
        self.assertTrue(stack.online(HAMRA_STANDBY))

    @staticmethod
    def entry(building, role, served, online=True):
        return {"id": building, "online": online,
                "data": {"role": role, "served_amps": served, "meter_count": 10, "readings_total": 100,
                         "pending_readings": 1}}

    def test_totals_follow_the_gateway_that_serves_each_building(self):
        overview = {"buildings": [self.entry("hamra", "standby", 0), self.entry("mar_mikhael", "serving", 5),
                                  self.entry("achrafieh", "standby", 0)],
                    "standbys": [self.entry("hamra", "serving", 7), self.entry("mar_mikhael", "standby", 0),
                                 self.entry("achrafieh", "standby", 0)]}
        rows = evaluate.serving_gateways(overview)
        self.assertEqual([(r["id"], r["data"]["served_amps"]) for r in rows],
                         [("hamra", 7), ("mar_mikhael", 5), ("achrafieh", 0)])
        totals = evaluate.Evaluation.totals(overview)
        self.assertEqual((totals["served"], totals["meters"], totals["readings"], totals["pending"]),
                         (12, 30, 300, 3))

    def test_totals_equal_the_buildings_sum_without_standbys_or_roles(self):
        buildings = [{"id": b, "online": True, "data": {"served_amps": 4, "meter_count": 17}}
                     for b in evaluate.BUILDINGS]
        overview = {"buildings": buildings}
        self.assertEqual(evaluate.serving_gateways(overview), buildings)
        self.assertEqual(evaluate.Evaluation.totals(overview)["served"], 12)
        self.assertEqual(evaluate.Evaluation.totals({"buildings": buildings, "standbys": []})["meters"], 51)

    def test_a_standby_that_is_not_serving_or_is_offline_is_ignored(self):
        overview = {"buildings": [self.entry("hamra", "serving", 5), self.entry("mar_mikhael", "standby", 0, online=False),
                                  self.entry("achrafieh", "waiting", 0)],
                    "standbys": [self.entry("hamra", "serving", 9), self.entry("mar_mikhael", "serving", 9, online=False),
                                 self.entry("achrafieh", "standby", 0)]}
        self.assertEqual([r["data"]["served_amps"] for r in evaluate.serving_gateways(overview)], [5, 0, 0])

    def test_gateway_role_reads_only_online_entries(self):
        self.assertEqual(evaluate.gateway_role(self.entry("hamra", "serving", 1)), "serving")
        self.assertIsNone(evaluate.gateway_role(self.entry("hamra", "serving", 1, online=False)))
        self.assertIsNone(evaluate.gateway_role(None))
        self.assertIsNone(evaluate.gateway_role({"id": "hamra", "online": True, "data": {}}))


class SamplerStandbyTests(unittest.TestCase):
    def test_a_healthy_overview_with_standbys_records_no_failure(self):
        stack = GatewayFake()
        stack.sample(stack.overview())
        self.assertEqual(stack.invariant_failures, [])
        self.assertGreater(stack.node_samples, 0)

    def test_a_standby_serving_more_than_its_demand_is_flagged(self):
        stack = GatewayFake()
        view = stack.overview()
        view["standbys"][0]["data"].update(served_amps=9, demand_amps=8)
        stack.sample(view)
        self.assertEqual([f.get("standby") for f in stack.invariant_failures], ["hamra"])

    def test_a_standby_serving_on_an_expired_lease_is_flagged(self):
        stack = GatewayFake()
        view = stack.overview()
        view["standbys"][1]["data"].update(served_amps=3, lease_remaining_ms=0)
        stack.sample(view)
        self.assertEqual([f.get("standby") for f in stack.invariant_failures], ["mar_mikhael"])

    def test_a_primary_failure_keeps_its_building_key(self):
        stack = GatewayFake()
        view = stack.overview()
        view["buildings"][2]["data"].update(served_amps=99)
        stack.sample(view)
        self.assertEqual([f.get("building") for f in stack.invariant_failures], ["achrafieh"])

    def test_an_overview_without_standbys_still_samples(self):
        stack = GatewayFake(with_standbys=False)
        stack.sample(stack.overview())
        self.assertEqual(stack.invariant_failures, [])


class ReportAndPhaseOrderTests(unittest.TestCase):
    def test_the_takeover_phase_runs_right_after_the_crash_phase(self):
        names = []
        with tempfile.TemporaryDirectory() as directory:
            stack = GatewayFake()
            stack.output = Path(directory) / "evaluation.json"
            stack.node_samples = 1                 # the real sampler thread is not waited for
            stack.phase = lambda name, function: names.append(name)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                stack.run()
        self.assertEqual(names[:4], ["readiness_and_real_mqtt", "gateway_crash_and_reclamation",
                                     "gateway_standby_takeover", "leader_failure"])
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("capacity_stress_and_idempotency", names)

    def test_the_design_and_limitations_describe_the_standby_phase(self):
        report = GatewayFake().report
        for key in ("gateway_standbys", "standby_takeover_trials", "standby_ready_timeout_seconds",
                    "standby_takeover_timeout_seconds", "standby_serving_timeout_seconds",
                    "standby_return_seconds", "gateway_crash_stops_the_standby"):
            self.assertIn(key, report["design"])
        self.assertEqual(report["design"]["gateway_standbys"], list(evaluate.GATEWAY_STANDBYS))
        text = " ".join(report["limitations"])
        self.assertIn("gateway_standby_takeover", text)
        self.assertIn("12 s hold", text)
        self.assertIn("never been run against Docker", text)
        self.assertIn("gateway_standby_takeover", evaluate.__doc__)
        self.assertIn("standby_stopped", evaluate.__doc__)


if __name__ == "__main__":
    unittest.main()
