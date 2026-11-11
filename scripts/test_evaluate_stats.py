"""Unit tests for the pure statistics helpers in scripts/evaluate.py.

Run from the project root: python -I -m unittest scripts/test_evaluate_stats.py -v
No network, Docker or live stack is used.
"""

import importlib.util
import math
from pathlib import Path
import time
import unittest


def load_evaluate():
    path = Path(__file__).resolve().parent / "evaluate.py"
    spec = importlib.util.spec_from_file_location("evaluate_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


evaluate = load_evaluate()


class SummarizeTests(unittest.TestCase):
    def test_empty_gives_nones(self):
        self.assertEqual(evaluate.summarize([]),
                         {"n": 0, "mean": None, "stdev": None, "min": None, "max": None})

    def test_single_value_has_zero_stdev(self):
        self.assertEqual(evaluate.summarize([4.2]),
                         {"n": 1, "mean": 4.2, "stdev": 0.0, "min": 4.2, "max": 4.2})

    def test_five_values_use_sample_stdev(self):
        result = evaluate.summarize([2, 4, 4, 4, 6])
        self.assertEqual(result["n"], 5)
        self.assertEqual(result["mean"], 4.0)
        self.assertEqual(result["min"], 2)
        self.assertEqual(result["max"], 6)
        # sample variance = (4 + 0 + 0 + 0 + 4) / 4 = 2
        self.assertAlmostEqual(result["stdev"], math.sqrt(2), places=3)

    def test_unordered_input(self):
        result = evaluate.summarize([5, 1, 3])
        self.assertEqual((result["min"], result["max"], result["mean"]), (1, 5, 3.0))


class HelperTests(unittest.TestCase):
    def test_median_index(self):
        self.assertEqual(evaluate.median_index([9, 1, 5]), 2)
        self.assertEqual(evaluate.median_index([7]), 0)
        self.assertEqual(evaluate.median_index([4, 1, 3, 2]), 3)  # lower middle (value 3)

    def test_non_200_are_unknown_not_rejections(self):
        rows = [{"status": 200, "accepted": True}, {"status": 200, "accepted": False},
                {"status": 0, "accepted": None}, {"status": 503, "accepted": None}]
        result = evaluate.non_200_summary(rows)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["by_status"], {"0": 1, "503": 1})
        self.assertEqual(result["unknown_outcomes"], 2)

    def test_latency_summary_keys_for_compat(self):
        rows = [{"latency_ms": 1.0, "accepted": True}, {"latency_ms": 3.0, "accepted": False}]
        result = evaluate.latency_summary(rows, 2.0)
        self.assertEqual(result["all_decisions"]["p50_ms"], 2.0)
        self.assertEqual(result["decision_requests_per_second"], 1.0)
        self.assertIn("four concurrent clients", result["measurement"])


