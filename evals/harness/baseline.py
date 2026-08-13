"""The regression gate.

`baseline.json` holds the numbers from the last approved run. This module
compares a fresh run against it and decides whether the difference is a
regression. It is the mechanism that answers "how do you know the prompt
change did not break anything", so two properties matter more than
convenience:

**A metric that was never measured is not a pass.** Unmeasured metrics are
`null` in the baseline, and comparing against `null` yields NOT_ESTABLISHED —
never OK. The suite reports them as skips naming the command that would
establish them. Treating "no baseline" as "no regression" is the single
easiest way to build a gate that never fires.

**The baseline moves only by committing a new one.** There is no auto-update,
no "record if missing". `record_baseline.py` writes the file, a human reads
the diff, and the pull request says why the number moved.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

BASELINE_PATH = Path(__file__).resolve().parents[1] / "baseline.json"


class Direction(str, Enum):
    HIGHER_IS_BETTER = "higher_is_better"
    LOWER_IS_BETTER = "lower_is_better"


class Status(str, Enum):
    OK = "ok"
    REGRESSED = "regressed"
    NOT_ESTABLISHED = "not_established"
    NOT_MEASURED = "not_measured"


@dataclass(frozen=True)
class Tolerance:
    """How far a metric may move before the build fails."""

    direction: Direction
    #: Maximum allowed movement in the bad direction, in absolute terms.
    #: 0.03 on a rate is three percentage points.
    slack: float


# The thresholds from EVALS.md. Written here rather than in the JSON so that
# loosening one is a code change with a diff a reviewer will notice, not a
# number quietly edited in a data file alongside the measurements.
TOLERANCES: dict[str, Tolerance] = {
    "triage_accuracy": Tolerance(Direction.HIGHER_IS_BETTER, 0.03),
    "gate_pass_rate": Tolerance(Direction.HIGHER_IS_BETTER, 0.03),
    "hallucination_rate": Tolerance(Direction.LOWER_IS_BETTER, 0.01),
    "judge_mean.personalization": Tolerance(Direction.HIGHER_IS_BETTER, 0.3),
    "judge_mean.faithfulness": Tolerance(Direction.HIGHER_IS_BETTER, 0.3),
    "judge_mean.tone": Tolerance(Direction.HIGHER_IS_BETTER, 0.3),
    "judge_mean.actionability": Tolerance(Direction.HIGHER_IS_BETTER, 0.3),
}

# Recorded for the report, deliberately not gated: cost moves for reasons that
# are not quality regressions (a price change, a different model mix), and a
# gate that fires on those trains people to ignore it.
UNGATED_METRICS = ("cost_per_draft_usd", "blocked_rate")


@dataclass(frozen=True)
class Check:
    metric: str
    status: Status
    baseline: float | None
    current: float | None
    tolerance: Tolerance | None

    @property
    def ok(self) -> bool:
        return self.status is Status.OK

    @property
    def delta(self) -> float | None:
        if self.baseline is None or self.current is None:
            return None
        return self.current - self.baseline

    def describe(self) -> str:
        if self.status is Status.NOT_ESTABLISHED:
            return (
                f"{self.metric}: no baseline recorded - the metric has never been "
                f"measured, so there is nothing to regress against"
            )
        if self.status is Status.NOT_MEASURED:
            return (
                f"{self.metric}: baseline is {self.baseline}, but this run did not "
                f"measure it"
            )

        assert self.baseline is not None and self.current is not None
        movement = f"{self.baseline:.4f} -> {self.current:.4f} (delta {self.delta:+.4f}"

        if self.tolerance is None:
            # Recorded, never gated. Still worth printing: a metric nobody
            # gates is exactly the one that drifts unnoticed.
            return f"{self.metric}: {movement}) - reported, no threshold"

        allowed = "-" if self.tolerance.direction is Direction.HIGHER_IS_BETTER else "+"
        verdict = "within tolerance" if self.ok else "REGRESSED"
        return (
            f"{self.metric}: {movement}, allowed {allowed}{self.tolerance.slack:.4f}) "
            f"- {verdict}"
        )


def load_baseline(path: Path = BASELINE_PATH) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(
            f"No baseline at {path}. Record one with:\n"
            f"    uv run python record_baseline.py"
        )
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def flatten_metrics(metrics: Mapping[str, Any]) -> dict[str, float | None]:
    """`{"judge_mean": {"tone": 4.2}}` becomes `{"judge_mean.tone": 4.2}`."""
    flat: dict[str, float | None] = {}
    for key, value in metrics.items():
        if isinstance(value, Mapping):
            for inner_key, inner_value in value.items():
                flat[f"{key}.{inner_key}"] = inner_value
        else:
            flat[key] = value
    return flat


def check_metric(
    metric: str,
    baseline_value: float | None,
    current_value: float | None,
) -> Check:
    tolerance = TOLERANCES.get(metric)

    if baseline_value is None:
        return Check(metric, Status.NOT_ESTABLISHED, None, current_value, tolerance)
    if current_value is None:
        return Check(metric, Status.NOT_MEASURED, baseline_value, None, tolerance)
    if tolerance is None:
        # No threshold: reported, never gated.
        return Check(metric, Status.OK, baseline_value, current_value, None)

    delta = current_value - baseline_value
    if tolerance.direction is Direction.HIGHER_IS_BETTER:
        regressed = delta < -tolerance.slack
    else:
        regressed = delta > tolerance.slack

    return Check(
        metric,
        Status.REGRESSED if regressed else Status.OK,
        baseline_value,
        current_value,
        tolerance,
    )


def compare(
    baseline: Mapping[str, Any],
    current: Mapping[str, Any],
) -> list[Check]:
    """One check per metric the baseline knows about, in a stable order."""
    baseline_flat = flatten_metrics(baseline["metrics"])
    current_flat = flatten_metrics(current)

    metrics = sorted(set(baseline_flat) | set(TOLERANCES))
    return [
        check_metric(metric, baseline_flat.get(metric), current_flat.get(metric))
        for metric in metrics
    ]
