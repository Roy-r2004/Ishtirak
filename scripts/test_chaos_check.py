import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import chaos_check as cc  # noqa: E402


def grant(request_id, version, accepted=True, status=200, amps=5, payload_hash="h"):
    return {"request_id": request_id, "status": status, "accepted": accepted,
            "version": version, "amps": amps, "payload_hash": payload_hash}


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


class ClassifyTests(unittest.TestCase):
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
