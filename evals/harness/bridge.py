"""Calling the TypeScript pipeline from Python.

The gates live in `services/gates` and the triage agent in `services/agents`.
This module runs them — the real ones, in the real files — by piping JSON
through `evals/harness/bridge.ts`. Nothing about a gate is reimplemented here.

One subprocess per call, and the callers batch: `conftest.py` collects every
case a test session needs and pays the Node start-up once.

Failure is loud on purpose. No fallback to a Python approximation, no empty
result when Node is missing — an eval suite that keeps reporting numbers after
losing contact with the thing it measures is worse than one that stops.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = EVALS_DIR.parent

BRIDGE_SCRIPT = EVALS_DIR / "harness" / "bridge.ts"
TS_RESOLVER = EVALS_DIR / "harness" / "ts-resolve.mjs"

# Where the eval suite keeps its own recorded model responses. Separate from
# `fixtures/llm/`, which belongs to the demo run: the golden set is the eval
# suite's input and its fixtures are its own, so re-recording one does not
# silently change the other.
FIXTURE_DIR = EVALS_DIR / "fixtures" / "llm"

# Node needs both flags:
#   --experimental-transform-types  `shared/errors.ts` uses constructor
#       parameter properties, which strip-only mode rejects outright.
#   --import ts-resolve.mjs         the services import each other as ".js",
#       which is the path after compilation and not a file on disk.
# See `evals/harness/ts-resolve.mjs` for the longer version of the second one.
#
# `--import` takes a URL, not a path: on Windows an absolute path starts with a
# drive letter and Node reads `C:` as a URL scheme it does not support.
NODE_FLAGS = ["--experimental-transform-types", "--import", TS_RESOLVER.as_uri()]

DEFAULT_TIMEOUT_SECONDS = 300


class BridgeError(RuntimeError):
    """The bridge could not be run, or did not answer with usable JSON."""


def node_executable() -> str:
    """The `node` binary, or an error naming what to install."""
    node = shutil.which("node")
    if node is None:
        raise BridgeError(
            "`node` is not on PATH, so the eval suite cannot run the gates it "
            "is supposed to measure.\n"
            "Install Node 22.18 or newer (the repository's .nvmrc says 22) and "
            "run `npm install` in the repository root."
        )
    return node


def call_bridge(
    request: dict[str, Any],
    *,
    env: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Send one request to the bridge and return its parsed answer."""
    process_env = dict(os.environ)
    if env:
        process_env.update(env)

    try:
        completed = subprocess.run(  # noqa: S603 — fixed argv, no shell
            [node_executable(), *NODE_FLAGS, str(BRIDGE_SCRIPT)],
            input=json.dumps(request),
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=REPO_ROOT,
            env=process_env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise BridgeError(
            f"The bridge did not finish within {timeout} seconds "
            f"(command: {request.get('command')!r})."
        ) from error

    if completed.returncode != 0:
        raise BridgeError(
            f"The bridge exited with code {completed.returncode} "
            f"(command: {request.get('command')!r}).\n"
            f"--- stderr ---\n{completed.stderr.strip()}"
        )

    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise BridgeError(
            "The bridge did not return JSON on stdout. This usually means "
            "something in the pipeline printed to stdout.\n"
            f"--- stdout ---\n{completed.stdout[:2000]}\n"
            f"--- stderr ---\n{completed.stderr.strip()[:2000]}"
        ) from error


def fetch_meta() -> dict[str, Any]:
    """Gate metadata, limits, pricing and the passing sample draft."""
    return call_bridge({"command": "meta"})


def run_gates(cases: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Run every gate over every case. Returns reports keyed by case id."""
    if not cases:
        return {}
    answer = call_bridge({"command": "gates", "cases": cases})
    return {entry["id"]: entry["report"] for entry in answer["results"]}


def run_triage(
    merchants: list[dict[str, Any]],
    *,
    campaign_id: str = "eval_golden",
    now: str,
    mode: str = "fixture",
    fixture_dir: Path = FIXTURE_DIR,
    max_cost_usd: float | None = None,
) -> dict[str, Any]:
    """Triage every merchant through the real agent.

    Defaults to `fixture` mode, which reads recorded responses and never calls
    a model. A merchant with no recorded response comes back as an entry with
    `ok: false`; see `test_triage.py` for what the suite does about it.
    """
    request: dict[str, Any] = {
        "command": "triage",
        "merchants": merchants,
        "campaignId": campaign_id,
        "now": now,
    }
    if max_cost_usd is not None:
        request["maxCostUsd"] = max_cost_usd

    return call_bridge(
        request,
        env={"LLM_MODE": mode, "LLM_FIXTURE_DIR": str(fixture_dir)},
    )
