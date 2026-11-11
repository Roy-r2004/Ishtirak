import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chaos_check as cc  # noqa: E402


def grant(request_id, version, accepted=True, status=200, amps=5, payload_hash="h",
          lease_amps=None, partial=False):
    row = {"request_id": request_id, "status": status, "accepted": accepted,
           "version": version, "amps": amps, "payload_hash": payload_hash}
    if lease_amps is not None:
        row["lease_amps"] = lease_amps
    if partial:
        row["partial"] = True
    return row


class CheckHistoryTests(unittest.TestCase):
    def test_clean_history_passes(self):
        samples = [{"t": 0, "granted": 0}, {"t": 1, "granted": 60, "capacity": 120},
                   {"t": 2, "granted": 120, "capacity": 120}]
        grants = [grant("a", 10), grant("a", 10), grant("b", 11),
                  grant("c", None, accepted=False), grant("d", None, accepted=None, status=503)]
        result = cc.check_history(samples, grants, 120)
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["max_granted"], 120)
        self.assertEqual(result["duplicate_versions"], [])
        self.assertEqual(result["samples"], 3)
        self.assertEqual(result["grants"], 5)

    def test_granted_over_capacity_is_flagged(self):
        result = cc.check_history([{"t": 0, "granted": 60}, {"t": 1, "granted": 121}], [], 120)
        self.assertEqual(result["max_granted"], 121)
        self.assertEqual(len(result["violations"]), 1)
        self.assertIn("121", result["violations"][0])

    def test_negative_granted_is_flagged(self):
        result = cc.check_history([{"t": 0, "granted": -1}], [], 120)
        self.assertTrue(result["violations"])

    def test_duplicate_committed_version_is_flagged(self):
        result = cc.check_history([], [grant("a", 7), grant("b", 7)], 120)
        self.assertEqual(result["duplicate_versions"], [7])
        self.assertTrue(result["violations"])

    def test_replay_of_same_request_with_same_version_is_not_duplicate(self):
        result = cc.check_history([], [grant("a", 7), grant("a", 7), grant("a", 7)], 120)
        self.assertEqual(result["duplicate_versions"], [])
        self.assertEqual(result["violations"], [])

    def test_replay_with_changed_outcome_is_flagged(self):
        changed_version = cc.check_history([], [grant("a", 7), grant("a", 9)], 120)
        self.assertTrue(changed_version["violations"])
        flipped = cc.check_history([], [grant("a", None, accepted=False), grant("a", 9)], 120)
        self.assertTrue(flipped["violations"])

    def test_accepted_conflicting_payload_is_flagged(self):
        result = cc.check_history([], [grant("a", 7, payload_hash="x"),
                                       grant("a", 8, payload_hash="y")], 120)
        self.assertTrue(any("conflict" in v for v in result["violations"]))

    def test_rejected_conflicting_payload_is_fine(self):
        result = cc.check_history([], [grant("a", 7, payload_hash="x"),
                                       grant("a", None, accepted=False, payload_hash="y")], 120)
        self.assertEqual(result["violations"], [])

    def test_unknown_outcomes_never_create_violations(self):
        rows = [grant("a", None, accepted=None, status=503), grant("a", 4),
                grant("b", None, accepted=None, status=0)]
        self.assertEqual(cc.check_history([], rows, 120)["violations"], [])

    def test_accepted_without_version_is_flagged(self):
        self.assertTrue(cc.check_history([], [grant("a", None)], 120)["violations"])

    def test_lease_sum_mismatch_is_flagged(self):
        result = cc.check_history([{"t": 0, "granted": 10, "lease_sum": 12}], [], 120)
        self.assertTrue(result["violations"])


class PartialGrantHistoryTests(unittest.TestCase):
    """fair_share may answer accepted:true, reason granted_partial, with fewer amps than requested."""

    def test_partial_grants_are_normal_accepted_grants(self):
        rows = [grant("a", 7, amps=10, lease_amps=4, partial=True), grant("b", 8, amps=5, lease_amps=5),
                grant("c", 9, amps=12, lease_amps=12), grant("d", None, accepted=False)]
        result = cc.check_history([], rows, 120)
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["duplicate_versions"], [])

    def test_replay_of_a_partial_grant_is_consistent(self):
        rows = [grant("a", 7, amps=10, lease_amps=4, partial=True)] * 3
        self.assertEqual(cc.check_history([], rows, 120)["violations"], [])

    def test_replay_returning_different_lease_amps_is_flagged(self):
        rows = [grant("a", 7, amps=10, lease_amps=4, partial=True),
                grant("a", 7, amps=10, lease_amps=6, partial=True)]
        self.assertTrue(cc.check_history([], rows, 120)["violations"])

    def test_two_partial_grants_cannot_share_a_version(self):
        rows = [grant("a", 7, amps=10, lease_amps=4, partial=True),
                grant("b", 7, amps=10, lease_amps=3, partial=True)]
        result = cc.check_history([], rows, 120)
        self.assertEqual(result["duplicate_versions"], [7])
        self.assertTrue(result["violations"])

    def test_partial_grant_without_a_version_is_flagged(self):
        self.assertTrue(cc.check_history([], [grant("a", None, amps=10, lease_amps=4, partial=True)],
                                         120)["violations"])

    def test_rows_without_lease_amps_still_work(self):
        rows = [grant("a", 7), grant("a", 7)]
        self.assertEqual(cc.check_history([], rows, 120)["violations"], [])


