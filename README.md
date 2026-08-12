# merchant-outreach-agent

An agentic pipeline that drafts personalized outreach to local merchants, runs
it through deterministic checks, puts it in front of a human, and only then
sends it — with a second send made impossible by construction.

All merchant data is synthetic and generated in this repository. No real
merchant, no real email address.

> **Status: WS0 — foundation.** The contracts, database schema, service
> boundaries and LLM client are in place. The pipeline stages themselves are
> not implemented yet. See [Roadmap](#roadmap).

## Why this exists

A marketplace of local experiences needs new merchants. A sales team has
thousands of them on a list and cannot write a personal email to each. So an
agent drafts, and a human decides.

The interesting part is not the drafting. It is everything that stops a bad
draft from reaching a real inbox.

| Claim | Where you can see it in the code |
|---|---|
| Agents do the routine work, review keeps it safe | The approval queue. Nothing leaves without a click, enforced by a state machine rather than by convention. |
| Sending twice is impossible by construction | Outbox pattern, unique index, claim-by-update, idempotency key at the provider |
| You can tell where the agent failed | Gate reports, an eval suite with a regression baseline, tracked hallucination rate |
| TypeScript and Python | Encore.ts runtime, Python eval harness |
| Cost as a control variable | Cost per outreach, token accounting, cheap-to-expensive model routing |

## Quick start

Requires **Node 20+** ([`.nvmrc`](.nvmrc) pins 22), the
[Encore CLI](https://encore.dev/docs/install), and Docker running (Encore uses
it to provision the local Postgres).

```bash
git clone <this repo>
cd merchant-outreach-agent
npm install
encore run
```

No API key needed. The default `LLM_MODE=fixture` replays recorded model
responses from `fixtures/llm/`, so the whole pipeline runs offline and
deterministically.

Once it is up, the local dashboard is at <http://localhost:9400> and the
health endpoint at <http://localhost:4000/health>.

## Pipeline

```
ingest → enrich → triage (Haiku) → draft (Sonnet) → gates G1–G12
   → approval queue (human) → outbox → sender → metrics
```

**Escalation.** Triage runs on Haiku. When confidence falls below the
configured threshold the case is escalated to Sonnet and marked `escalated`.
Cheap model for volume, expensive model for the hard cases — the same shape as
low-confidence extraction handling in production systems. The escalation rate
is a dashboard metric, because it shows what uncertainty costs.

**Cost cap.** A configurable ceiling per campaign. On reaching it the run stops
and unfinished cases keep their current state. Never a silent continuation.

## State machine

```
INGESTED → TRIAGED → DRAFTED → GATED
                                 ├── BLOCKED        (a gate failed; goes to a human as blocked)
                                 └── PENDING_APPROVAL
                                        ├── REJECTED
                                        └── APPROVED → QUEUED → SENT
                                                             └── FAILED → QUEUED (retry)
```

Transitions are the only way to change state. `SENT` is terminal and
irreversible.

A draft that failed a blocking gate goes to `BLOCKED`, never to
`PENDING_APPROVAL`. The two are kept apart so the dashboard can show what the
agent got wrong — that is the raw material for the eval suite.

## How a second send is prevented

Not in application logic. Not in code review. In the database:

```sql
CREATE UNIQUE INDEX uq_attempt_sent
  ON outreach_attempts (merchant_id, campaign_id)
  WHERE state = 'SENT';
```

A partial unique index means at most one `SENT` row can exist for a given
merchant in a given campaign. Retries can rewrite a `FAILED` row freely, but
the moment one row reaches `SENT`, no other row for that pair can follow it.

Three more layers sit on top: a deterministic `dedup_key`
(`sha256(merchantId|campaignId|contentHash)`) with its own unique index, an
outbox whose rows are claimed by conditional `UPDATE` so two workers cannot
claim the same one, and an idempotency key passed to the delivery provider.

See [`shared/migrations/4_lifecycle.up.sql`](shared/migrations/4_lifecycle.up.sql).

## The LLM client

One client, three modes:

| Mode | Behaviour |
|---|---|
| `live` | Real call. Counts tokens and cost. |
| `record` | Real call, and the response is written to `fixtures/llm/<hash>.json`. |
| `fixture` | Reads from `fixtures/llm/`. No network. Deterministic. |

The fixture key is a stable SHA-256 of the prompt and its parameters. **When a
prompt changes and its fixture is missing, the run fails** with a message
saying how to re-record it. There is no fallback to a live call and no stub
response — a fallback would turn a prompt change into an invisible behaviour
change.

See [`services/agents/llm.ts`](services/agents/llm.ts).

## Why Encore

You declare a database or a queue in one line and it is provisioned and
monitored:

```ts
export const db = new SQLDatabase("outreach", { migrations: "./migrations" });
```

That property is the reason this repository uses it, and it has to be visible
in the code rather than asserted in a README.

## Why Python as well

The runtime is TypeScript, for the platform. Evaluation is Python, for the
ecosystem — and because evaluation should run independently of the
application. That is a decision, not an accident.

The Python side holds the eval harness: golden set, LLM-as-judge, regression
baseline, dataset tooling. Nothing crosses between the two languages at
runtime.

## Layout

```
merchant-outreach-agent/
├── shared/            # frozen contracts, domain errors, database + migrations
├── services/
│   ├── ingest/        # merchant intake and enrichment
│   ├── agents/        # triage and draft, LLM client, routing, cost
│   ├── gates/         # G01–G12, gate runner, report
│   ├── approval/      # queue, state machine, transitions
│   ├── sender/        # outbox worker, mock provider, idempotency
│   └── metrics/       # aggregation, campaign statistics
├── fixtures/          # recorded model responses, generated seed data
├── evals/             # Python: pytest, golden set, judge, baseline
├── dashboard/         # Next.js, deployed separately
└── scripts/           # generate merchants, run a campaign, record fixtures
```

`shared/` is a plain module rather than an Encore service, so every service can
import it. Each service owns the tables listed in its `encore.service.ts` and
reaches anything else through the owning service's API.

## Deliberately out of scope

These are decisions, not omissions:

- **No user authentication.** This is a demonstration, not a product.
- **No real email delivery.** The sender runs against a mock provider with a
  configurable failure rate.
- **No multi-tenancy.**
- **No A/B testing of message variants.**

## Roadmap

- [x] **WS0** — contracts, schema, service boundaries, LLM client, CI
- [ ] **WS1** — synthetic merchant generator, ingest, enrichment
- [~] **WS2** — triage and draft agents, escalation routing, cost accounting.
      Code complete; the prompts in
      [`services/agents/prompts/`](services/agents/prompts) are skeletons and
      still need writing, so no fixtures are recorded yet.
- [ ] **WS3** — gates G01–G12, each with a passing and a failing test
- [ ] **WS4** — approval queue, state machine, outbox, sender
- [ ] **WS5** — metrics, dashboard
- [ ] **WS6** — Python eval harness, golden set, regression baseline

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # vitest
npm run build       # typecheck + Encore container build
npm run verify      # all four, in order
encore run          # start the app locally
```

`npm run verify` is the one that matters. Three of the four steps passing is
not a green build — the build step needs Docker running, and it is the step
most likely to be skipped and most likely to be broken.

### Pre-commit hook

`npm install` points Git at the versioned hooks in [`.githooks/`](.githooks)
by setting `core.hooksPath`, so the hook arrives with a clone rather than
having to be installed by hand. That is why there is no Husky here: Husky
solves the same problem, but `core.hooksPath` needs no dependency, no
generated wrapper scripts, and no `node_modules` present for Git to find the
hook. The hooks are ordinary shell scripts you can read and run yourself.

If you cloned before this existed, or `core.hooksPath` got unset:

```bash
npm run prepare     # git config core.hooksPath .githooks
```

The hook runs `npm run verify` and blocks the commit if it fails.

**It is bypassable, on purpose:**

```bash
git commit --no-verify
```

A blocked commit in the middle of unfinished work is worse than a broken
commit on a branch — saving work in progress has to stay possible. The gate
that is not meant to be bypassed is CI, which runs the same checks on the
pushed branch and cannot be skipped from a developer's machine. If you commit
with `--no-verify`, run `npm run verify` before you push.

### CI

Typecheck, lint and unit tests on Node 20 and 22; an Encore build; and a
gitleaks scan over the full history.

## Licence

[MIT](LICENSE)
