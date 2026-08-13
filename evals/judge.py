"""LLM-as-judge, and the calibration that makes it worth reading.

The four axes come from EVALS.md - personalization, faithfulness, tone,
actionability - each scored 1 to 5 against the rubric in `prompts/judge.md`.

Three decisions worth stating, because each has an alternative that looks
reasonable:

**The judge is calibrated, or it is not used.** Ten drafts are scored by hand
in `datasets/calibration.jsonl`, and `python judge.py calibrate` reports how
closely the model agreed with the person. An uncalibrated judge is just
another unchecked model producing numbers that look like measurements, and
the point of this file is to have an answer when somebody asks how the judge
itself was checked.

**Fixture mode by default, and a missing fixture is a hard error.** Same rule
as the pipeline: CI replays recorded responses and never calls a model. When
the prompt changes, the fixture key changes, the run fails, and the message
says how to re-record. A fallback would turn a changed rubric into an
invisible change in every score.

**A live run has a cost cap and stops at it.** Not a warning, not a smaller
model - the run stops with unscored drafts left unscored, and says so.

    uv run python judge.py calibrate                 # fixture mode, no key
    ANTHROPIC_API_KEY=... uv run python judge.py calibrate \\
        --mode record --max-cost-usd 0.50            # records as it goes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets, metrics  # noqa: E402
from harness.datasets import RUBRIC_AXES  # noqa: E402

PROMPT_PATH = EVALS_DIR / "prompts" / "judge.md"
FIXTURE_DIR = EVALS_DIR / "fixtures" / "judge"
REPORT_DIR = EVALS_DIR / "reports"

# The judge runs on the strongest model available. It is scoring the output of
# a cheaper one, and a judge no better than the thing it grades cannot tell a
# fluent draft from a good one.
JUDGE_MODEL = "claude-opus-5"

# Room for the rubric, four scores and four rationales. On this model
# `max_tokens` caps thinking and response text together, so it is not sized to
# the answer alone.
JUDGE_MAX_TOKENS = 4096

# Bumped only when the hashed shape changes, which invalidates every fixture at
# once. Editing the rubric does not need it — that changes the hash by itself.
FIXTURE_KEY_VERSION = 1

SCORE_DESCRIPTION = "Score from 1 to 5, as defined by the rubric for this axis."

JUDGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        **{
            axis: {"type": "integer", "description": SCORE_DESCRIPTION}
            for axis in RUBRIC_AXES
        },
        "rationale": {
            "type": "object",
            "description": "One sentence per axis, quoting the draft.",
            "properties": {axis: {"type": "string"} for axis in RUBRIC_AXES},
            "required": list(RUBRIC_AXES),
            "additionalProperties": False,
        },
    },
    "required": [*RUBRIC_AXES, "rationale"],
    "additionalProperties": False,
}


class JudgeError(RuntimeError):
    """Anything that stops the judge, stated with what to do about it."""


class MissingJudgeFixtureError(JudgeError):
    def __init__(self, fixture_key: str, path: Path) -> None:
        super().__init__(
            f"Missing judge fixture {fixture_key!r}.\n"
            f"Expected file: {path}\n"
            f"The prompt, the model or the draft changed, so the recorded "
            f"response no longer answers the question being asked.\n"
            f"Re-record with:\n"
            f"    ANTHROPIC_API_KEY=... uv run python judge.py calibrate "
            f"--mode record --max-cost-usd 0.50\n"
            f"Refusing to fall back to a live call or a stub score."
        )
        self.fixture_key = fixture_key
        self.path = path


class CostCapExceededError(JudgeError):
    def __init__(self, spent: float, cap: float) -> None:
        super().__init__(
            f"Cost cap reached: ${spent:.4f} spent against a ${cap:.4f} cap. "
            f"The run stopped; the drafts not yet scored were not scored. "
            f"Raise --max-cost-usd deliberately or score fewer drafts."
        )


# ─── Prompt ────────────────────────────────────────────────────

SYSTEM_MARKER = re.compile(r"^[ \t]*<!--[ \t]*system[ \t]*-->[ \t]*$", re.MULTILINE)
USER_MARKER = re.compile(r"^[ \t]*<!--[ \t]*user[ \t]*-->[ \t]*$", re.MULTILINE)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class PromptTemplate:
    system: str
    user: str


def load_prompt(path: Path = PROMPT_PATH) -> PromptTemplate:
    """Split the prompt file on its markers and strip the authoring notes.

    Same format and same rules as `services/agents/prompts.ts`: the notes in
    the file are for whoever edits it, not for the model, and sending them
    would mean paying for them on every call.
    """
    raw = path.read_text(encoding="utf-8")

    system_marker = SYSTEM_MARKER.search(raw)
    user_marker = USER_MARKER.search(raw)
    if system_marker is None or user_marker is None:
        raise JudgeError(
            f"{path.name} must contain a system marker and a user marker, each "
            f"alone on its own line."
        )
    if user_marker.start() < system_marker.start():
        raise JudgeError(f"{path.name} has the user marker before the system marker.")

    def clean(text: str) -> str:
        stripped = re.sub(r"\n{3,}", "\n\n", HTML_COMMENT.sub("", text)).strip()
        if "<!--" in stripped or "-->" in stripped:
            raise JudgeError(
                f"{path.name} has an unterminated or nested comment. HTML comments "
                f"cannot nest - a '-->' inside a comment closes it early."
            )
        return stripped

    return PromptTemplate(
        system=clean(raw[system_marker.end() : user_marker.start()]),
        user=clean(raw[user_marker.end() :]),
    )


def render(template: str, values: dict[str, str]) -> str:
    """Substitute `{{name}}`. An unknown placeholder is an error, never a blank."""
    missing: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            missing.append(key)
            return ""
        return values[key]

    rendered = PLACEHOLDER.sub(substitute, template)
    if missing:
        raise JudgeError(
            f"Prompt uses placeholder(s) with no value supplied: "
            f"{', '.join(sorted(set(missing)))}. A silently blank section still "
            f"produces confident-looking output."
        )
    return rendered


# ─── Requests and fixtures ─────────────────────────────────────


@dataclass(frozen=True)
class JudgeRequest:
    model: str
    system: str
    user_prompt: str
    max_tokens: int

    def fixture_key(self) -> str:
        """Stable hash of everything that can change the answer."""
        canonical = json.dumps(
            {
                "v": FIXTURE_KEY_VERSION,
                "model": self.model,
                "system": self.system,
                "userPrompt": self.user_prompt,
                "maxTokens": self.max_tokens,
                "schema": json.dumps(JUDGE_SCHEMA, sort_keys=True),
            },
            sort_keys=True,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int


@dataclass(frozen=True)
class JudgeResult:
    draft_id: str
    scores: dict[str, int]
    rationale: dict[str, str]
    model: str
    fixture_key: str
    usage: Usage
    cost_usd: float


_pricing_cache: dict[str, dict[str, float]] | None = None


def pricing() -> dict[str, dict[str, float]]:
    """Model prices, read from `services/agents/pricing.ts` through the bridge.

    Not restated in Python. A second price table is a second thing to forget
    when the first one changes, and the number it produces looks equally real.
    """
    global _pricing_cache
    if _pricing_cache is None:
        _pricing_cache = bridge.fetch_meta()["pricing"]
    return _pricing_cache


CACHE_READ_MULTIPLIER = 0.1


def cost_usd(model: str, usage: Usage) -> float:
    price = pricing()[model]
    dollars = (
        usage.input_tokens * price["inputPerMTok"]
        + usage.cached_input_tokens * price["inputPerMTok"] * CACHE_READ_MULTIPLIER
        + usage.output_tokens * price["outputPerMTok"]
    ) / 1_000_000
    return round(dollars, 6)


def build_request(merchant: dict[str, Any], draft: dict[str, Any]) -> JudgeRequest:
    template = load_prompt()
    return JudgeRequest(
        model=JUDGE_MODEL,
        system=render(template.system, {}),
        user_prompt=render(
            template.user,
            {
                "merchant": json.dumps(merchant, indent=2, ensure_ascii=False),
                "draft": json.dumps(
                    {
                        "subject": draft["subject"],
                        "body": draft["body"],
                        "evidence": draft["evidence"],
                        "locale": draft["locale"],
                    },
                    indent=2,
                    ensure_ascii=False,
                ),
            },
        ),
        max_tokens=JUDGE_MAX_TOKENS,
    )


# ─── The judge ─────────────────────────────────────────────────


@dataclass
class Judge:
    """Scores drafts. Three modes, exactly like the pipeline's LLM client.

    fixture  read a recorded response; a missing one is a hard error
    record   call the model and write the response to fixtures/judge/
    live     call the model and keep nothing
    """

    mode: str = "fixture"
    fixture_dir: Path = FIXTURE_DIR
    max_cost_usd: float | None = None
    spent_usd: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        if self.mode not in {"fixture", "record", "live"}:
            raise JudgeError(
                f"mode {self.mode!r} is not one of: fixture, record, live."
            )

    def score(self, draft_id: str, merchant: dict[str, Any], draft: dict[str, Any]) -> JudgeResult:
        request = build_request(merchant, draft)
        key = request.fixture_key()

        if self.mode == "fixture":
            text, usage = self._replay(request, key)
        else:
            self._assert_within_cap()
            text, usage = self._call_model(request)
            if self.mode == "record":
                self._write_fixture(request, key, text, usage)

        payload = self._parse(text)
        result = JudgeResult(
            draft_id=draft_id,
            scores={axis: int(payload[axis]) for axis in RUBRIC_AXES},
            rationale={axis: payload["rationale"][axis] for axis in RUBRIC_AXES},
            model=request.model,
            fixture_key=key,
            usage=usage,
            cost_usd=cost_usd(request.model, usage) if self.mode != "fixture" else 0.0,
        )
        self.spent_usd += result.cost_usd
        return result

    # ── fixture mode ──

    def _fixture_path(self, key: str) -> Path:
        return self.fixture_dir / f"{key}.json"

    def _replay(self, request: JudgeRequest, key: str) -> tuple[str, Usage]:
        path = self._fixture_path(key)
        if not path.exists():
            raise MissingJudgeFixtureError(key, path)

        stored = json.loads(path.read_text(encoding="utf-8"))
        usage = stored["response"]["usage"]
        return stored["response"]["text"], Usage(
            input_tokens=usage["inputTokens"],
            output_tokens=usage["outputTokens"],
            cached_input_tokens=usage.get("cachedInputTokens", 0),
        )

    def _write_fixture(self, request: JudgeRequest, key: str, text: str, usage: Usage) -> None:
        self.fixture_dir.mkdir(parents=True, exist_ok=True)
        self._fixture_path(key).write_text(
            json.dumps(
                {
                    "fixtureKey": key,
                    "model": request.model,
                    "recordedAt": datetime.now(timezone.utc).isoformat(),
                    # Kept so a fixture diff in a pull request is reviewable.
                    "request": {
                        "system": request.system,
                        "userPrompt": request.user_prompt,
                        "maxTokens": request.max_tokens,
                    },
                    "response": {
                        "text": text,
                        "usage": {
                            "inputTokens": usage.input_tokens,
                            "outputTokens": usage.output_tokens,
                            "cachedInputTokens": usage.cached_input_tokens,
                        },
                    },
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

    # ── live / record mode ──

    def _assert_within_cap(self) -> None:
        """Checked before the call, so the ceiling is a ceiling."""
        if self.max_cost_usd is not None and self.spent_usd >= self.max_cost_usd:
            raise CostCapExceededError(self.spent_usd, self.max_cost_usd)

    def _call_model(self, request: JudgeRequest) -> tuple[str, Usage]:
        try:
            import anthropic
        except ImportError as error:  # pragma: no cover - depends on the extra
            raise JudgeError(
                "The `anthropic` package is not installed. It is an optional "
                "dependency because only a live judge run needs it:\n"
                "    uv sync --extra live"
            ) from error

        client = anthropic.Anthropic()
        response = client.messages.create(
            model=request.model,
            max_tokens=request.max_tokens,
            system=request.system,
            messages=[{"role": "user", "content": request.user_prompt}],
            # The schema constrains the output rather than the prompt asking
            # nicely for JSON, so a parse failure means a real problem.
            output_config={
                "effort": "medium",
                "format": {"type": "json_schema", "schema": JUDGE_SCHEMA},
            },
        )

        # A safety classifier can decline; that arrives as a normal 200 with an
        # empty content array, so check before reading the content.
        if response.stop_reason == "refusal":
            raise JudgeError("The judge model refused to score this draft.")
        if response.stop_reason == "max_tokens":
            raise JudgeError(
                f"The judge hit max_tokens ({request.max_tokens}); the response is "
                f"truncated and its scores cannot be trusted."
            )

        text = "".join(block.text for block in response.content if block.type == "text")
        if not text:
            raise JudgeError("The judge response contained no text block.")

        return text, Usage(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cached_input_tokens=getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        )

    # ── parsing ──

    @staticmethod
    def _parse(text: str) -> dict[str, Any]:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise JudgeError(f"The judge response was not valid JSON: {error}") from error

        for axis in RUBRIC_AXES:
            value = payload.get(axis)
            if not isinstance(value, int) or not 1 <= value <= 5:
                raise JudgeError(
                    f"Judge score for {axis!r} must be an integer 1-5, got {value!r}."
                )
        rationale = payload.get("rationale")
        if not isinstance(rationale, dict) or any(
            not isinstance(rationale.get(axis), str) or not rationale.get(axis)
            for axis in RUBRIC_AXES
        ):
            raise JudgeError("The judge response is missing a rationale for every axis.")

        return payload


# ─── Calibration ───────────────────────────────────────────────


@dataclass(frozen=True)
class CalibrationReport:
    scored: list[JudgeResult]
    human: dict[str, dict[str, int]]
    agreement: dict[str, metrics.AxisAgreement]
    judge_means: dict[str, float]
    human_means: dict[str, float]
    spent_usd: float

    @property
    def calibrated(self) -> bool:
        """Whether there is anything to compare against at all."""
        return bool(self.human)

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": JUDGE_MODEL,
            "scored": [
                {
                    "draftId": result.draft_id,
                    "scores": result.scores,
                    "rationale": result.rationale,
                }
                for result in self.scored
            ],
            "judgeMeans": self.judge_means,
            "humanMeans": self.human_means,
            "agreement": {
                axis: {
                    "n": value.n,
                    "exact": value.exact,
                    "withinOne": value.within_one,
                    "meanAbsoluteError": value.mean_absolute_error,
                }
                for axis, value in self.agreement.items()
            },
            "spentUsd": self.spent_usd,
        }

    def render(self) -> str:
        lines = [f"judge model: {JUDGE_MODEL}", f"drafts scored: {len(self.scored)}", ""]
        lines.append(f"{'axis':<18}{'judge':>8}{'human':>8}{'exact':>8}{'+/-1':>8}{'MAE':>8}")
        for axis in RUBRIC_AXES:
            agreement = self.agreement[axis]
            human_mean = self.human_means.get(axis)
            lines.append(
                f"{axis:<18}"
                f"{self.judge_means[axis]:>8.2f}"
                f"{(f'{human_mean:.2f}' if human_mean is not None else '-'):>8}"
                f"{(f'{agreement.exact:.0%}' if agreement.n else '-'):>8}"
                f"{(f'{agreement.within_one:.0%}' if agreement.n else '-'):>8}"
                f"{(f'{agreement.mean_absolute_error:.2f}' if agreement.n else '-'):>8}"
            )
        if not self.calibrated:
            lines += [
                "",
                "No human scores yet, so the agreement columns are empty. Fill in",
                "`human_scores` in evals/datasets/calibration.jsonl - an uncalibrated",
                "judge is just another unchecked model.",
            ]
        if self.spent_usd:
            lines += ["", f"spent: ${self.spent_usd:.4f}"]
        return "\n".join(lines)


def calibrate(judge: Judge) -> CalibrationReport:
    """Score the calibration set and compare with the human scores."""
    cases = datasets.load_calibration()
    drafts = {draft.id: draft for draft in datasets.load_drafts()}
    merchants = datasets.merchants_by_id(datasets.load_golden())

    results: list[JudgeResult] = []
    for case in cases:
        draft_case = drafts.get(case.draft_id)
        if draft_case is None:
            raise JudgeError(
                f"{case.id} refers to draft {case.draft_id!r}, which is not in "
                f"drafts.jsonl."
            )
        merchant = merchants[draft_case.merchant_id]
        results.append(
            judge.score(case.id, merchant, draft_case.to_draft(merchant))
        )

    human = {
        case.id: {axis: int(case.human_scores[axis]) for axis in RUBRIC_AXES}
        for case in cases
        if case.scored
    }

    pairs = [
        (result.scores, human[result.draft_id])
        for result in results
        if result.draft_id in human
    ]

    return CalibrationReport(
        scored=results,
        human=human,
        agreement=metrics.judge_agreement(pairs, RUBRIC_AXES),
        judge_means=metrics.mean_scores([result.scores for result in results], RUBRIC_AXES),
        human_means=metrics.mean_scores(list(human.values()), RUBRIC_AXES),
        spent_usd=judge.spent_usd,
    )


# ─── CLI ───────────────────────────────────────────────────────


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["calibrate"], help="what to run")
    parser.add_argument(
        "--mode",
        default="fixture",
        choices=["fixture", "record", "live"],
        help="fixture replays recorded responses (default, no API key needed)",
    )
    parser.add_argument(
        "--max-cost-usd",
        type=float,
        default=None,
        help="hard ceiling for a live or record run; the run stops when it is reached",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=REPORT_DIR / "judge-calibration.json",
        help="where to write the machine-readable report",
    )
    args = parser.parse_args(argv)

    judge = Judge(mode=args.mode, max_cost_usd=args.max_cost_usd)

    try:
        report = calibrate(judge)
    except JudgeError as error:
        print(f"judge: {error}", file=sys.stderr)
        return 1

    print(report.render())

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