class LeaseBudgetTests(unittest.TestCase):
    def test_full_grant_needs_at_least_the_requested_amps(self):
        self.assertTrue(cc.lease_budget_ok(5, 5, False))
        self.assertTrue(cc.lease_budget_ok(5, 9, False))     # an older, larger reservation is kept
        self.assertFalse(cc.lease_budget_ok(5, 4, False))
        self.assertFalse(cc.lease_budget_ok(5, None, False))

    def test_partial_grant_needs_at_most_the_requested_amps(self):
        self.assertTrue(cc.lease_budget_ok(10, 4, True))
        self.assertTrue(cc.lease_budget_ok(10, 10, True))
        self.assertFalse(cc.lease_budget_ok(10, 11, True))
        self.assertFalse(cc.lease_budget_ok(10, -1, True))
        self.assertFalse(cc.lease_budget_ok(10, None, True))

    def test_is_partial_reads_the_reason(self):
        self.assertTrue(cc.is_partial({"accepted": True, "reason": "granted_partial"}))
        self.assertFalse(cc.is_partial({"accepted": True, "reason": "granted"}))
        self.assertFalse(cc.is_partial({"accepted": False, "reason": "granted_partial"}))
        self.assertFalse(cc.is_partial({}))


class RecordTests(unittest.TestCase):
    """Chaos.record() with scripted responses: no network."""

    def chaos(self):
        return cc.Chaos("http://stack.invalid", 1, 10, 1, Path("unused.json"))

    @staticmethod
    def payload(amps=10):
        return {"request_id": "r1", "building_id": "chaos-b", "session_id": "chaos-s", "amps": amps}

    @staticmethod
    def reply(reason, lease_amps, **overrides):
        lease = {"building_id": "chaos-b", "session_id": "chaos-s", "amps": lease_amps, "version": 9}
        data = {"request_id": "r1", "accepted": True, "reason": reason, "lease": lease, **overrides}
        return {"status": 200, "data": data, "latency_ms": 1.0}

    def test_partial_grant_is_a_normal_accepted_grant(self):
        chaos = self.chaos()
        row = chaos.record(self.payload(10), "new", self.reply("granted_partial", 4), "coordinator1")
        self.assertEqual(chaos.runner_violations, [])
        self.assertEqual((row["outcome"], row["accepted"], row["version"]), ("accepted", True, 9))
        self.assertEqual((row["lease_amps"], row["partial"], row["amps"]), (4, True, 10))
        self.assertEqual(list(chaos.accepted_payloads), [self.payload(10)])  # still usable for renew/conflict replays

    def test_full_grant_records_the_lease_amps_it_got(self):
        chaos = self.chaos()
        row = chaos.record(self.payload(10), "new", self.reply("granted", 12), "coordinator1")
        self.assertEqual(chaos.runner_violations, [])
        self.assertEqual((row["lease_amps"], row["partial"]), (12, False))

    def test_full_grant_below_the_request_is_still_a_violation(self):
        chaos = self.chaos()
        chaos.record(self.payload(10), "new", self.reply("granted", 4), "coordinator1")
        self.assertEqual(len(chaos.runner_violations), 1)

    def test_partial_grant_above_the_request_is_a_violation(self):
        chaos = self.chaos()
        chaos.record(self.payload(10), "new", self.reply("granted_partial", 11), "coordinator1")
        self.assertEqual(len(chaos.runner_violations), 1)

    def test_identity_mismatch_is_still_a_violation_for_partial_grants(self):
        chaos = self.chaos()
        bad = self.reply("granted_partial", 4)
        bad["data"]["lease"]["session_id"] = "someone-else"
        chaos.record(self.payload(10), "new", bad, "coordinator1")
        self.assertEqual(len(chaos.runner_violations), 1)

    def test_rejection_row_has_no_lease_amps(self):
        chaos = self.chaos()
        rejected = {"status": 200, "data": {"accepted": False, "reason": "capacity_exhausted"}, "latency_ms": 1.0}
        row = chaos.record(self.payload(10), "new", rejected, "coordinator1")
        self.assertEqual((row["accepted"], row["reason"], row["lease_amps"], row["partial"]),
                         (False, "capacity_exhausted", None, False))
        self.assertEqual(chaos.runner_violations, [])


