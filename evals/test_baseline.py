"""The regression gate: this is the file that fails a build.

Every other file in the suite reports. This one compares what was measured
against `evals/baseline.json` and fails when a metric has moved further than
the tolerance EVALS.md sets:

    triage accuracy      more than 3 percentage points down
    gate pass rate       more than 3 percentage points down
    hallucination rate   more than 1 percentage point up
    judge score          more than 0.3 down on any axis

A metric with no baseline recorded is reported as a skip naming the command
that would establish it — never as a pass. "We have no baseline" and "nothing
regressed" are different statements, and a gate that cannot tell them apart is
a gate that fires only when somebody remembers to look.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness import baseline as baseline_module
from harness import datasets, report

METRIC_NAMES = sorted(baseline_module.TOLERANCES)


@pytest.fixture(scope="module")
def recorded_baseline() -> dict[str, Any]:
    return baseline_module.load_baseline()


@pytest.fixture(scope="module")
def measured(
    corpus_reports: dict[str, dict[str, Any]],
    golden: list[datasets.GoldenCase],
) -> dict[str, Any]:
    """This run's numbers, from the same code that recorded the baseline."""
    return report.collect(list(corpus_reports.values()), golden).values


def test_baseline_records_what_it_measured(recorded_baseline: dict[str, Any]) -> None:
    """A baseline without provenance is a number somebody typed."""
    assert recorded_baseline["recorded_at"], "The baseline does not say when it was recorded."
    assert "metrics" in recorded_baseline
    corpus = recorded_baseline.get("corpus", {})
    assert corpus.get("drafts"), "The baseline does not say how many drafts it measured."


def test_baseline_corpus_size_still_matches(
    recorded_baseline: dict[str, Any],
    corpus_reports: dict[str, dict[str, Any]],
    golden: list[datasets.GoldenCase],
) -> None:
    """A rate measured over a different corpus is not comparable.

    Adding drafts to the corpus moves every rate legitimately, and comparing
    the new rate against the old baseline would report that as a regression.
    Changing the corpus means recording a new baseline in the same commit.
    """
    corpus = recorded_baseline["corpus"]
    assert corpus["drafts"] == len(corpus_reports), (
        f"The baseline was recorded over {corpus['drafts']} drafts and this run "
        f"measured {len(corpus_reports)}. Re-record it with "
        f"`uv run python record_baseline.py --write` and explain the move."
    )
    assert corpus["golden_merchants"] == len(golden)


@pytest.mark.parametrize("metric", METRIC_NAMES)
def test_metric_has_not_regressed(
    metric: str,
    recorded_baseline: dict[str, Any],
    measured: dict[str, Any],
) -> None:
    """One test per metric, so a failure names the metric that moved."""
    baseline_flat = baseline_module.flatten_metrics(recorded_baseline["metrics"])
    current_flat = baseline_module.flatten_metrics(measured)

    check = baseline_module.check_metric(
        metric, baseline_flat.get(metric), current_flat.get(metric)
    )

    if check.status is baseline_module.Status.NOT_ESTABLISHED:
        reason = recorded_baseline.get("unavailable", {}).get(metric.split(".")[0], "")
        pytest.skip(
            f"{metric}: no baseline recorded"
            + (f" - {reason}" if reason else "")
            + ". Record one with `uv run python record_baseline.py --write`."
        )

    if check.status is baseline_module.Status.NOT_MEASURED:
        pytest.fail(
            f"{metric}: the baseline records {check.baseline}, but this run could "
            f"not measure it. A metric that stops being measured is a gate that "
            f"stopped firing."
        )

    assert check.ok, check.describe()


def test_regression_report(
    recorded_baseline: dict[str, Any],
    measured: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Print the whole comparison, including the metrics with no threshold."""
    checks = baseline_module.compare(recorded_baseline, measured)

    with capsys.disabled():
        print(f"\nbaseline recorded {recorded_baseline['recorded_at']}", end="")
        if recorded_baseline.get("commit"):
            print(f" at {recorded_baseline['commit']}", end="")
        print()
        for check in checks:
            print(f"  {check.describe()}")

    regressions = [check for check in checks if check.status is baseline_module.Status.REGRESSED]
    assert not regressions, "\n".join(check.describe() for check in regressions)
