"""Write `baseline.json` from an actual run.

    uv run python record_baseline.py            # print what would change
    uv run python record_baseline.py --write    # write it

The baseline is the answer to "how do you know the prompt change did not break
anything", so two rules govern this script:

**It never runs by itself.** Nothing in CI calls it. A baseline that updates
itself records the regression as the new normal, and the gate that was
supposed to catch it reports green forever after.

**It writes what was measured, and `null` for what was not.** Metrics that
need human labels or recorded model responses stay null with the reason
recorded next to them, and the regression gate treats null as
"not established" rather than as a pass. There is no default value for a
measurement nobody took.

The diff this produces is meant to be read. When a number moves, the pull
request says why.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EVALS_DIR = Path(__file__).resolve().parent
if str(EVALS_DIR) not in sys.path:
    sys.path.insert(0, str(EVALS_DIR))

from harness import bridge, datasets, report  # noqa: E402
from harness.baseline import BASELINE_PATH  # noqa: E402


def git_commit() -> str | None:
    """The commit the numbers were measured at, if this is a git checkout."""
    try:
        completed = subprocess.run(  # noqa: S603 — fixed argv, no shell
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=bridge.REPO_ROOT,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout.strip() or None if completed.returncode == 0 else None


def measure() -> dict[str, Any]:
    golden = datasets.load_golden()
    merchants = datasets.merchants_by_id(golden)
    drafts = datasets.load_drafts()

    reports = bridge.run_gates(datasets.build_gate_cases(drafts, merchants))
    measurement = report.collect(list(reports.values()), golden)

    return {
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "commit": git_commit(),
        "corpus": {
            "golden_merchants": len(golden),
            "drafts": len(drafts),
            "draft_source": "hand-written fixtures, not model output",
        },
        "metrics": measurement.values,
        "unavailable": measurement.unavailable,
        "notes": (
            "Recorded by evals/record_baseline.py. Metrics that are null have "
            "never been measured; the regression gate reports them as not "
            "established rather than as a pass. Move a number only with an "
            "explanation in the pull request."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help="write baseline.json; without it the measurement is only printed",
    )
    parser.add_argument("--out", type=Path, default=BASELINE_PATH)
    args = parser.parse_args(argv)

    measured = measure()
    rendered = json.dumps(measured, indent=2, ensure_ascii=False) + "\n"

    if not args.write:
        print(rendered, end="")
        print(f"\n(nothing written - pass --write to update {args.out})", file=sys.stderr)
        return 0

    args.out.write_text(rendered, encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
