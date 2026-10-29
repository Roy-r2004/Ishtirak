"""Unit tests for the pure statistics helpers in scripts/evaluate.py.

Run from the project root: python -I -m unittest scripts/test_evaluate_stats.py -v
No network, Docker or live stack is used.
"""

import importlib.util
import math
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
