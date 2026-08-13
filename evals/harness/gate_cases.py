"""One passing case and one failing case for every gate.

Every scenario starts from the same draft — `PASSING_BODY` from the gate
service's own fixtures, the one body in the repository known to pass all
thirteen gates — and breaks exactly one thing. That is what makes a failing
assertion name the defect rather than some unrelated property of a body
written for the occasion, and it is why the sample is fetched from the bridge
instead of being copied into Python: a copy would drift the first time
somebody edits the fixture.

Where a gate has a boundary, the passing case sits on it rather than
comfortably inside it. A cap that is only tested at 5 days and 90 days says
nothing about what it does at exactly 30.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

Mutation = Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], None]


@dataclass(frozen=True)
class GateScenario:
    """One case: a mutation, the gate it targets, and the outcome expected."""

    gate: str
    name: str
    should_pass: bool
    why: str
    mutate: Mutation

    @property
    def id(self) -> str:
        return f"{self.gate}:{self.name}"


def _noop(draft: dict[str, Any], merchant: dict[str, Any], context: dict[str, Any]) -> None:
    """The untouched sample. Used for the passing case of most gates."""


def _replace_in_body(find: str, replace: str) -> Mutation:
    def mutate(draft: dict[str, Any], merchant: dict[str, Any], context: dict[str, Any]) -> None:
        if find not in draft["body"]:
            raise AssertionError(
                f"The sample body no longer contains {find!r}, so this scenario "
                f"is not testing what it says it is. Update evals/harness/"
                f"gate_cases.py against services/gates/test-helpers.ts."
            )
        draft["body"] = draft["body"].replace(find, replace, 1)

    return mutate


# ─── The scenarios ─────────────────────────────────────────────

SCENARIOS: list[GateScenario] = [
    # G01 — the draft is a well-formed OutreachDraft.
    GateScenario(
        "G01_schema",
        "well_formed",
        True,
        "The sample draft matches the contract.",
        _noop,
    ),
    GateScenario(
        "G01_schema",
        "usage_missing",
        False,
        "A draft that came through a JSON parse can be missing `usage` while "
        "still being typed as a draft. G01 is what makes the parse a checked "
        "statement rather than an assumed one.",
        lambda draft, merchant, context: draft.__setitem__("usage", None),
    ),
    # G02 — subject at most 60 characters, body 60–180 words.
    GateScenario(
        "G02_length",
        "subject_exactly_at_limit",
        True,
        "Sixty characters is allowed; the limit is inclusive.",
        lambda draft, merchant, context: draft.__setitem__("subject", "x" * 60),
    ),
    GateScenario(
        "G02_length",
        "subject_one_over_limit",
        False,
        "Sixty-one is not.",
        lambda draft, merchant, context: draft.__setitem__("subject", "x" * 61),
    ),
    # G03 — nothing left to fill in.
    GateScenario(
        "G03_placeholders",
        "no_placeholders",
        True,
        "Ordinary prose, nothing bracketed.",
        _noop,
    ),
    GateScenario(
        "G03_placeholders",
        "unfilled_name_token",
        False,
        "The template marker that survives to the recipient.",
        _replace_in_body("Hi there,", "Hi [FIRST_NAME],"),
    ),
    # G04 — the merchant's name, spelled as the record spells it.
    GateScenario(
        "G04_merchant_name",
        "exact_name",
        True,
        "The body names the merchant character for character.",
        _noop,
    ),
    GateScenario(
        "G04_merchant_name",
        "wrong_capitalisation",
        False,
        "Nearly right is the specific thing an owner notices.",
        _replace_in_body("Lumen Coffee House", "lumen coffee house"),
    ),
    # G05 — every claim quoted from the body and sourced from the record.
    GateScenario(
        "G05_evidence_grounding",
        "claims_traceable",
        True,
        "Three claims, each quoted from the body, each citing a field that "
        "really holds that value.",
        _noop,
    ),
    GateScenario(
        "G05_evidence_grounding",
        "source_value_overstated",
        False,
        "The claim is quoted correctly and cites 5.0 for a merchant rated 4.8. "
        "The evidence looks complete, which is what makes this the dangerous "
        "half of G05.",
        lambda draft, merchant, context: draft["evidence"][0].__setitem__("sourceValue", "5.0"),
    ),
    # G06 — every number in the body is in the record.
    GateScenario(
        "G06_no_invented_numbers",
        "every_number_grounded",
        True,
        "4.8, 62 and 40 are all on the record.",
        _noop,
    ),
    GateScenario(
        "G06_no_invented_numbers",
        "uncited_invented_number",
        False,
        "A number that appears in the prose without ever being declared as "
        "evidence. G05 cannot see it; that is why G06 reads the body.",
        _replace_in_body("With 40 covers", "With 40 covers and 118 seats"),
    ),
    # G07 — claims the marketplace does not make.
    GateScenario(
        "G07_banned_claims",
        "sign_off_is_not_a_superlative",
        True,
        "'Best regards' is not a claim about the merchant, and a gate that "
        "failed every polite email would be switched off inside a day.",
        _noop,
    ),
    GateScenario(
        "G07_banned_claims",
        "guarantee",
        False,
        "Outreach describes reach, not outcomes.",
        _replace_in_body("the easiest way", "the guaranteed way"),
    ),
    # G08 — no contact data the record does not hold.
    GateScenario(
        "G08_pii",
        "no_extra_contact_data",
        True,
        "The body points at a link without printing one.",
        _noop,
    ),
    GateScenario(
        "G08_pii",
        "invented_mailbox",
        False,
        "An address that is neither the merchant's nor the campaign's leaves "
        "the model as its only possible source.",
        _replace_in_body("using the link below", "by writing to hello@rival.example.test"),
    ),
    # G09 — written in the language and register the locale names.
    GateScenario(
        "G09_locale",
        "british_spelling_for_en_gb",
        True,
        "en-GB body in en-GB house style.",
        _noop,
    ),
    GateScenario(
        "G09_locale",
        "us_spelling_in_en_gb",
        False,
        "The visible edge of a model that has drifted to a different register.",
        _replace_in_body("your weekend pricing", "your favorite weekend pricing"),
    ),
    # G10 — exactly one call to action. Warning, not blocking.
    GateScenario(
        "G10_single_cta",
        "one_ask",
        True,
        "One ask through one mechanism. The link is not counted separately.",
        _noop,
    ),
    GateScenario(
        "G10_single_cta",
        "two_different_asks",
        False,
        "Reply *and* book a slot is the ambiguity that costs a reply.",
        _replace_in_body(
            "you can register your interest using the link below",
            "you can reply to this email or book a call using the link below",
        ),
    ),
    # G11 — the frequency cap. The only gate that reads the context.
    GateScenario(
        "G11_frequency_cap",
        "exactly_at_the_cap",
        True,
        "Thirty days is thirty days: the boundary itself passes, and it is the "
        "only value where anybody has to think about it.",
        lambda draft, merchant, context: context.__setitem__(
            "previousApproach",
            {"campaignId": "cmp_2026w28_uk", "sentAt": "2026-07-13T09:00:00.000Z"},
        ),
    ),
    GateScenario(
        "G11_frequency_cap",
        "one_day_inside_the_cap",
        False,
        "Twenty-nine days is not.",
        lambda draft, merchant, context: context.__setitem__(
            "previousApproach",
            {"campaignId": "cmp_2026w28_uk", "sentAt": "2026-07-14T09:00:00.000Z"},
        ),
    ),
    # G12 — reads as professional correspondence.
    GateScenario(
        "G12_compliance",
        "no_urgency_language",
        True,
        "A first-contact email with nothing to hurry the reader.",
        _noop,
    ),
    GateScenario(
        "G12_compliance",
        "scarcity_language",
        False,
        "Urgency is regulated in several of the markets this campaign runs in.",
        _replace_in_body("Best regards,", "Don't miss out.\n\nBest regards,"),
    ),
    # G13 — the claim count. This service's own gate, and a warning.
    GateScenario(
        "G13_claim_count",
        "exactly_three_claims",
        True,
        "What the draft prompt asks for.",
        _noop,
    ),
    GateScenario(
        "G13_claim_count",
        "two_claims",
        False,
        "A draft with one claim and a paragraph of filler used to pass every "
        "gate, because every gate that looked at claims looked at whether the "
        "ones present were true.",
        lambda draft, merchant, context: draft.__setitem__("evidence", draft["evidence"][:2]),
    ),
]


def build_cases(sample: dict[str, Any]) -> list[dict[str, Any]]:
    """Turn the scenarios into cases the bridge can run."""
    cases = []
    for scenario in SCENARIOS:
        draft = copy.deepcopy(sample["draft"])
        merchant = copy.deepcopy(sample["merchant"])
        context = copy.deepcopy(sample["context"])
        scenario.mutate(draft, merchant, context)
        cases.append(
            {"id": scenario.id, "draft": draft, "merchant": merchant, "context": context}
        )
    return cases
