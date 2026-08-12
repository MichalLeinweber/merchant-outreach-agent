<!-- system -->

<!--
  TRIAGE PROMPT — SKELETON ONLY. The prose is deliberately unwritten.

  How this file is used
  ---------------------
  The file is split at the two section markers below, each of which sits alone
  on its own line. Text after the system marker becomes the system prompt;
  text after the user marker becomes the user message. Comments like this one
  are stripped from both, so they cost nothing and the model never sees them.

  Both sections are rendered with double-brace substitution, e.g. merchant
  below. Naming a placeholder with no value supplied is an error, never an
  empty string.

  Available placeholders — USER SECTION ONLY:
    {{merchant}}   the enriched merchant, as pretty-printed JSON, including
                   its derived `signals` array

  The system section takes no placeholders, and the loader rejects it if it
  uses one. It is the cached prefix: every merchant in a campaign reuses it,
  and editing it invalidates the prompt cache and every recorded triage
  fixture. Anything that varies per merchant belongs in the user section.

  What the model must return is NOT described here. The response shape is
  enforced by a JSON schema in `services/agents/schemas.ts`, so this prompt
  should explain *judgement*, not format. Do not restate the field list.

  Two limits the schema cannot enforce, so the prose has to:
    - `reason` must be at most 240 characters (the database rejects longer)
    - `score` is 0–100 and `confidence` is 0–1
-->

## Role

TODO: who the model is and whose interests it serves.

## What you are deciding

TODO: state the decision. It is not "write outreach" — it is "is this merchant
worth approaching in this campaign, and how sure are you".

## Scoring

TODO: what a score of 0–100 means, and what moves it up or down. Name the
signals that matter (`deal_gap`, `high_rating_low_volume`, `seasonal_window`,
`capacity_headroom`, `new_to_market`) and how to weigh them against each other.

TODO: what a merchant with `hasActiveOffer: true` should score, and why.

## Confidence

TODO: what `confidence` measures — how sure the model is of its own score,
not how good the merchant is. These are different numbers and the prompt has
to say so, because conflating them is what makes escalation useless.

TODO: when confidence should be low. Missing fields, contradictory signals,
and categories that do not fit the marketplace are the obvious cases.

Confidence below the configured threshold sends this merchant to a stronger
model for a second opinion, so an honest low number is cheap and a
falsely-confident high number is expensive.

## Recommended action

TODO: when to answer `pursue`, `skip`, or `needs_human`, and how that relates
to the score. Say explicitly that `needs_human` is a legitimate answer rather
than an admission of failure.

## Reason

TODO: what belongs in the one-line reason. It is read by a human deciding
whether to trust the score, so it should cite the signal that drove the
decision. Maximum 240 characters.

## Constraints

TODO: no invented facts. Every judgement rests on the fields provided and
nothing else. Absence of data is not evidence.

<!-- user -->

TODO: the framing sentence that introduces the merchant.

```json
{{merchant}}
```
