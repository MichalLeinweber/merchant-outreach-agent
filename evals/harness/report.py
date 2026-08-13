"""Collecting every metric in one place, and saying which ones are missing.

`record_baseline.py` writes these numbers into `baseline.json`; `test_baseline.py`
compares a fresh set against it. Both call the same function, so the baseline
cannot be recorded with one definition of a metric and checked against another.

A metric that cannot be measured right now comes back as `None` with a reason
attached, never as a zero. Zero is a measurement.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parents[1]
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets, metrics  # noqa: E402
from harness.datasets import RUBRIC_AXES  # noqa: E402


@dataclass
class Measurement:
    """Every metric the baseline knows about, and why any are missing."""

    values: dict[str, Any] = field(default_factory=dict)
    unavailable: dict[str, str] = field(default_factory=dict)

    def flat(self) -> dict[str, float | None]:
        flat: dict[str, float | None] = {}
        for key, value in self.values.items():
            if isinstance(value, dict):
                for inner, inner_value in value.items():
                    flat[f"{key}.{inner}"] = inner_value
            else:
                flat[key] = value
        return flat


def measure_gates(reports: list[dict[str, Any]]) -> dict[str, float]:
    """The three numbers the committed corpus can produce with no model at all."""
    return {
        "gate_pass_rate": round(metrics.gate_pass_rate(reports), 6),
        "hallucination_rate": round(metrics.hallucination_rate(reports), 6),
        "blocked_rate": round(metrics.blocked_rate(reports), 6),
    }


def measure_triage(
    golden: list[datasets.GoldenCase],
) -> tuple[float | None, str | None]:
    """Triage accuracy, or the reason it cannot be measured yet."""
    labelled = [case for case in golden if case.labelled]
    if not labelled:
        return None, (
            "no golden case has an expected_bucket yet - label them in "
            "evals/datasets/golden.jsonl"
        )

    run = bridge.run_triage(
        [case.merchant for case in labelled], now=datasets.EVAL_NOW, mode="fixture"
    )
    by_id = {entry["merchantId"]: entry for entry in run["results"]}

    missing = [
        case.id for case in labelled if not by_id.get(case.id, {}).get("ok")
    ]
    if missing:
        return None, (
            f"{len(missing)} of {len(labelled)} labelled merchants have no recorded "
            f"triage response - record them with the live workflow"
        )

    expected = {case.id: case.expected_bucket for case in labelled}
    predicted = {
        case.id: by_id[case.id]["result"]["recommendedAction"] for case in labelled
    }
    result = metrics.classification_metrics(expected, predicted)
    return round(result.accuracy, 6), None


def measure_judge() -> tuple[dict[str, float] | None, str | None]:
    """Mean judge score per axis, replayed from fixtures.

    Imported lazily: `judge.py` reaches for the pricing table through the
    bridge, and the gate metrics have no business paying for that.
    """
    import judge as judge_module

    try:
        report = judge_module.calibrate(judge_module.Judge(mode="fixture"))
    except judge_module.JudgeError as error:
        return None, str(error).splitlines()[0]

    return {axis: round(report.judge_means[axis], 4) for axis in RUBRIC_AXES}, None


def collect(
    corpus_reports: list[dict[str, Any]],
    golden: list[datasets.GoldenCase],
) -> Measurement:
    """Everything that can be measured right now, and notes on everything else."""
    measurement = Measurement()
    measurement.values.update(measure_gates(corpus_reports))

    accuracy, reason = measure_triage(golden)
    measurement.values["triage_accuracy"] = accuracy
    if reason:
        measurement.unavailable["triage_accuracy"] = reason

    judge_means, reason = measure_judge()
    measurement.values["judge_mean"] = judge_means or {axis: None for axis in RUBRIC_AXES}
    if reason:
        measurement.unavailable["judge_mean"] = reason

    # Cost per draft is a fact about a live run. The corpus is hand-written, so
    # there is nothing to measure here and nothing to guess.
    measurement.values["cost_per_draft_usd"] = None
    measurement.unavailable["cost_per_draft_usd"] = (
        "the draft corpus is hand-written; cost is only meaningful for a live run"
    )

    return measurement
