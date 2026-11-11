"""Scripted-stack tests for the policy-aware phases in scripts/evaluate.py.

A FakeStack replaces Evaluation.request/overview with an in-memory ledger, so no
network, Docker or live stack is used and the real timings are patched down to
fractions of a second. These check the phase logic (ordering, policy changes,
recorded keys, cleanup), not the Ishtirak backend.

Run from the project root: python -I -m unittest discover -s scripts -p "test_*.py"
"""

import importlib.util
from pathlib import Path
import threading
import time
import unittest
from unittest import mock


def load_evaluate():
    path = Path(__file__).resolve().parent / "evaluate.py"
    spec = importlib.util.spec_from_file_location("evaluate_phases_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evaluate = load_evaluate()
CAPACITY, LEASE_TTL_SECONDS = 120, 1.0


class FakeStack(evaluate.Evaluation):
    """One leader whose ledger follows the contract: first_come is all-or-nothing, fair_share may
    grant partially; leases lapse after LEASE_TTL_SECONDS."""

    def __init__(self, hog_forms=True, converges=True, partial_in_first_come=False):
        super().__init__("http://stack.invalid", Path("."), Path("out.json"))
        self.fair, self.meters, self.calls = True, 50, 0
        self.hog_forms, self.converges, self.partial_in_first_come = hog_forms, converges, partial_in_first_come
        self.flipped_at = None
        self.policy_posts, self.configs = [], []
        self.ledger, self.stored, self.version = {}, {}, 0
        self.guard = threading.Lock()

    # ---- the API surface evaluate.py uses
    def request(self, path, payload=None, timeout=8):
        reply = lambda status, data: {"status": status, "data": data, "latency_ms": 1.0}
        if path == "/api/policy":
            self.policy_posts.append(payload["policy"])
            self.fair = payload["policy"] == "fair_share"
            self.flipped_at = self.calls
            return reply(200, {"policy": payload["policy"]})
        if path == "/api/meters/config":
            self.configs.append((payload["meter_count"], payload["demand_factor"]))
            self.meters = payload["meter_count"]
            return reply(200, {})
        if path == "/api/actions":
            if payload["service"] == "meters":  # the meter fleet drives the real buildings' reservations
                self.meters = 0 if payload["action"] == "stop" else 50
            return reply(200, {})
        if path.endswith("/api/grants"):
            return self.grant_request(payload, reply)
        raise AssertionError(f"unexpected request {path}")

    def grant_request(self, payload, reply):
        with self.guard:
            now = time.monotonic()
            self.ledger = {k: v for k, v in self.ledger.items() if now - v["t"] < LEASE_TTL_SECONDS}
            key = payload["request_id"]
            if key in self.stored:
                same, answer = self.stored[key]
                return reply(200, answer) if same == payload else reply(409, {
                    "accepted": False, "reason": "request_id_conflict"})
            held = sum(v["amps"] for v in self.ledger.values())
            free = CAPACITY - held
            partial_allowed = self.fair or self.partial_in_first_come
            amps = payload["amps"] if payload["amps"] <= free else (free if partial_allowed else 0)
            if amps <= 0:
                answer = {"request_id": key, "accepted": False, "reason": "capacity_exhausted"}
            else:
                self.version += 1
                lease = {"building_id": payload["building_id"], "session_id": payload["session_id"],
                         "amps": amps, "version": self.version}
                self.ledger[payload["building_id"]] = {"amps": amps, "t": now}
                answer = {"request_id": key, "accepted": True, "lease": lease,
                          "reason": "granted_partial" if amps < payload["amps"] else "granted"}
            self.stored[key] = (payload, answer)
            return reply(200, answer)

    def leases(self):
        if self.meters == 0:
            return []
        if self.meters >= 200 and not self.fair:
            amps = (102, 7, 4) if self.hog_forms else (40, 40, 40)
        elif self.meters >= 200 and self.fair:
            settled = self.converges and self.calls - (self.flipped_at or 0) >= 3
            amps = (40, 40, 40) if settled else ((70, 20, 10) if self.hog_forms else (40, 40, 40))
        else:
            amps = (4, 4, 4)
        return [{"building_id": b, "amps": a, "session_id": "s", "version": 1}
                for b, a in zip(evaluate.BUILDINGS, amps)]

    def overview(self):
        self.calls += 1
        with self.guard:
            now = time.monotonic()
            live = [v for v in self.ledger.values() if now - v["t"] < LEASE_TTL_SECONDS]
        leases = self.leases() + [{"building_id": f"other-{i}", "amps": v["amps"], "session_id": "s", "version": 1}
                                  for i, v in enumerate(live)]
        data = {"state": "Leader", "quorum": True, "capacity_amps": CAPACITY, "fair_share": self.fair,
                "granted_amps": sum(l["amps"] for l in leases), "leases": leases,
                "fair_shares": [{"building_id": b, "amps": 40} for b in evaluate.BUILDINGS] if self.fair else []}
        counts = (17, 17, 16)
        buildings = [{"id": b, "online": True, "data": {"meter_count": c}}
                     for b, c in zip(evaluate.BUILDINGS, counts)]
        return {"nodes": [{"id": "coordinator1", "online": True, "data": data}], "buildings": buildings}


class FairSharingPhaseTests(unittest.TestCase):
    def run_phase(self, stack, convergence_timeout=5):
        patches = (mock.patch.object(evaluate, "FAIRNESS_QUIET_SECONDS", 0.05),
                   mock.patch.object(evaluate, "FAIRNESS_OVERLOAD_SECONDS", 0.3),
                   mock.patch.object(evaluate, "FAIRNESS_POLL_SECONDS", 0.05),
                   mock.patch.object(evaluate, "FAIRNESS_CONVERGENCE_TIMEOUT_SECONDS", convergence_timeout))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        return stack.fair_sharing_under_overload()

    def test_records_the_hog_then_the_converged_fair_outcome(self):
        stack = FakeStack()
        result = self.run_phase(stack)
        self.assertTrue(result["spike_reproduced"])
        first = result["first_come"]
        self.assertEqual(first["reserved_amps"], {"hamra": 102, "mar_mikhael": 7, "achrafieh": 4})
        self.assertAlmostEqual(first["jain_index"], 0.4066, places=3)
        self.assertEqual(first["peak_reserved_amps_per_building"], 102)
        fair = result["fair_share"]
        self.assertEqual(fair["reserved_amps"], {"hamra": 40, "mar_mikhael": 40, "achrafieh": 40})
        self.assertEqual(fair["fair_shares"], {"hamra": 40, "mar_mikhael": 40, "achrafieh": 40})
        self.assertEqual(fair["jain_index"], 1.0)
        self.assertEqual(fair["max_deviation_amps"], 0)
        self.assertGreaterEqual(fair["convergence_seconds"], 0)
        self.assertLessEqual(result["peak_total_amps"], CAPACITY)
        self.assertEqual(result["capacity_amps"], CAPACITY)

    def test_policy_and_meter_sequence_and_cleanup(self):
        stack = FakeStack()
        self.run_phase(stack)
        self.assertEqual(stack.policy_posts, ["first_come", "fair_share", "fair_share"])
        self.assertEqual([c[0] for c in stack.configs], [10, 200, 50])
        self.assertEqual(stack.configs[-1], (50, 1.0))
        self.assertEqual(stack.configs[1], (200, 1.0))
        self.assertTrue(stack.fair)

    def test_a_hog_that_did_not_form_is_reported_not_failed(self):
        result = self.run_phase(FakeStack(hog_forms=False))
        self.assertFalse(result["spike_reproduced"])
        self.assertEqual(result["fair_share"]["reserved_amps"]["hamra"], 40)

    def test_non_convergence_fails_but_still_restores_meters_and_policy(self):
        stack = FakeStack(converges=False)
        with self.assertRaises(AssertionError) as caught:
            self.run_phase(stack, convergence_timeout=0.3)
        self.assertIn("fair share", str(caught.exception))
        self.assertEqual(stack.policy_posts[-1], "fair_share")
        self.assertEqual(stack.configs[-1], (50, 1.0))


class CapacityStressTests(unittest.TestCase):
    def test_first_come_keeps_its_exact_counts_and_fair_share_adds_a_second_result(self):
        stack = FakeStack()
        result = stack.capacity_stress()
        self.assertEqual((result["accepted"], result["rejected"], result["committed_amps"]), (17, 23, 119))
        self.assertEqual(result["concurrent_requests"], 40)
        self.assertEqual(result["requested_amps_each"], 7)
        self.assertTrue(result["duplicate_preserved_lease"] and result["conflict_rejected"])
        variant = result["fair_share_variant"]
        self.assertEqual(variant["policy"], "fair_share")
        self.assertEqual(variant["full"] + variant["partial"] + variant["rejected"], 40)
        self.assertEqual(variant["full"], 17)
        self.assertEqual(variant["partial"], 1)          # the 18th request takes the 1 A left
        self.assertLessEqual(variant["committed_amps"], CAPACITY)
        self.assertEqual(variant["capacity_amps"], CAPACITY)
        self.assertEqual(variant["partial_lease_amps"]["max"], 1)
        self.assertEqual(stack.policy_posts, ["first_come", "fair_share", "fair_share"])

    def test_a_partial_grant_under_first_come_is_a_failure(self):
        stack = FakeStack(partial_in_first_come=True)
        with self.assertRaises(AssertionError):
            stack.capacity_stress()
        self.assertEqual(stack.policy_posts[-1], "fair_share")  # restored even on failure


class RestoreTests(unittest.TestCase):
    def test_restore_returns_the_policy_to_fair_share(self):
        stack = FakeStack()
        stack.fair = False
        stack.restore()
        self.assertTrue(stack.fair)
        self.assertEqual(stack.report["policy_restored"], "fair_share")
        self.assertNotIn("policy_restore_error", stack.report)

    def test_failed_policy_restore_is_recorded(self):
        stack = FakeStack()
        original = stack.request
        stack.request = lambda path, payload=None, timeout=8: (
            {"status": 404, "data": {}, "latency_ms": 1.0} if path == "/api/policy"
            else original(path, payload, timeout))
        stack.restore()
        self.assertIn("policy_restore_error", stack.report)


class ReportDesignTests(unittest.TestCase):
    def test_design_block_lists_the_policy_phase_parameters(self):
        design = FakeStack().report["design"]
        for key in ("policies", "default_policy", "policy_timeout_seconds", "capacity_stress_policies",
                    "fairness_quiet_meters", "fairness_quiet_seconds", "fairness_overload_meters",
                    "fairness_overload_seconds", "fairness_convergence_timeout_seconds",
                    "fairness_tolerance_amps"):
            self.assertIn(key, design)
        self.assertEqual(design["default_policy"], "fair_share")
        self.assertIn("fair_sharing_under_overload", evaluate.__doc__)
        self.assertIn("fair_share_variant", evaluate.__doc__)


if __name__ == "__main__":
    unittest.main()
