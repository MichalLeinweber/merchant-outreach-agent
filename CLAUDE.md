# CLAUDE.md — merchant-outreach-agent

Project rules. These override the global rules in `~/.claude/CLAUDE.md` where
they conflict.

## Reporting completion

**Never report a task as done without running `npm run verify` first.**

```bash
npm run verify   # typecheck && lint && test && build (build == tsc --noEmit)
```

### What `verify` covers, and what it does not

| Covered | Not covered |
|---|---|
| `tsc --noEmit` (twice: as `typecheck` and as `build`) | **The Encore container build** — `npm run build:docker`, which needs Docker and the Encore CLI. CI runs it as its own job. |
| `eslint .` | **The dashboard** — `dashboard/` is a separate Next.js application with its own build, outside this workspace. |
| `vitest run` — unit tests, no database | **Anything needing Postgres.** The unit suite never touches the database, so SQL in the service layer is typechecked but not executed. |

A green `verify` therefore means "this compiles, lints and its unit tests
pass". It does not mean the application builds as a container, and it does not
mean an endpoint that talks to Postgres works. Say which of the two you have
evidence for; do not let one stand in for the other.

Rules that follow from that:

- **Quote the output verbatim.** Paste what the command printed, including the
  exit code. A summary is not evidence — the reader has to be able to see the
  result rather than take your word for it.
- **"Validation passed" means `verify` passed as a whole.** It does not mean
  three of its four steps passed. If you ran only part of it, say which part
  and say that the rest is unverified.
- **If a step fails, report the failure.** Do not report success for the steps
  that happened to pass and leave the failure out.

This rule exists because it was broken once. `typecheck`, `lint` and `test`
were run and reported as "validation passed"; the build was not run, and it was
the one that was broken. CI caught it, which is the point of CI — but the
report that preceded it was wrong.

### When a step cannot run

`npm run build:docker` needs Docker and the Encore CLI, and it is slow. It is
deliberately outside `verify` and outside the pre-commit hook, so neither
depends on Docker being up. That is also why nothing may claim the container
build passed on the strength of `verify`: name it as unverified, and let CI be
the thing that proves it.

The same applies to any step you skipped for any reason. Say which one, and say
what is therefore unverified. Do not silently drop it and report the rest as a
pass.

## Contracts are frozen

`shared/contracts.ts` does not change on a feature branch. Every other
workstream depends on it byte for byte, and a change there blocks all of them.
If a change is genuinely needed, open a dedicated pull request for it alone and
tell the other workstream before merging.

## No silent fallbacks

When something is missing or wrong, fail loudly with a message that says what
to do about it. Specifically:

- A missing LLM fixture in `fixture` mode is a hard error naming the command
  that re-records it. It never falls back to a live call or a stub response.
- Reaching the campaign cost cap stops the run. Unprocessed merchants keep
  their current state; the run does not quietly continue at a lower quality.
- A blocking gate failure sends a draft to `BLOCKED`, never to
  `PENDING_APPROVAL`.

A fallback turns a behaviour change into an invisible one, which is the
failure mode this whole project is built to demonstrate against.

## Invariants belong in the database

Where a rule can be expressed as a constraint or an index, put it there rather
than in application code. `uq_attempt_sent`, `merchants_email_synthetic` and
`attempts_sent_requires_receipt` are the existing examples. Application code
can be bypassed by the next caller; a constraint cannot.

## Secrets

No API key ever goes into the repository, into a commit message, or into a
chat. `.env.local` only, and it is gitignored. `.env.example` carries the
variable names with empty values.

## Data is synthetic

Every merchant, address and email address in this repository is generated.
Contact addresses always end in `@example.invalid`, and the database enforces
it.