class PercentileTests(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(evaluate.percentile([], .5))

    def test_p50_interpolates_between_middle_samples(self):
        self.assertEqual(evaluate.percentile([1, 2, 3, 4], .5), 2.5)

    def test_p50_is_order_independent(self):
        self.assertEqual(evaluate.percentile([4, 1, 3, 2], .5), 2.5)

    def test_p95_of_1_to_100_is_exact(self):
        # point = 99 * .95 = 94.05 -> 95 + .05 * (96 - 95) = 95.05
        self.assertEqual(evaluate.percentile(list(range(1, 101)), .95), 95.05)

    def test_single_sample(self):
        self.assertEqual(evaluate.percentile([7], .95), 7)

    def test_extremes(self):
        self.assertEqual(evaluate.percentile([1, 2, 3], 0), 1)
        self.assertEqual(evaluate.percentile([1, 2, 3], 1), 3)

    def test_report_declares_method(self):
        self.assertEqual(evaluate.PERCENTILE_METHOD, "linear interpolation")
        self.assertIn("linear interpolation", evaluate.__doc__)


class JainIndexTests(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(evaluate.jain_index([]))

    def test_single_value_is_perfectly_fair(self):
        self.assertEqual(evaluate.jain_index([37]), 1.0)

    def test_all_zero_is_undefined(self):
        self.assertIsNone(evaluate.jain_index([0, 0, 0]))
        self.assertIsNone(evaluate.jain_index([0]))

    def test_equal_shares_are_exactly_one(self):
        self.assertEqual(evaluate.jain_index([40, 40, 40]), 1.0)

    def test_hog_scores_low(self):
        # (102 + 7 + 4)^2 / (3 * (102^2 + 7^2 + 4^2)) = 12769 / 31407 = 0.4066
        self.assertAlmostEqual(evaluate.jain_index([102, 7, 4]), 0.4066, places=3)

    def test_bounds_and_order_independence(self):
        value = evaluate.jain_index([120, 0, 0])
        self.assertAlmostEqual(value, 1 / 3, places=3)  # one of n takes everything -> 1/n
        self.assertEqual(evaluate.jain_index([1, 2, 3]), evaluate.jain_index([3, 1, 2]))


class GrantBudgetTests(unittest.TestCase):
    def test_full_grant_holds_at_least_the_request(self):
        self.assertTrue(evaluate.grant_amps_valid("granted", 7, 7))
        self.assertTrue(evaluate.grant_amps_valid(None, 7, 9))  # an existing larger reservation
        self.assertFalse(evaluate.grant_amps_valid("granted", 7, 6))
        self.assertFalse(evaluate.grant_amps_valid(None, 7, None))

    def test_partial_grant_holds_at_most_the_request(self):
        self.assertTrue(evaluate.grant_amps_valid("granted_partial", 7, 3))
        self.assertTrue(evaluate.grant_amps_valid("granted_partial", 7, 7))
        self.assertFalse(evaluate.grant_amps_valid("granted_partial", 7, 8))
        self.assertFalse(evaluate.grant_amps_valid("granted_partial", 7, -1))
        self.assertFalse(evaluate.grant_amps_valid("granted_partial", 7, None))

    def test_non_numbers_are_invalid(self):
        self.assertFalse(evaluate.grant_amps_valid("granted", 7, "7"))
        self.assertFalse(evaluate.grant_amps_valid("granted", 7, True))

    def test_admission_counts_split_full_partial_rejected(self):
        def row(accepted, reason=None, amps=None):
            data = {"reason": reason}
            if amps is not None:
                data["lease"] = {"amps": amps}
            return {"accepted": accepted, "data": data}
        rows = [row(True, "granted", 7), row(True, None, 7), row(True, "granted_partial", 3),
                row(False, "capacity_exhausted"), row(False, "capacity_exhausted")]
        self.assertEqual(evaluate.admission_counts(rows),
                         {"full": 2, "partial": 1, "rejected": 2,
                          "granted_by_responses_amps": 17, "partial_lease_amps": [3]})


class FairShareHelperTests(unittest.TestCase):
    def test_amps_by_building(self):
        rows = [{"building_id": "hamra", "amps": 40}, {"building_id": "mar_mikhael", "amps": 38.5}]
        self.assertEqual(evaluate.amps_by_building(rows), {"hamra": 40, "mar_mikhael": 38.5})
        self.assertEqual(evaluate.amps_by_building([]), {})
        self.assertEqual(evaluate.amps_by_building(None), {})

    def test_reserved_by_building_defaults_to_zero_and_ignores_other_buildings(self):
        leases = [{"building_id": "hamra", "amps": 102}, {"building_id": "eval-x-load", "amps": 5},
                  {"building_id": "achrafieh", "amps": 4}]
        self.assertEqual(evaluate.reserved_by_building(leases),
                         {"hamra": 102, "mar_mikhael": 0, "achrafieh": 4})
        as_dict = {"a": leases[0], "b": leases[2]}
        self.assertEqual(evaluate.reserved_by_building(as_dict),
                         {"hamra": 102, "mar_mikhael": 0, "achrafieh": 4})

    def test_max_deviation(self):
        shares = {"hamra": 40, "mar_mikhael": 40, "achrafieh": 40}
        self.assertEqual(evaluate.max_deviation({"hamra": 102, "mar_mikhael": 7, "achrafieh": 4}, shares), 62)
        self.assertEqual(evaluate.max_deviation({"hamra": 40, "mar_mikhael": 40, "achrafieh": 40}, shares), 0)
        self.assertIsNone(evaluate.max_deviation({"hamra": 40, "mar_mikhael": 40, "achrafieh": 40}, {}))
        self.assertIsNone(evaluate.max_deviation({"hamra": 1, "mar_mikhael": 1, "achrafieh": 1},
                                                 {"hamra": 40, "mar_mikhael": 40}))

    def test_fair_shares_reached_needs_every_building_within_tolerance_and_total_within_capacity(self):
        shares = {"hamra": 40, "mar_mikhael": 40, "achrafieh": 40}
        near = {"hamra": 42, "mar_mikhael": 38, "achrafieh": 43}
        self.assertTrue(evaluate.fair_shares_reached(near, shares, 123 - 3, 120, 3))
        self.assertFalse(evaluate.fair_shares_reached({**near, "achrafieh": 44}, shares, 120, 120, 3))
        self.assertFalse(evaluate.fair_shares_reached(near, shares, 121, 120, 3))   # total over capacity
        self.assertFalse(evaluate.fair_shares_reached(near, {}, 120, 120, 3))       # no shares yet
        self.assertFalse(evaluate.fair_shares_reached({"hamra": 102, "mar_mikhael": 7, "achrafieh": 4},
                                                      shares, 113, 120, 3))

    def test_a_building_below_its_share_can_still_be_within_tolerance_of_zero_share(self):
        shares = {"hamra": 0, "mar_mikhael": 60, "achrafieh": 60}
        self.assertTrue(evaluate.fair_shares_reached({"hamra": 2, "mar_mikhael": 61, "achrafieh": 58},
                                                     shares, 121 - 1, 120, 3))

    def test_policy_matches_reads_the_leaders_flag(self):
        leader = {"id": "coordinator1", "data": {"fair_share": True}}
        self.assertTrue(evaluate.policy_matches(leader, "fair_share"))
        self.assertFalse(evaluate.policy_matches(leader, "first_come"))
        self.assertTrue(evaluate.policy_matches({"data": {"fair_share": False}}, "first_come"))
        self.assertFalse(evaluate.policy_matches(None, "fair_share"))
        self.assertFalse(evaluate.policy_matches({"data": {}}, "fair_share"))          # old backend: no flag
        self.assertFalse(evaluate.policy_matches({"data": {"fair_share": "yes"}}, "fair_share"))


def overview_with(fair_share, leader=True):
    node = {"id": "coordinator1", "online": True,
            "data": {"state": "Leader" if leader else "Follower", "quorum": True, "fair_share": fair_share}}
    return {"nodes": [node], "buildings": []}


class SetPolicyTests(unittest.TestCase):
    """set_policy against a scripted request/overview: no network."""

    def make(self, post_responses, overviews):
        ev = evaluate.Evaluation("http://stack.invalid", Path("."), Path("out.json"))
        ev.posts, posts, views = [], list(post_responses), list(overviews)

        def request(path, payload=None, timeout=8):
            ev.posts.append((path, payload))
            return posts.pop(0) if len(posts) > 1 else posts[0]
        ev.request = request
        ev.overview = lambda: views.pop(0) if len(views) > 1 else views[0]
        return ev

    @staticmethod
    def ok(name):
        return {"status": 200, "data": {"policy": name}, "latency_ms": 1}

    def test_posts_the_policy_and_waits_for_the_leader_to_report_it(self):
        ev = self.make([self.ok("first_come")], [overview_with(True), overview_with(False)])
        ev.set_policy("first_come", deadline=5)
        self.assertEqual(ev.posts, [("/api/policy", {"policy": "first_come"})])

    def test_retries_transient_failures(self):
        busy = {"status": 503, "data": {"error": "no leader"}, "latency_ms": 1}
        ev = self.make([busy, {"status": 0, "data": {}, "latency_ms": 1}, self.ok("fair_share")],
                       [overview_with(True)])
        ev.set_policy("fair_share", deadline=5)
        self.assertEqual(len(ev.posts), 3)

    def test_a_refusal_is_not_retried(self):
        ev = self.make([{"status": 404, "data": {"error": "not found"}, "latency_ms": 1}], [overview_with(True)])
        with self.assertRaises(AssertionError):
            ev.set_policy("fair_share", deadline=5)
        self.assertEqual(len(ev.posts), 1)

    def test_wrong_policy_in_the_response_is_refused(self):
        ev = self.make([self.ok("first_come")], [overview_with(True)])
        with self.assertRaises(AssertionError):
            ev.set_policy("fair_share", deadline=5)

    def test_gives_up_when_the_leader_never_reports_the_policy(self):
        ev = self.make([self.ok("first_come")], [overview_with(True)])
        started = time.monotonic()
        with self.assertRaises(AssertionError) as caught:
            ev.set_policy("first_come", deadline=0.3)
        self.assertLess(time.monotonic() - started, 3)
        self.assertIn("first_come", str(caught.exception))

    def test_unknown_policy_names_are_rejected_without_a_request(self):
        ev = self.make([self.ok("x")], [overview_with(True)])
        with self.assertRaises(ValueError):
            ev.set_policy("round_robin")
        self.assertEqual(ev.posts, [])

    def test_invariant_failures_do_not_block_cleanup_when_checks_are_off(self):
        ev = self.make([self.ok("fair_share")], [overview_with(True)])
        ev.invariant_failures.append({"node": "coordinator1"})
        with self.assertRaises(AssertionError):
            ev.set_policy("fair_share", deadline=2)
        ev.set_policy("fair_share", deadline=2, check_invariants=False)


if __name__ == "__main__":
    unittest.main()
