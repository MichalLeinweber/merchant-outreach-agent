"""Record the triage responses the eval suite replays.

    ANTHROPIC_API_KEY=... uv run python record_triage_fixtures.py --max-cost-usd 0.50

Runs the real triage agent over the golden set with `LLM_MODE=record`, which
calls the model and writes each response to `evals/fixtures/llm/`. Once those
files are committed, `test_triage.py` replays them offline for ever after and
CI never needs a key.

This is the only script in the suite that spends money, which is why it is a
separate file, is never called by a test, and takes a cost cap. The cap is
checked before every call, so it is a ceiling rather than something noticed
afterwards; when it is reached the run stops and the merchants not yet
recorded stay unrecorded.

Re-run it after editing `services/agents/prompts/triage.md`. The fixture key
is a hash of the prompt, so an edited prompt has no fixture and the next
fixture-mode run fails loudly instead of replaying an answer to a different
question.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-cost-usd",
        type=float,
        default=0.50,
        help="hard ceiling on model spend; the run stops when it is reached",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="record only the first N merchants of the golden set",
    )
    parser.add_argument(
        "--mode",
        default="record",
        choices=["record", "live"],
        help="`record` writes fixtures, `live` calls the model and keeps nothing",
    )
    args = parser.parse_args(argv)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. This script calls the model; it has no "
            "offline mode.\nSet the key in the environment - never in a file that "
            "gets committed.",
            file=sys.stderr,
        )
        return 1

    golden = datasets.load_golden()
    merchants = [case.merchant for case in golden][: args.limit]

    print(
        f"Recording triage for {len(merchants)} merchant(s) into "
        f"{bridge.FIXTURE_DIR} with a ${args.max_cost_usd:.2f} cap."
    )

    run = bridge.run_triage(
        merchants,
        now=datasets.EVAL_NOW,
        mode=args.mode,
        max_cost_usd=args.max_cost_usd,
    )

    recorded = [entry for entry in run["results"] if entry["ok"]]
    failed = [entry for entry in run["results"] if not entry["ok"]]

    for entry in recorded:
        result = entry["result"]
        print(
            f"  {entry['merchantId']}: {result['recommendedAction']} "
            f"(score {result['score']}, confidence {result['confidence']:.2f}"
            f"{', escalated' if result['escalated'] else ''})"
        )
    for entry in failed:
        print(f"  {entry['merchantId']}: FAILED - {entry['error']['message']}", file=sys.stderr)

    print(f"\nspent ${run['spentUsd']:.4f}; recorded {len(recorded)}, failed {len(failed)}")

    if failed:
        print(
            "Some merchants were not recorded. Nothing was silently skipped - "
            "the reasons are above.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
