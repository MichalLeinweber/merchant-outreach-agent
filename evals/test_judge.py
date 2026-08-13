"""The judge, checked without calling a model.

`judge.py` cannot be exercised end to end in CI — that needs an API key, or
recorded responses that only a live run can produce. What can be checked here
is everything around the model call, and it is the part that decides whether a
score means anything: the rubric has the axes EVALS.md specifies, the prompt
parses and renders, a missing fixture fails loudly rather than quietly, and
the calibration set actually points at drafts that exist.

The agreement figure itself is reported by `python judge.py calibrate` and
skipped here until a human fills in `human_scores`.
"""

from __future__ import annotations

import pytest

import judge as judge_module
from harness import datasets
from harness.datasets import RUBRIC_AXES


# ─── The rubric ────────────────────────────────────────────────


def test_rubric_has_the_four_axes_from_the_specification() -> None:
    assert RUBRIC_AXES == ("personalization", "faithfulness", "tone", "actionability")


def test_schema_constrains_every_axis() -> None:
    """The schema is what stops the model answering in prose."""
    schema = judge_module.JUDGE_SCHEMA
    for axis in RUBRIC_AXES:
        assert schema["properties"][axis]["type"] == "integer"
        assert axis in schema["required"]
    assert schema["additionalProperties"] is False
    assert "rationale" in schema["required"], (
        "A score with no rationale cannot be argued with, which makes a "
        "disagreement with the human scores impossible to resolve."
    )


def test_prompt_describes_all_five_points_of_every_axis() -> None:
    """1–5 with a description of what each score means, per EVALS.md.

    A rubric that names the axes without defining the points is a vibe check
    with numbers attached.
    """
    system = judge_module.load_prompt().system
    for axis in RUBRIC_AXES:
        assert axis in system, f"The prompt never mentions the {axis} axis."
    for score in ("5 —", "4 —", "3 —", "2 —", "1 —"):
        assert system.count(score) == len(RUBRIC_AXES), (
            f"Expected a {score.strip(' —')} description for each of the "
            f"{len(RUBRIC_AXES)} axes."
        )


def test_prompt_authoring_notes_are_stripped() -> None:
    """The notes in the file are for whoever edits it, not for the model."""
    template = judge_module.load_prompt()
    assert "<!--" not in template.system and "<!--" not in template.user
    assert "Placeholders:" not in template.system


def test_unknown_placeholder_is_an_error() -> None:
    """A silently blank section still produces confident-looking output."""
    with pytest.raises(judge_module.JudgeError, match="no value supplied"):
        judge_module.render("score {{nothing}}", {})


def test_request_carries_the_merchant_and_the_draft() -> None:
    golden = datasets.load_golden()
    merchants = datasets.merchants_by_id(golden)
    draft_case = next(draft for draft in datasets.load_drafts() if draft.id == "draft_001")
    merchant = merchants[draft_case.merchant_id]

    request = judge_module.build_request(merchant, draft_case.to_draft(merchant))

    assert merchant["name"] in request.user_prompt
    assert draft_case.subject in request.user_prompt
    assert request.model == judge_module.JUDGE_MODEL


def test_fixture_key_changes_with_the_prompt() -> None:
    """A changed rubric must not replay answers to the previous question."""
    base = judge_module.JudgeRequest(
        model=judge_module.JUDGE_MODEL, system="a", user_prompt="b", max_tokens=100
    )
    edited = judge_module.JudgeRequest(
        model=judge_module.JUDGE_MODEL, system="a.", user_prompt="b", max_tokens=100
    )
    assert base.fixture_key() != edited.fixture_key()


# ─── Fixture mode ──────────────────────────────────────────────


def test_missing_fixture_is_a_hard_error_naming_the_command(tmp_path) -> None:
    """No fallback to a live call, and no stub score.

    This is the rule the whole project is built on: when something is missing,
    fail with a message that says what to do about it.
    """
    golden = datasets.load_golden()
    merchants = datasets.merchants_by_id(golden)
    draft_case = datasets.load_drafts()[0]
    merchant = merchants[draft_case.merchant_id]

    judge = judge_module.Judge(mode="fixture", fixture_dir=tmp_path)

    with pytest.raises(judge_module.MissingJudgeFixtureError) as error:
        judge.score(draft_case.id, merchant, draft_case.to_draft(merchant))

    message = str(error.value)
    assert "judge.py calibrate" in message
    assert "--mode record" in message


def test_invalid_mode_is_rejected() -> None:
    with pytest.raises(judge_module.JudgeError):
        judge_module.Judge(mode="cheap")


@pytest.mark.parametrize(
    "text",
    [
        "not json at all",
        '{"personalization": 9, "faithfulness": 4, "tone": 4, "actionability": 4, '
        '"rationale": {"personalization": "x", "faithfulness": "x", "tone": "x", '
        '"actionability": "x"}}',
        '{"personalization": 4, "faithfulness": 4, "tone": 4, "actionability": 4}',
    ],
    ids=["not-json", "score-out-of-range", "no-rationale"],
)
def test_unusable_judge_responses_are_rejected(text: str) -> None:
    """A malformed score is not a low score."""
    with pytest.raises(judge_module.JudgeError):
        judge_module.Judge._parse(text)


# ─── The calibration set ───────────────────────────────────────


def test_calibration_set_has_ten_examples(
    calibration: list[datasets.CalibrationCase],
) -> None:
    """EVALS.md says ten hand-scored examples."""
    assert len(calibration) == 10


def test_calibration_points_at_real_drafts(
    calibration: list[datasets.CalibrationCase],
    draft_corpus: list[datasets.DraftCase],
) -> None:
    known = {draft.id for draft in draft_corpus}
    for case in calibration:
        assert case.draft_id in known, f"{case.id} refers to unknown draft {case.draft_id!r}"


def test_calibration_covers_good_and_bad_drafts(
    calibration: list[datasets.CalibrationCase],
    draft_corpus: list[datasets.DraftCase],
) -> None:
    """A calibration set of ten good drafts calibrates nothing.

    Agreement on cases that are all the same is agreement about the average,
    and it tells you nothing about whether the judge can tell them apart.
    """
    by_id = {draft.id: draft for draft in draft_corpus}
    referenced = [by_id[case.draft_id] for case in calibration]

    clean = [draft for draft in referenced if not draft.expected_failed_gates]
    flawed = [draft for draft in referenced if draft.expected_failed_gates]

    assert len(clean) >= 3, "Fewer than three clean drafts in the calibration set."
    assert len(flawed) >= 3, "Fewer than three flawed drafts in the calibration set."


def test_human_agreement_is_reported(
    calibration: list[datasets.CalibrationCase],
) -> None:
    """The figure EVALS.md asks for in the README.

    Skipped until somebody scores the ten drafts, because an agreement number
    computed from zero comparisons is worse than no number.
    """
    unscored = [case.id for case in calibration if not case.scored]
    if unscored:
        pytest.skip(
            f"{len(unscored)} of {len(calibration)} calibration drafts have no human "
            f"scores yet ({', '.join(unscored[:3])}...). Fill in `human_scores` in "
            f"evals/datasets/calibration.jsonl, then run "
            f"`uv run python judge.py calibrate` for the agreement report."
        )

    report = judge_module.calibrate(judge_module.Judge(mode="fixture"))
    assert report.calibrated
    for axis in RUBRIC_AXES:
        assert report.agreement[axis].n == len(calibration)
