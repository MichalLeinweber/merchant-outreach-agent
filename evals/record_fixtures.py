"""Record the model responses the eval suite replays.

    uv run python record_fixtures.py triage            # all 30 golden merchants
    uv run python record_fixtures.py drafts            # the 10-merchant sample
    uv run python record_fixtures.py both --max-cost-usd 2

Reads the API key from `.env.local` (or the environment) and never prints it.
Writes each response to `evals/fixtures/llm/`, keyed by a hash of the exact
request. Once committed, every later run replays them offline.

This is the only part of the suite that spends money, which is why:

* it is a script, not a test, and nothing calls it automatically;
* it takes a cost cap, checked before every call, and stops when it is
  reached, leaving the merchants it did not reach unrecorded and saying so;
* the cap is shared across both agents when you run `both`, so the number you
  pass is the number you can spend, not the number per agent.

Re-run it after editing a prompt: the fixture key is a hash of the prompt, so
an edited prompt has no fixture and the next offline run fails loudly rather
than replaying an answer to a different question.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets  # noqa: E402

# The ten merchants worth having a real draft for.
#
# Chosen for the cases where a model's behaviour is least predictable, not for
# coverage of the whole set: two records with nothing to personalise on, two
# where the rating is excellent and the sample tiny, two already running an
# offer, and three locales that are not the default. A sample of ten
# comfortable merchants would tell us nothing we could not guess.
DRAFT_SAMPLE = [
    ("gold_001", "no rating, no reviews, no website"),
    ("gold_021", "every optional field null"),
    ("gold_009", "rated, but zero reviews"),
    ("gold_002", "4.9 from seven reviews"),
    ("gold_022", "5.0 from three reviews"),
    ("gold_003", "already running an offer"),
    ("gold_019", "already running an offer, excellent record"),
    ("gold_004", "cs-CZ, diacritics in the name"),
    ("gold_005", "de-DE, long trading history"),
    ("gold_018", "es-ES, large venue"),
]


def summarise_triage(results: list[dict[str, Any]]) -> None:
    for entry in results:
        if not entry["ok"]:
            continue
        result = entry["result"]
        print(
            f"  {entry['merchantId']}: {result['recommendedAction']:<12} "
            f"score {result['score']:>3}  confidence {result['confidence']:.2f}"
            f"{'  escalated' if result['escalated'] else ''}"
        )


def summarise_drafts(results: list[dict[str, Any]]) -> None:
    for entry in results:
        if not entry["ok"]:
            continue
        draft = entry["draft"]
        words = len(draft["body"].split())
        print(
            f"  {entry['merchantId']}: {words:>3} words, "
            f"{len(draft['evidence'])} claim(s), subject "
            f"{len(draft['subject'])} chars"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("what", choices=["triage", "drafts", "both"])
    parser.add_argument(
        "--max-cost-usd",
        type=float,
        default=None,
        help="hard ceiling on spend, shared across both agents "
        "(default: CAMPAIGN_COST_CAP_USD from .env.local)",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="only the first N merchants"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=EVALS_DIR / "reports" / "recording.json",
        help="where to write the full machine-readable result",
    )
    args = parser.parse_args(argv)

    key = bridge.api_key()
    if not key:
        print(
            "No ANTHROPIC_API_KEY, in the environment or in .env.local. This "
            "script calls the model; it has no offline mode.",
            file=sys.stderr,
        )
        return 1

    cap = args.max_cost_usd if args.max_cost_usd is not None else bridge.configured_cost_cap(0.50)

    golden = datasets.load_golden()
    by_id = {case.id: case.merchant for case in golden}

    plan: list[tuple[str, list[dict[str, Any]]]] = []
    if args.what in {"triage", "both"}:
        plan.append(("triage", [case.merchant for case in golden][: args.limit]))
    if args.what in {"drafts", "both"}:
        sample = [by_id[merchant_id] for merchant_id, _ in DRAFT_SAMPLE][: args.limit]
        plan.append(("drafts", sample))

    print(f"Recording into {bridge.FIXTURE_DIR}")
    print(f"Cost cap: ${cap:.2f}, shared across this run\n")

    spent = 0.0
    report: dict[str, Any] = {"cap_usd": cap, "runs": {}}

    for command, merchants in plan:
        remaining = cap - spent
        if remaining <= 0:
            print(
                f"{command}: skipped - the cost cap was already reached. Nothing "
                f"was recorded for it.",
                file=sys.stderr,
            )
            return 1

        print(f"{command}: {len(merchants)} merchant(s), ${remaining:.4f} of cap left")

        runner = bridge.run_triage if command == "triage" else bridge.run_drafts
        run = runner(
            merchants,
            now=datasets.EVAL_NOW,
            mode="record",
            max_cost_usd=remaining,
            api_key=key,
        )

        spent += run["spentUsd"]
        report["runs"][command] = run

        recorded = [entry for entry in run["results"] if entry["ok"]]
        failed = [entry for entry in run["results"] if not entry["ok"]]

        if command == "triage":
            summarise_triage(run["results"])
        else:
            summarise_drafts(run["results"])

        for entry in failed:
            print(
                f"  {entry['merchantId']}: FAILED [{entry['error']['code']}] "
                f"{entry['error']['message'].splitlines()[0]}",
                file=sys.stderr,
            )

        print(
            f"{command}: recorded {len(recorded)}, failed {len(failed)}, "
            f"spent ${run['spentUsd']:.4f}\n"
        )

        # A cost cap that stops the run is not a warning to scroll past. The
        # remaining merchants keep whatever state they had; nothing continues
        # at lower quality.
        if any(entry.get("error", {}).get("code") == "COST_CAP_EXCEEDED" for entry in failed):
            print(
                f"Stopped: the ${cap:.2f} cap was reached during `{command}`. "
                f"Merchants after that point were not recorded.",
                file=sys.stderr,
            )
            return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"total spent ${spent:.4f} of a ${cap:.2f} cap")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