class PolicyReportTests(unittest.TestCase):
    @staticmethod
    def node(name, flag, online=True):
        data = {} if flag is None else {"fair_share": flag}
        return {"id": name, "online": online, "data": data}

    def test_policy_summary_consistent(self):
        nodes = [self.node("coordinator1", True), self.node("coordinator2", True), self.node("coordinator3", True)]
        summary = cc.policy_summary(nodes)
        self.assertEqual((summary["policy"], summary["fair_share"], summary["consistent"]),
                         ("fair_share", True, True))
        self.assertEqual(summary["per_node"], {"coordinator1": True, "coordinator2": True, "coordinator3": True})
        first_come = cc.policy_summary([self.node("coordinator1", False), self.node("coordinator2", False)])
        self.assertEqual((first_come["policy"], first_come["fair_share"]), ("first_come", False))

    def test_policy_summary_ignores_offline_nodes(self):
        nodes = [self.node("coordinator1", True), self.node("coordinator2", False, online=False)]
        summary = cc.policy_summary(nodes)
        self.assertEqual(summary["policy"], "fair_share")
        self.assertNotIn("coordinator2", summary["per_node"])

    def test_policy_summary_flags_disagreement_and_missing_flags(self):
        mixed = cc.policy_summary([self.node("coordinator1", True), self.node("coordinator2", False)])
        self.assertEqual((mixed["policy"], mixed["fair_share"], mixed["consistent"]), (None, None, False))
        missing = cc.policy_summary([self.node("coordinator1", None)])
        self.assertEqual((missing["policy"], missing["consistent"]), (None, False))
        self.assertEqual(cc.policy_summary([])["policy"], None)

    def test_sample_once_records_the_leaders_policy_flag(self):
        chaos = cc.Chaos("http://stack.invalid", 1, 10, 1, Path("unused.json"))
        leader = {"id": "coordinator1", "online": True,
                  "data": {"state": "Leader", "quorum": True, "granted_amps": 5, "capacity_amps": 120,
                           "leases": [{"amps": 5}], "fair_share": True}}
        chaos.overview = lambda: {"nodes": [leader], "buildings": []}
        chaos.sample_once()
        self.assertIs(chaos.status_samples[0]["fair_share"], True)

    def test_report_carries_the_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "chaos.json"
            chaos = cc.Chaos("http://stack.invalid", 1, 10, 1, output)
            chaos.policy_start = cc.policy_summary([self.node("coordinator1", True)])
            chaos.policy_end = cc.policy_summary([self.node("coordinator1", True)])
            chaos.status_samples = [{"t": 1, "fair_share": True}, {"t": 2, "fair_share": None},
                                    {"t": 3, "fair_share": False}]
            chaos.record(RecordTests.payload(10), "new", RecordTests.reply("granted_partial", 4), "coordinator1")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                chaos.write_report("start", False, True)
            report = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(report["policy"]["at_start"]["policy"], "fair_share")
        self.assertEqual(report["policy"]["at_end"]["policy"], "fair_share")
        self.assertEqual(report["policy"]["observed_during_run"], ["fair_share", "first_come"])
        self.assertEqual(report["counts"]["accepted"], 1)
        self.assertEqual(report["counts"]["accepted_partial"], 1)
        self.assertEqual(report["history"]["violations"], [])
        self.assertEqual(chaos.runner_violations, [])


