"""The metrics, defined once.

Every number the suite reports — and every number the regression gate compares
against `baseline.json` — is computed here. Two tests that both mention the
hallucination rate have to mean the same thing by it, or the baseline is
comparing two different quantities and calling the difference a regression.

Each definition is written out in prose next to the code, because the
definition is the part that gets argued about.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

# The two gates that make a draft a hallucination rather than merely a bad
# draft: a claim that cannot be traced to the record (G05) and a number the
# record does not contain (G06).
GROUNDING_GATES = frozenset({"G05_evidence_grounding", "G06_no_invented_numbers"})


# ─── Reading a gate report ─────────────────────────────────────


def failed_gates(report: Mapping[str, Any]) -> frozenset[str]:
    """Every gate that failed, blocking or warning."""
    return frozenset(
        outcome["gate"] for outcome in report["outcomes"] if not outcome["passed"]
    )


def failed_blocking_gates(report: Mapping[str, Any]) -> frozenset[str]:
    return frozenset(
        outcome["gate"]
        for outcome in report["outcomes"]
        if not outcome["passed"] and outcome["severity"] == "blocking"
    )


def outcome_for(report: Mapping[str, Any], gate: str) -> Mapping[str, Any]:
    for outcome in report["outcomes"]:
        if outcome["gate"] == gate:
            return outcome
    raise KeyError(f"No outcome for gate {gate!r} in report {report.get('draftId')!r}")


# ─── Corpus-level gate metrics ─────────────────────────────────


def hallucination_rate(reports: Iterable[Mapping[str, Any]]) -> float:
    """Share of drafts that failed G05 or G06.

    Per draft, not per claim: a draft with three invented numbers is one
    hallucinated draft, because one is all it takes to reach a merchant.
    Drafts blocked by any other gate do not count — an unfilled placeholder is
    a broken draft, not an untrue one.
    """
    reports = list(reports)
    if not reports:
        return 0.0
    hallucinated = sum(1 for report in reports if failed_gates(report) & GROUNDING_GATES)
    return hallucinated / len(reports)


def gate_pass_rate(reports: Iterable[Mapping[str, Any]]) -> float:
    """Share of individual gate outcomes that passed.

    Every gate against every draft, counted flat: thirteen gates over twenty
    drafts is 260 outcomes. Not the share of drafts that passed everything —
    that is `blocked_rate` below, and conflating the two makes a single
    catastrophic draft look like a broad quality decline.
    """
    total = 0
    passed = 0
    for report in reports:
        for outcome in report["outcomes"]:
            total += 1
            passed += 1 if outcome["passed"] else 0
    return passed / total if total else 0.0


def blocked_rate(reports: Iterable[Mapping[str, Any]]) -> float:
    """Share of drafts a blocking gate stopped."""
    reports = list(reports)
    if not reports:
        return 0.0
    return sum(1 for report in reports if report["blocked"]) / len(reports)


def per_gate_pass_rate(reports: Iterable[Mapping[str, Any]]) -> dict[str, float]:
    """Pass rate for each gate on its own, for the report a human reads."""
    seen: dict[str, list[bool]] = {}
    for report in reports:
        for outcome in report["outcomes"]:
            seen.setdefault(outcome["gate"], []).append(bool(outcome["passed"]))
    return {gate: sum(results) / len(results) for gate, results in sorted(seen.items())}


# ─── Triage ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClassificationMetrics:
    """Agreement with the golden set, plus precision and recall for one bucket."""

    total: int
    correct: int
    accuracy: float
    positive_label: str
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float

    def summary(self) -> str:
        return (
            f"accuracy {self.accuracy:.3f} ({self.correct}/{self.total}), "
            f"{self.positive_label}: precision {self.precision:.3f}, "
            f"recall {self.recall:.3f}, f1 {self.f1:.3f}"
        )


def classification_metrics(
    expected: Mapping[str, str],
    predicted: Mapping[str, str],
    *,
    positive_label: str = "pursue",
) -> ClassificationMetrics:
    """Compare predicted buckets against the labelled ones.

    Only ids present in both are scored, and the caller is expected to have
    checked which ones those are: silently scoring 4 of 30 merchants and
    reporting an accuracy is how a suite reports a number that means nothing.

    Precision and recall are reported for `pursue` specifically because the two
    mistakes cost differently. A false `pursue` sends a real email to a real
    merchant. A false `skip` merely misses an opportunity. One accuracy figure
    hides which of those the change made more of.
    """
    ids = [key for key in expected if key in predicted]
    total = len(ids)
    correct = sum(1 for key in ids if expected[key] == predicted[key])

    true_positives = sum(
        1 for key in ids if predicted[key] == positive_label and expected[key] == positive_label
    )
    false_positives = sum(
        1 for key in ids if predicted[key] == positive_label and expected[key] != positive_label
    )
    false_negatives = sum(
        1 for key in ids if predicted[key] != positive_label and expected[key] == positive_label
    )

    precision = (
        true_positives / (true_positives + false_positives)
        if (true_positives + false_positives)
        else 0.0
    )
    recall = (
        true_positives / (true_positives + false_negatives)
        if (true_positives + false_negatives)
        else 0.0
    )
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    return ClassificationMetrics(
        total=total,
        correct=correct,
        accuracy=correct / total if total else 0.0,
        positive_label=positive_label,
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=precision,
        recall=recall,
        f1=f1,
    )


# ─── Judge ─────────────────────────────────────────────────────


def mean_scores(
    scores: Sequence[Mapping[str, float]],
    axes: Sequence[str],
) -> dict[str, float]:
    """Mean judge score per axis."""
    if not scores:
        return {axis: 0.0 for axis in axes}
    return {
        axis: sum(float(entry[axis]) for entry in scores) / len(scores) for axis in axes
    }


@dataclass(frozen=True)
class AxisAgreement:
    axis: str
    n: int
    exact: float
    within_one: float
    mean_absolute_error: float


def judge_agreement(
    pairs: Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]],
    axes: Sequence[str],
) -> dict[str, AxisAgreement]:
    """How closely the judge matched the human scores, per axis.

    Three numbers rather than one, because a single "agreement" percentage
    hides the shape of the disagreement:

      exact                 identical score
      within_one            off by at most one point — on a 1–5 rubric two
                            careful humans disagree by one routinely, so this
                            is the figure worth quoting
      mean_absolute_error   how far off it is when it is off

    A judge that scores everything 4 can look agreeable on `within_one` while
    carrying no information at all, which is why the mean scores are reported
    next to this and not instead of it.
    """
    result: dict[str, AxisAgreement] = {}

    for axis in axes:
        deltas = [
            abs(float(judge[axis]) - float(human[axis]))
            for judge, human in pairs
            if judge.get(axis) is not None and human.get(axis) is not None
        ]
        count = len(deltas)
        result[axis] = AxisAgreement(
            axis=axis,
            n=count,
            exact=sum(1 for delta in deltas if delta == 0) / count if count else 0.0,
            within_one=sum(1 for delta in deltas if delta <= 1) / count if count else 0.0,
            mean_absolute_error=sum(deltas) / count if count else 0.0,
        )

    return result
