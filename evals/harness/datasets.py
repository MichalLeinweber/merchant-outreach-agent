"""The datasets, and the shapes the pipeline expects them in.

Three files, each holding exactly what a human wrote and nothing derived:

  golden.jsonl       30 merchants covering the edge cases in EVALS.md
  drafts.jsonl       drafts written against those merchants, each labelled
                     with the gates it is supposed to fail
  calibration.jsonl  the ten drafts a human scores by hand, for the judge

`drafts.jsonl` stores only the parts of a draft a person writes — subject,
body, evidence. The identity and accounting fields (`id`, `campaignId`,
`model`, `usage`, `createdAt`) are assembled here, because they are the same
for every case and repeating them 20 times in the dataset would be 20 chances
to get one wrong.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DATASETS_DIR = Path(__file__).resolve().parents[1] / "datasets"

GOLDEN_PATH = DATASETS_DIR / "golden.jsonl"
DRAFTS_PATH = DATASETS_DIR / "drafts.jsonl"
CALIBRATION_PATH = DATASETS_DIR / "calibration.jsonl"

CAMPAIGN_ID = "eval_ws6"

# The instant every eval is evaluated at.
#
# Fixed rather than read from the clock: the frequency cap and the seasonal
# signal both depend on "now", and a suite whose result changes in November is
# a suite nobody can bisect. It matches the gate service's own test fixtures,
# so a draft that passes there passes here.
EVAL_NOW = "2026-08-12T09:00:00.000Z"

# What a draft written by this campaign would have cost. Not measured — the
# corpus is hand-written — and used only to give G01 a well-formed usage
# object to check. Cost metrics come from the live run, never from here.
PLACEHOLDER_USAGE = {
    "inputTokens": 2310,
    "outputTokens": 402,
    "cachedInputTokens": 1760,
    "costUsd": 0.011,
}

DRAFT_MODEL = "claude-sonnet-5"

# The four rubric axes from EVALS.md, in the order the report prints them.
RUBRIC_AXES = ("personalization", "faithfulness", "tone", "actionability")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise FileNotFoundError(f"Dataset missing: {path}")

    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"{path.name} line {number} is not valid JSON: {error}") from error
    return rows


# ─── Golden set ────────────────────────────────────────────────


@dataclass(frozen=True)
class GoldenCase:
    """One merchant, with the label a human gives it and why it is here."""

    id: str
    edge_case: str
    # Empty until a human labels it: "pursue", "skip" or "needs_human".
    expected_bucket: str
    note: str
    merchant: dict[str, Any]

    @property
    def labelled(self) -> bool:
        return self.expected_bucket.strip() != ""


def load_golden() -> list[GoldenCase]:
    return [
        GoldenCase(
            id=row["id"],
            edge_case=row["edge_case"],
            expected_bucket=row.get("expected_bucket", ""),
            note=row["note"],
            merchant=row["merchant"],
        )
        for row in _read_jsonl(GOLDEN_PATH)
    ]


# ─── Draft corpus ──────────────────────────────────────────────


@dataclass(frozen=True)
class DraftCase:
    """A draft, and the exact set of gates it is expected to fail.

    The set is exact rather than a minimum. "This draft fails G05" leaves room
    for it to fail four other gates nobody noticed, and a corpus like that
    stops being evidence of anything.
    """

    id: str
    merchant_id: str
    note: str
    expected_failed_gates: frozenset[str]
    subject: str
    body: str
    evidence: list[dict[str, str]]

    def to_draft(self, merchant: dict[str, Any]) -> dict[str, Any]:
        """The `OutreachDraft` the gates receive."""
        return {
            "id": self.id,
            "merchantId": merchant["id"],
            "campaignId": CAMPAIGN_ID,
            "locale": merchant["locale"],
            "subject": self.subject,
            "body": self.body,
            "evidence": self.evidence,
            "model": DRAFT_MODEL,
            "usage": dict(PLACEHOLDER_USAGE),
            "createdAt": EVAL_NOW,
        }


def load_drafts() -> list[DraftCase]:
    return [
        DraftCase(
            id=row["id"],
            merchant_id=row["merchant_id"],
            note=row["note"],
            expected_failed_gates=frozenset(row["expected_failed_gates"]),
            subject=row["subject"],
            body=row["body"],
            evidence=row["evidence"],
        )
        for row in _read_jsonl(DRAFTS_PATH)
    ]


# ─── Judge calibration ─────────────────────────────────────────


@dataclass(frozen=True)
class CalibrationCase:
    """A draft a human scores by hand, so the judge can be checked against it."""

    id: str
    draft_id: str
    note: str
    # One entry per rubric axis; None until a human fills it in.
    human_scores: dict[str, int | None]

    @property
    def scored(self) -> bool:
        return all(self.human_scores.get(axis) is not None for axis in RUBRIC_AXES)


def load_calibration() -> list[CalibrationCase]:
    return [
        CalibrationCase(
            id=row["id"],
            draft_id=row["draft_id"],
            note=row["note"],
            human_scores={axis: row["human_scores"].get(axis) for axis in RUBRIC_AXES},
        )
        for row in _read_jsonl(CALIBRATION_PATH)
    ]


# ─── Joining them up ───────────────────────────────────────────


def merchants_by_id(golden: list[GoldenCase]) -> dict[str, dict[str, Any]]:
    return {case.id: case.merchant for case in golden}


def gate_context(**overrides: Any) -> dict[str, Any]:
    """The `GateContext` the gates are run with.

    The defaults mirror `makeGateContext` on the TypeScript side. They are
    restated rather than fetched so that a test can build a context without a
    subprocess; `test_gates.py` asserts they still agree with the source.
    """
    context = {
        "now": EVAL_NOW,
        "frequencyCapDays": 30,
        "previousApproach": None,
        "allowedLinkHosts": ["partners.example.invalid"],
    }
    context.update(overrides)
    return context


def build_gate_cases(
    drafts: list[DraftCase],
    merchants: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Every draft in the corpus, as a case the bridge can run."""
    cases = []
    for draft in drafts:
        merchant = merchants.get(draft.merchant_id)
        if merchant is None:
            raise ValueError(
                f"{draft.id} names merchant {draft.merchant_id!r}, which is not "
                f"in golden.jsonl."
            )
        cases.append(
            {
                "id": draft.id,
                "draft": draft.to_draft(merchant),
                "merchant": merchant,
                "context": gate_context(),
            }
        )
    return cases
