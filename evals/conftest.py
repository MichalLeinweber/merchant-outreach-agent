"""Fixtures shared by the eval suite.

Everything expensive is session-scoped and batched. Each call to the bridge is
a Node process start-up, so the gate scenarios and the whole draft corpus go
over in one request and every test reads from the same reports. A suite that
spawned a process per case would take long enough that people would stop
running it, which is the only way an eval suite really fails.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

# So `import harness...` works whether pytest is invoked from the repository
# root (`pytest evals/`) or from inside `evals/`.
EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets, gate_cases  # noqa: E402

SCENARIO_PREFIX = "scenario::"
CORPUS_PREFIX = "corpus::"


@pytest.fixture(scope="session")
def meta() -> dict[str, Any]:
    """Gate metadata, limits, pricing and the passing sample, from the source."""
    return bridge.fetch_meta()


@pytest.fixture(scope="session")
def golden() -> list[datasets.GoldenCase]:
    return datasets.load_golden()


@pytest.fixture(scope="session")
def merchants(golden: list[datasets.GoldenCase]) -> dict[str, dict[str, Any]]:
    return datasets.merchants_by_id(golden)


@pytest.fixture(scope="session")
def draft_corpus() -> list[datasets.DraftCase]:
    return datasets.load_drafts()


@pytest.fixture(scope="session")
def calibration() -> list[datasets.CalibrationCase]:
    return datasets.load_calibration()


@pytest.fixture(scope="session")
def _all_reports(
    meta: dict[str, Any],
    draft_corpus: list[datasets.DraftCase],
    merchants: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Every gate report the session needs, from one call to the bridge."""
    cases: list[dict[str, Any]] = []

    for case in gate_cases.build_cases(meta["sample"]):
        cases.append({**case, "id": f"{SCENARIO_PREFIX}{case['id']}"})

    for case in datasets.build_gate_cases(draft_corpus, merchants):
        cases.append({**case, "id": f"{CORPUS_PREFIX}{case['id']}"})

    return bridge.run_gates(cases)


@pytest.fixture(scope="session")
def scenario_reports(_all_reports: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Gate reports for the per-gate positive and negative scenarios."""
    return {
        key[len(SCENARIO_PREFIX) :]: report
        for key, report in _all_reports.items()
        if key.startswith(SCENARIO_PREFIX)
    }


@pytest.fixture(scope="session")
def corpus_reports(_all_reports: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Gate reports for the labelled draft corpus, keyed by draft id."""
    return {
        key[len(CORPUS_PREFIX) :]: report
        for key, report in _all_reports.items()
        if key.startswith(CORPUS_PREFIX)
    }
