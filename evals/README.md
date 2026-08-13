# evals — WS6

The eval suite. Python, pytest, uv; it measures the TypeScript pipeline by
running it.

```bash
cd evals
uv sync                 # once
uv run pytest           # the whole suite, offline, no API key
```

## Gates and evals are not the same thing

They get conflated constantly, and keeping them apart is most of what this
directory is for.

| | Gates | Evals |
|---|---|---|
| When | On every draft, in production | In CI, on a fixed golden set |
| What they decide | Whether *this* draft may be sent | Whether *quality* moved after a change |
| How they answer | Deterministic, no model, no I/O | Rates and scores, some of them from a model |
| Failure means | The draft is blocked | The build fails, or a number moved |
| Where they live | `services/gates` | here |

A gate is a pure function `(draft, merchant, context) => GateOutcome`. It runs
in milliseconds and always gives the same answer. An eval is a measurement
over many drafts — it has no power to block anything, and it exists to answer
one question: *how do you know the prompt change did not break something?*

## What is in here

```
evals/
├── datasets/
│   ├── golden.jsonl        30 merchants covering the edge cases in EVALS.md
│   ├── drafts.jsonl        20 drafts, each labelled with the gates it must fail
│   └── calibration.jsonl   10 drafts for a human to score, for the judge
├── harness/
│   ├── bridge.ts           runs the real gates and the real triage agent
│   ├── ts-resolve.mjs      lets Node run the TypeScript sources directly
│   ├── bridge.py           the Python side of that
│   ├── datasets.py         loaders, and the shapes the pipeline expects
│   ├── gate_cases.py       one passing and one failing case per gate
│   ├── metrics.py          every metric, defined once
│   ├── report.py           collecting them, and saying which are missing
│   └── baseline.py         the regression gate
├── prompts/judge.md        the 1–5 rubric on four axes
├── test_gates.py           every gate, positively and negatively
├── test_grounding.py       hallucination rate = share failing G05 or G06
├── test_triage.py          agreement with the golden set, precision/recall
├── test_judge.py           the judge's scaffolding, without calling a model
├── test_baseline.py        the regression gate — this is what fails a build
├── judge.py                LLM-as-judge and the calibration report
├── record_baseline.py      writes baseline.json from an actual run
└── record_triage_fixtures.py   the only script that spends money
```

## Why a Node bridge

The gates are TypeScript. The suite could have re-implemented them in Python,
and then the evals would measure the copy rather than the system — silently,
from the first time the two drifted, while still reporting a pass rate.

So `harness/bridge.ts` imports `services/gates` and `services/agents` and runs
them, and Python talks to it over stdin/stdout in one batch per test session.
Nothing about a gate is restated in Python except the severity table in
`test_gates.py`, which is restated **on purpose**: it is the specification from
EVALS.md, and the test exists so the two can be compared.

Running the TypeScript sources under plain Node needs two flags, both
explained where they are used:

* `--experimental-transform-types` — `shared/errors.ts` uses constructor
  parameter properties, which Node's strip-only mode rejects.
* `--import ./harness/ts-resolve.mjs` — the services import each other as
  `"./runner.js"`, the path after compilation; the hook retries as `.ts`.

