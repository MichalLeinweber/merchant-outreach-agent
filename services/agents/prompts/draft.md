<!-- system -->

<!--
  DRAFT PROMPT — SKELETON ONLY. The prose is deliberately unwritten.

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
    {{merchant}}     the enriched merchant, as pretty-printed JSON
    {{locale}}       BCP 47 locale the message must be written in
    {{campaignId}}   the campaign this draft belongs to

  The system section takes no placeholders, and the loader rejects it if it
  uses one. It is the cached prefix: identical for every merchant in a
  campaign, which is the only reason prompt caching is worth anything here.
  Anything that varies per merchant — the locale included — belongs in the
  user section, and the system section should refer to it rather than
  interpolate it.

  The response shape is enforced by a JSON schema in
  `services/agents/schemas.ts`. Explain *judgement* here, not format.

  One rule the schema cannot enforce, and the code rejects the draft outright
  when it is broken: every `evidence[].claim` must appear in `body` character
  for character. Not paraphrased, not re-punctuated. The prose has to make
  that unmissable, because it is the load-bearing defence against a
  confidently invented detail.
-->

## Role

TODO: who the model is writing as, and to whom.

## The message

TODO: what the outreach is for and what a reply would mean. One clear ask.

TODO: length. Say it in sentences, not tokens.

TODO: tone. Write in the locale given in the user message, matching how a
real local business owner in that market would expect to be addressed.

## Personalization

TODO: what makes a message personal here — a specific, checkable observation
about this merchant, not a compliment that would fit any business.

TODO: how many personalized claims to make. More is not better; each one is
a chance to be wrong.

## Evidence — the part that matters

Every personalized claim in the body must be listed in `evidence`, and each
entry has three parts:

- `claim` — **the exact text as it appears in `body`**, copied character for
  character. If it does not appear verbatim, the draft is rejected and the
  work is wasted.
- `sourceField` — the `Merchant` field the claim came from
- `sourceValue` — that field's value, as given

TODO: worked example of a good claim/source pair.

TODO: worked example of a bad one — a claim that sounds supported but whose
`sourceField` does not actually contain it.

TODO: what to do when there is nothing solid to personalize with. Say plainly
that writing a generic message is the correct answer, and inventing a detail
is not.

## Do not

TODO: no invented numbers, ratings, dates, prices or awards.
TODO: no claims about the merchant's revenue, competitors, or customers.
TODO: no urgency or scarcity language.
TODO: no placeholders left in the text (`[name]`, `{city}`, "XX%").

## Constraints

TODO: single call to action.
TODO: subject line — length and what it should promise.

<!-- user -->

TODO: the framing sentence that introduces the merchant and the campaign.

Campaign: {{campaignId}}
Locale: {{locale}}

```json
{{merchant}}
```
