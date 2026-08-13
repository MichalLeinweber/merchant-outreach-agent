"""Triage against the golden set: agreement, and precision and recall for `pursue`.

Two halves, and they fail differently.

The first half checks the dataset itself — thirty merchants, unique ids,
synthetic contact addresses, and every edge case EVALS.md asks for actually
present. That runs everywhere, always, and needs nothing.

The second half runs the real triage agent over those merchants and compares
its answers to the labels. It needs two things this repository does not yet
have: a human's `expected_bucket` on each golden case, and a recorded model
response for each merchant. Both are missing on purpose — labelling is a
person's job, and recording costs money and an API key. Where they are
missing the tests **skip with a message naming the command that fixes it**,
rather than passing quietly on nothing.

In CI this file runs in `fixture` mode. It never calls a model.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness import bridge, datasets, metrics

# The edge cases EVALS.md requires the golden set to contain. The tags are the
# `edge_case` field in golden.jsonl.
REQUIRED_EDGE_CASES = {
    "no_material": "a merchant with no website and no rating",
    "high_rating_low_volume": "a high rating on very few reviews",
    "non_default_locale": "a locale other than the default",
    "category_edge": "a category at the edge of what the marketplace should carry",
    "active_offer": "a merchant already running an offer, which should be skipped",
    "diacritics": "a name with diacritics and special characters",
}

VALID_BUCKETS = {"pursue", "skip", "needs_human"}

RECORD_COMMAND = (
    "ANTHROPIC_API_KEY=... uv run python record_triage_fixtures.py\n"
    "  (or run the `Evals (live)` workflow, which does it with a cost cap)"
)


# ─── The dataset ───────────────────────────────────────────────


def test_golden_set_has_thirty_merchants(golden: list[datasets.GoldenCase]) -> None:
    """EVALS.md says thirty. Fewer is a weaker claim; more is a slower run."""
    assert len(golden) == 30


def test_golden_ids_are_unique(golden: list[datasets.GoldenCase]) -> None:
    ids = [case.id for case in golden]
    assert len(set(ids)) == len(ids), "Duplicate ids in golden.jsonl"


def test_golden_merchant_ids_match_case_ids(golden: list[datasets.GoldenCase]) -> None:
    """The case and the merchant it holds are the same thing under one id."""
    for case in golden:
        assert case.merchant["id"] == case.id


def test_every_contact_address_is_synthetic(golden: list[datasets.GoldenCase]) -> None:
    """The database enforces this with a constraint; the dataset has to obey it too."""
    for case in golden:
        assert case.merchant["contactEmail"].endswith("@example.invalid"), (
            f"{case.id} has a contact address outside example.invalid, which the "
            f"merchants_email_synthetic constraint would reject."
        )


def test_every_website_is_synthetic(golden: list[datasets.GoldenCase]) -> None:
    for case in golden:
        website = case.merchant["websiteUrl"]
        if website is not None:
            assert ".example.invalid" in website, f"{case.id} points at a real-looking host"


def test_locale_and_country_agree(golden: list[datasets.GoldenCase]) -> None:
    """A record whose locale contradicts its country is a defect in the dataset,
    not a hard case for the model."""
    for case in golden:
        locale = case.merchant["locale"]
        region = locale.split("-")[1]
        assert region == case.merchant["countryCode"], (
            f"{case.id}: locale {locale!r} and countryCode "
            f"{case.merchant['countryCode']!r} disagree"
        )


@pytest.mark.parametrize(
    ("tag", "description"),
    sorted(REQUIRED_EDGE_CASES.items()),
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_edge_case_is_present(
    tag: str, description: str, golden: list[datasets.GoldenCase]
) -> None:
    """Every edge case EVALS.md lists is actually in the set.

    'Thirty merchants' is easy. Thirty merchants that include the ones the
    model gets wrong is the thing being claimed.
    """
    present = [case.id for case in golden if case.edge_case == tag]
    assert present, f"The golden set contains no case tagged {tag!r} ({description})."


def test_labels_are_valid_buckets(golden: list[datasets.GoldenCase]) -> None:
    """An empty label means 'not labelled yet'. Anything else has to be a bucket."""
    for case in golden:
        if case.labelled:
            assert case.expected_bucket in VALID_BUCKETS, (
                f"{case.id}: expected_bucket {case.expected_bucket!r} is not one of "
                f"{sorted(VALID_BUCKETS)}"
            )


# ─── The agent ─────────────────────────────────────────────────


@pytest.fixture(scope="module")
def triage_run(golden: list[datasets.GoldenCase]) -> dict[str, Any]:
    """Run triage over the golden set in fixture mode.

    Never calls a model: `LLM_MODE` is `fixture`, and a merchant with no
    recorded response comes back as a failed entry rather than a live call.
    """
    return bridge.run_triage(
        [case.merchant for case in golden],
        now=datasets.EVAL_NOW,
        mode="fixture",
    )


def _labelled(golden: list[datasets.GoldenCase]) -> list[datasets.GoldenCase]:
    return [case for case in golden if case.labelled]


def _require_labels(golden: list[datasets.GoldenCase]) -> list[datasets.GoldenCase]:
    labelled = _labelled(golden)
    if not labelled:
        pytest.skip(
            f"None of the {len(golden)} golden merchants has an expected_bucket yet. "
            f"Fill in the `expected_bucket` field in evals/datasets/golden.jsonl "
            f"(one of: {', '.join(sorted(VALID_BUCKETS))}) - the accuracy figure is "
            f"meaningless until a human has said what the right answer is."
        )
    return labelled


def _require_fixtures(triage_run: dict[str, Any], ids: list[str]) -> dict[str, str]:
    """Predicted buckets, or a skip naming the merchants with no recorded response."""
    by_id = {entry["merchantId"]: entry for entry in triage_run["results"]}

    missing = [
        merchant_id
        for merchant_id in ids
        if not by_id.get(merchant_id, {}).get("ok")
        and by_id.get(merchant_id, {}).get("error", {}).get("code") == "MISSING_FIXTURE"
    ]
    if missing:
        pytest.skip(
            f"{len(missing)} of {len(ids)} golden merchants have no recorded triage "
            f"response, so the model cannot be replayed offline: "
            f"{', '.join(missing[:5])}{'...' if len(missing) > 5 else ''}\n"
            f"Record them with:\n    {RECORD_COMMAND}"
        )

    failed = [
        (merchant_id, by_id[merchant_id]["error"])
        for merchant_id in ids
        if merchant_id in by_id and not by_id[merchant_id]["ok"]
    ]
    assert not failed, f"Triage failed for reasons other than a missing fixture: {failed}"

    return {
        merchant_id: by_id[merchant_id]["result"]["recommendedAction"] for merchant_id in ids
    }


def test_triage_ran_offline(triage_run: dict[str, Any]) -> None:
    """Whatever else happened, no money was spent.

    This one does not skip. It is the assertion that keeps the promise in
    EVALS.md — that this file runs in CI against recorded responses — and it
    holds whether or not any fixture exists.
    """
    assert triage_run["spentUsd"] == 0, (
        "A run in fixture mode reported spend, which means it reached a model."
    )


def test_triage_agreement_with_the_golden_set(
    golden: list[datasets.GoldenCase],
    triage_run: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Accuracy against the labels, with precision and recall for `pursue`."""
    labelled = _require_labels(golden)
    expected = {case.id: case.expected_bucket for case in labelled}
    predicted = _require_fixtures(triage_run, list(expected))

    result = metrics.classification_metrics(expected, predicted, positive_label="pursue")

    disagreements = [
        f"  {case_id}: expected {expected[case_id]}, got {predicted[case_id]}"
        for case_id in expected
        if expected[case_id] != predicted[case_id]
    ]

    with capsys.disabled():
        print(f"\ntriage: {result.summary()}")
        if disagreements:
            print("disagreements:")
            print("\n".join(disagreements))

    # The threshold lives in baseline.json, not here: this test reports, and
    # test_baseline.py is the one that fails a build. Splitting them means a
    # deliberate baseline move is one reviewed commit rather than an edit
    # buried in a test file.
    assert result.total == len(expected)


def test_merchants_with_an_active_offer_are_not_pursued(
    golden: list[datasets.GoldenCase],
    triage_run: dict[str, Any],
) -> None:
    """The one triage rule that is not a matter of degree.

    A merchant already running an offer competes with their own live listing.
    This is checked separately from accuracy because it is the mistake with a
    cost attached, and an aggregate figure can absorb it.
    """
    active = [case for case in golden if case.merchant["hasActiveOffer"]]
    assert active, "The golden set has no merchant with an active offer."

    predicted = _require_fixtures(triage_run, [case.id for case in active])

    wrong = {
        merchant_id: bucket
        for merchant_id, bucket in predicted.items()
        if bucket == "pursue"
    }
    assert not wrong, f"Triage recommended pursuing merchants with a live offer: {wrong}"