class ClassifyTests(unittest.TestCase):
    def test_partial_grant_classifies_as_accepted(self):
        self.assertEqual(cc.classify_response(200, {"accepted": True, "reason": "granted_partial"}), "accepted")
        counts = cc.count_outcomes([
            {"outcome": "accepted", "partial": True}, {"outcome": "accepted"}, {"outcome": "rejected"}])
        self.assertEqual((counts["accepted"], counts["accepted_partial"], counts["rejected"]), (2, 1, 1))

    def test_unknown_outcomes_are_not_rejections(self):
        self.assertEqual(cc.classify_response(503, {"error": "commit outcome unknown"}), "unknown")
        self.assertEqual(cc.classify_response(0, {}), "unknown")
        self.assertEqual(cc.classify_response(502, {}), "unknown")
        counts = cc.count_outcomes([
            {"outcome": cc.classify_response(503, {})},
            {"outcome": cc.classify_response(0, {})},
            {"outcome": cc.classify_response(200, {"accepted": True})},
            {"outcome": cc.classify_response(200, {"accepted": False, "reason": "capacity_exhausted"})},
            {"outcome": cc.classify_response(307, {})},
        ])
        self.assertEqual(counts["requests"], 5)
        self.assertEqual(counts["accepted"], 1)
        self.assertEqual(counts["rejected"], 1)
        self.assertEqual(counts["unknown_outcome"], 2)
        self.assertEqual(counts["redirect_not_processed"], 1)

    def test_definitive_answers(self):
        self.assertEqual(cc.classify_response(200, {"accepted": True}), "accepted")
        self.assertEqual(cc.classify_response(200, {"accepted": False}), "rejected")
        self.assertEqual(cc.classify_response(409, {}), "rejected")
        self.assertEqual(cc.classify_response(400, {}), "invalid")
        self.assertEqual(cc.classify_response(200, {"accepted": "yes"}), "unknown")


class ScheduleTests(unittest.TestCase):
    SERVICES = set(cc.COORDINATORS) | set(cc.GATEWAYS) | {"postgres"}

    def test_deterministic_for_seed(self):
        self.assertEqual(cc.build_schedule(1, 90), cc.build_schedule(1, 90))
        self.assertNotEqual(cc.build_schedule(1, 90), cc.build_schedule(2, 90))

    def test_shape_and_ordering(self):
        for seed in range(30):
            schedule = cc.build_schedule(seed, 90)
            self.assertTrue(schedule)
            times = [e["at"] for e in schedule]
            self.assertEqual(times, sorted(times))
            for event in schedule:
                self.assertIn(event["service"], self.SERVICES)
                self.assertIn(event["action"], ("stop", "start"))
                self.assertGreaterEqual(event["at"], 0)
                self.assertLessEqual(event["at"], 90)

    def test_final_state_all_started(self):
        for seed in range(30):
            for duration in (20, 45, 90, 180):
                up = {s: True for s in self.SERVICES}
                for event in cc.build_schedule(seed, duration):
                    up[event["service"]] = event["action"] == "start"
                self.assertTrue(all(up.values()), (seed, duration))

    def test_stops_and_starts_pair_up(self):
        for seed in range(30):
            up = {s: True for s in self.SERVICES}
            for event in cc.build_schedule(seed, 90):
                stopping = event["action"] == "stop"
                self.assertEqual(up[event["service"]], stopping, (seed, event))
                up[event["service"]] = not stopping

    def test_never_two_coordinators_down_outside_majority_window(self):
        for seed in range(60):
            for duration in (30, 60, 90, 180):
                schedule = cc.build_schedule(seed, duration)
                windows = {e.get("window") for e in schedule if e.get("window")}
                self.assertLessEqual(windows, {"majority_loss"})
                tagged_stops = [e for e in schedule if e.get("window") and e["action"] == "stop"]
                self.assertIn(len(tagged_stops), (0, 2))
                down = set()
                for event in schedule:
                    if event["service"] in cc.COORDINATORS:
                        if event["action"] == "stop":
                            down.add(event["service"])
                        else:
                            down.discard(event["service"])
                    if len(down) >= 2:
                        # Only the explicit window may reach this state.
                        self.assertTrue(event.get("window"), (seed, duration, event))
                    self.assertLess(len(down), 3)

    def test_at_most_one_service_down_outside_majority_window(self):
        for seed in range(60):
            down = set()
            for event in cc.build_schedule(seed, 90):
                if event["action"] == "stop":
                    down.add(event["service"])
                else:
                    down.discard(event["service"])
                if not event.get("window"):
                    self.assertLessEqual(len(down), 1, (seed, event))

    def test_exactly_one_majority_window_for_long_runs(self):
        for seed in range(30):
            schedule = cc.build_schedule(seed, 90)
            stops = [e for e in schedule if e.get("window") == "majority_loss" and e["action"] == "stop"]
            self.assertEqual(len(stops), 2)
            self.assertEqual(len({e["service"] for e in stops}), 2)

    def test_all_service_kinds_appear_across_seeds(self):
        seen = {e["service"] for seed in range(20) for e in cc.build_schedule(seed, 120)}
        self.assertEqual(seen, self.SERVICES)


if __name__ == "__main__":
    unittest.main()