Needs Node 22.18+ (the repository's `.nvmrc` says 22) and `npm install` in the
repository root.

## What runs without an API key

All of it. That is the design, not a convenience:

* `test_gates.py` and `test_grounding.py` are pure fixtures — the gates take
  no I/O and call no model.
* `test_triage.py` and `judge.py` run in `fixture` mode, replaying recorded
  responses. A missing fixture is a **hard error naming the command that
  records it** — never a live call, never a stub.

The live run is a separate, manually triggered workflow with a cost cap:
`.github/workflows/evals-live.yml`.

## The state of the numbers today

Two metrics are measured and two are not, and the suite says so rather than
reporting a zero:

| Metric | Status |
|---|---|
| `gate_pass_rate` | measured — 0.9385 over the committed corpus |
| `hallucination_rate` | measured — 0.3000 (6 of 20 drafts fail G05 or G06) |
| `blocked_rate` | measured — 0.5500, reported but not gated |
| `triage_accuracy` | **not established** — nobody has labelled `expected_bucket` yet |
| `judge_mean.*` | **not established** — no recorded judge responses yet |
| `cost_per_draft_usd` | **not established** — meaningful only for a live run |

Unestablished metrics are `null` in `baseline.json`, and the regression gate
reports them as *not established* — never as a pass. "We have no baseline" and
"nothing regressed" are different statements.

**The draft corpus is hand-written, not model output.** Its hallucination rate
is therefore a property of the corpus, and what `test_grounding.py` proves is
that the *measurement* is right: G05 and G06 fire on exactly the drafts
designed to trip them and on nothing else. Because the corpus is fixed, the
rate should not move at all — which makes it a tight regression check on the
gates themselves. When a live run records real drafts, the corpus is replaced
and the same code starts reporting a number about the model.

### To fill in the missing halves

```bash
# 1. Label the golden set: set expected_bucket on each of the 30 merchants
#    in datasets/golden.jsonl to pursue | skip | needs_human.

# 2. Record the triage responses, once, with a cap:
ANTHROPIC_API_KEY=... uv run python record_triage_fixtures.py --max-cost-usd 0.50

# 3. Score the ten calibration drafts by hand in datasets/calibration.jsonl,
#    then record the judge and read the agreement report:
ANTHROPIC_API_KEY=... uv run python judge.py calibrate --mode record --max-cost-usd 0.50
uv run python judge.py calibrate          # replays, prints the agreement table

# 4. Record the baseline the gate compares against, and explain it in the PR:
uv run python record_baseline.py --write
```

## The judge

Four axes from EVALS.md — personalization, faithfulness, tone, actionability —
each scored 1 to 5 against the rubric in `prompts/judge.md`, which defines what
every one of the five points means on every axis.

**An uncalibrated judge is just another unchecked model.** Ten drafts in
`datasets/calibration.jsonl` are scored by hand, and `judge.py calibrate`
reports three numbers per axis against those scores: exact agreement,
agreement within one point, and mean absolute error. Three rather than one,
because a judge that scores everything 4 looks agreeable on "within one" while
carrying no information — which is why the mean scores are printed next to the
agreement and not instead of it.

> **Agreement with human scoring: not yet available.** The ten calibration
> drafts have no `human_scores` yet. `test_judge.py` skips the agreement test
> with that reason rather than reporting a number computed from zero
> comparisons, and this section is where the table goes once they are scored.

## The regression gate

`test_baseline.py` compares a fresh run against `evals/baseline.json` and fails
the build when a metric moves further than its tolerance:

| Metric | Fails when |
|---|---|
| `triage_accuracy` | more than 3 percentage points down |
| `gate_pass_rate` | more than 3 percentage points down |
| `hallucination_rate` | more than 1 percentage point up |
| `judge_mean.*` | more than 0.3 down on any axis |

The thresholds live in `harness/baseline.py`, not in the JSON, so loosening one
is a code change a reviewer sees rather than a number edited in a data file
next to the measurements.

The baseline moves only by committing a new one. Nothing updates it
automatically — a baseline that records the regression as the new normal is a
gate that reports green for ever after.

## Something the suite found

`draft_004`, `draft_005` and `draft_006` are correct, well-grounded, correctly
localised drafts in Czech, German and Dutch. All three fail **G10** — the
single-call-to-action gate — because its patterns are English. The gate cannot
see "můžete svůj zájem potvrdit" or "Ihr Interesse hinterlegen" as an ask, so
it reports that the body asks the reader to do nothing.

That is a real limitation of a gate, found by running it over a corpus that
includes the cases nobody thought about. It is recorded in the labels rather
than papered over, which is what the labels are for. G10 is a warning, so it
does not block a send today; extending it to the campaign's other languages is
the fix.

## What this suite does not cover

* **The container build.** `npm run build:docker` is CI's job, and a green
  eval run says nothing about it.
* **Anything needing Postgres.** The gates take no I/O; the integration suite
  (`npm run test:integration`) is where SQL runs.
* **The dashboard.** Separate npm project, separate suite.
* **Live model behaviour.** Everything here replays recorded responses. The
  numbers a live run produces come from `evals-live.yml`, on demand, with a
  cap.
