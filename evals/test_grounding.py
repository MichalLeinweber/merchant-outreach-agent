"""The hallucination rate: the share of drafts that failed G05 or G06.

Runs without an API key, against `datasets/drafts.jsonl` — a corpus of drafts
written by hand against the golden merchants, each labelled with the exact set
of gates it is supposed to fail.

**What this measures, and what it does not.** The corpus is written, not
generated, so its hallucination rate is a property of the corpus and not of
any model. What these tests prove is that the *measurement* is right: that
G05 and G06 fire on exactly the drafts designed to trip them and on no others,
and that the rate is computed from those verdicts and nothing else. That is
the part a model-produced number depends on, and it is the part that can be
checked without spending a token.

When a live run records real drafts, the corpus is replaced and the same code
reports a number about the model. Until then the figure in `baseline.json` is
what a correct implementation produces on a fixed corpus, and it should not
move at all — which makes it a tight regression check on the gates themselves.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness import datasets, metrics


def test_corpus_covers_both_grounding_gates(
    draft_corpus: list[datasets.DraftCase],
) -> None:
    """Both failure modes are represented, and so is the clean case."""
    labelled = [gate for draft in draft_corpus for gate in draft.expected_failed_gates]

    assert "G05_evidence_grounding" in labelled, "No draft in the corpus fails G05."
    assert "G06_no_invented_numbers" in labelled, "No draft in the corpus fails G06."
    assert any(
        not draft.expected_failed_gates for draft in draft_corpus
    ), "No draft in the corpus is expected to pass everything."


def test_corpus_contains_a_blocked_draft_that_is_not_a_hallucination(
    draft_corpus: list[datasets.DraftCase],
) -> None:
    """The metric has to distinguish 'broken' from 'untrue'.

    A corpus in which every blocked draft is also a hallucination cannot tell
    the difference between a rate that counts G05/G06 and one that counts any
    blocking failure at all.
    """
    others = [
        draft
        for draft in draft_corpus
        if draft.expected_failed_gates
        and not (draft.expected_failed_gates & metrics.GROUNDING_GATES)
    ]
    assert others, (
        "Every failing draft in the corpus fails a grounding gate, so the "
        "hallucination rate cannot be distinguished from the blocked rate."
    )


@pytest.mark.parametrize(
    "draft",
    datasets.load_drafts(),
    ids=lambda draft: draft.id,
)
def test_draft_fails_exactly_the_gates_it_is_labelled_with(
    draft: datasets.DraftCase,
    corpus_reports: dict[str, dict[str, Any]],
) -> None:
    """Exact set, not a subset.

    'This draft fails G05' leaves room for it to fail four other gates nobody
    noticed, and a corpus like that stops being evidence of anything.
    """
    report = corpus_reports[draft.id]
    actual = metrics.failed_gates(report)

    unexpected = actual - draft.expected_failed_gates
    missing = draft.expected_failed_gates - actual

    details = {
        outcome["gate"]: outcome["detail"]
        for outcome in report["outcomes"]
        if not outcome["passed"]
    }

    assert not unexpected and not missing, (
        f"{draft.id} ({draft.note})\n"
        f"  unexpected failures: {sorted(unexpected) or 'none'}\n"
        f"  expected but passed: {sorted(missing) or 'none'}\n"
        f"  details: {details}"
    )


def test_hallucination_rate_matches_the_labels(
    draft_corpus: list[datasets.DraftCase],
    corpus_reports: dict[str, dict[str, Any]],
) -> None:
    """The rate is the share of drafts the labels call hallucinations."""
    expected_count = sum(
        1 for draft in draft_corpus if draft.expected_failed_gates & metrics.GROUNDING_GATES
    )
    expected_rate = expected_count / len(draft_corpus)

    measured = metrics.hallucination_rate(corpus_reports.values())

    assert measured == pytest.approx(expected_rate), (
        f"Measured hallucination rate {measured:.4f} does not match the "
        f"{expected_count}/{len(draft_corpus)} drafts labelled as hallucinations."
    )


def test_hallucination_rate_ignores_other_blocking_failures(
    draft_corpus: list[datasets.DraftCase],
    corpus_reports: dict[str, dict[str, Any]],
) -> None:
    """A placeholder leak is a broken draft, not an untrue one."""
    blocked = metrics.blocked_rate(corpus_reports.values())
    hallucinated = metrics.hallucination_rate(corpus_reports.values())

    assert hallucinated < blocked, (
        "The corpus contains drafts blocked by gates other than G05 and G06, "
        "so the hallucination rate must be strictly lower than the blocked "
        f"rate. Got hallucinated={hallucinated:.4f}, blocked={blocked:.4f}."
    )


def test_grounding_report(
    draft_corpus: list[datasets.DraftCase],
    corpus_reports: dict[str, dict[str, Any]],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Print the numbers this file exists to produce.

    Not an assertion so much as the reason a human runs the suite: `pytest -s`
    shows the rates, and `record_baseline.py` writes the same ones down.
    """
    reports = list(corpus_reports.values())
    lines = [
        "",
        f"drafts:              {len(reports)}",
        f"hallucination rate:  {metrics.hallucination_rate(reports):.4f}",
        f"gate pass rate:      {metrics.gate_pass_rate(reports):.4f}",
        f"blocked rate:        {metrics.blocked_rate(reports):.4f}",
        "per-gate pass rate:",
    ]
    for gate, rate in metrics.per_gate_pass_rate(reports).items():
        lines.append(f"  {gate:<28} {rate:.4f}")

    with capsys.disabled():
        print("\n".join(lines))
