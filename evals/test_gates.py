"""Every gate, positively and negatively.

Runs without an API key and without a database: the gates are pure functions
over a draft, a merchant record and a context, which is the property that lets
this file exist at all. What it does need is Node, because it runs the real
gates rather than a Python restatement of them — see `harness/bridge.py`.

Two things are checked beyond "the gate fired":

  * the severity table matches EVALS.md, which is the specification. A gate
    silently demoted from blocking to warning would otherwise keep passing
    its own tests while no longer stopping anything.
  * a failing gate says why. An outcome with `passed: false` and an empty
    `detail` is a dead end for whoever has to fix the draft.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness import metrics
from harness.gate_cases import SCENARIOS

# The table in EVALS.md, restated. This is the specification, and the point of
# writing it out again is that the two can disagree — if the implementation
# changes severity, this test is what notices.
EXPECTED_SEVERITY = {
    "G01_schema": "blocking",
    "G02_length": "blocking",
    "G03_placeholders": "blocking",
    "G04_merchant_name": "blocking",
    "G05_evidence_grounding": "blocking",
    "G06_no_invented_numbers": "blocking",
    "G07_banned_claims": "blocking",
    "G08_pii": "blocking",
    "G09_locale": "blocking",
    "G10_single_cta": "warning",
    "G11_frequency_cap": "blocking",
    "G12_compliance": "blocking",
    # G13 is this service's own addition, not in EVALS.md. It warns, because
    # an empty evidence array is the correct answer for a merchant with
    # nothing worth quoting.
    "G13_claim_count": "warning",
}


def test_every_gate_in_the_specification_exists(meta: dict[str, Any]) -> None:
    """The twelve gates EVALS.md names are all implemented and all run."""
    implemented = set(meta["gateOrder"])
    missing = set(EXPECTED_SEVERITY) - implemented
    assert not missing, f"Gates in the specification that no code runs: {sorted(missing)}"

    unspecified = implemented - set(EXPECTED_SEVERITY)
    assert not unspecified, (
        f"Gates that run but are in neither EVALS.md nor this table: "
        f"{sorted(unspecified)}. Add them here with their severity."
    )


def test_severity_matches_the_specification(meta: dict[str, Any]) -> None:
    """Blocking stays blocking. Demotion is the change nobody announces."""
    assert meta["gateSeverity"] == EXPECTED_SEVERITY


def test_limits_match_the_specification(meta: dict[str, Any]) -> None:
    """G02's numbers are in EVALS.md; the gate is where they are enforced."""
    limits = meta["limits"]
    assert limits["subjectMaxLength"] == 60
    assert limits["bodyMinWords"] == 60
    assert limits["bodyMaxWords"] == 180


def test_every_gate_has_both_a_positive_and_a_negative_case(meta: dict[str, Any]) -> None:
    """No gate is covered on one side only."""
    for gate in meta["gateOrder"]:
        cases = [scenario for scenario in SCENARIOS if scenario.gate == gate]
        assert any(scenario.should_pass for scenario in cases), f"{gate}: no passing case"
        assert any(not scenario.should_pass for scenario in cases), f"{gate}: no failing case"


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda scenario: scenario.id)
def test_gate_scenario(scenario: Any, scenario_reports: dict[str, dict[str, Any]]) -> None:
    """The targeted gate reaches the expected verdict, for the stated reason."""
    report = scenario_reports[scenario.id]
    outcome = metrics.outcome_for(report, scenario.gate)

    assert outcome["passed"] is scenario.should_pass, (
        f"{scenario.gate} ({scenario.name}) expected "
        f"{'pass' if scenario.should_pass else 'fail'}: {scenario.why}\n"
        f"detail: {outcome['detail'] or '(none)'}"
    )

    if scenario.should_pass:
        # The contract says a passing gate carries no detail. A gate that
        # explains itself when it passed is a gate whose report cannot be
        # skimmed for the things that went wrong.
        assert outcome["detail"] == ""
    else:
        assert outcome["detail"], (
            f"{scenario.gate} failed without saying why. The detail is what a "
            f"reviewer acts on."
        )


def test_the_untouched_sample_passes_every_gate(
    scenario_reports: dict[str, dict[str, Any]],
) -> None:
    """The baseline every negative case is built from is genuinely clean.

    If this fails, every other assertion in this file is meaningless: the
    negative cases would no longer be isolating one defect, they would be
    inheriting one.
    """
    report = scenario_reports["G01_schema:well_formed"]
    failures = metrics.failed_gates(report)
    assert not failures, (
        f"The sample draft from services/gates/test-helpers.ts no longer "
        f"passes every gate: {sorted(failures)}"
    )
    assert report["blocked"] is False


def test_blocked_is_true_when_a_blocking_gate_fails(
    scenario_reports: dict[str, dict[str, Any]],
) -> None:
    """`blocked` is derived from the outcomes, and drives BLOCKED vs PENDING_APPROVAL."""
    blocking_failure = scenario_reports["G05_evidence_grounding:source_value_overstated"]
    assert blocking_failure["blocked"] is True


def test_a_warning_alone_does_not_block(
    scenario_reports: dict[str, dict[str, Any]],
) -> None:
    """A second call to action is a quality problem, not a compliance one."""
    warning_only = scenario_reports["G10_single_cta:two_different_asks"]
    assert metrics.failed_blocking_gates(warning_only) == frozenset()
    assert warning_only["blocked"] is False
