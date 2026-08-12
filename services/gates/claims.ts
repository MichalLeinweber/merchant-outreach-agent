/**
 * G13 — the number of personalized claims.
 *
 * Not in EVALS.md and not in the contract; this workstream adds it because
 * there was a rule nothing enforced. The draft prompt says "Write exactly
 * three personalized claims", and three is a considered number: enough that
 * the message could not have been sent to anyone else, few enough that each
 * one can be checked. Until now the pipeline had no idea whether the model
 * complied. A draft with one claim and a paragraph of filler passed every
 * gate, because every gate that looked at claims looked at whether the ones
 * present were true — never at whether there were any.
 *
 * It warns rather than blocks, and the reason is the empty case. When a
 * record has no rating, no reviews and no signals worth naming, the prompt
 * tells the model to write a plain message and return no evidence at all.
 * That is the pipeline working: a true generic message beats an invented
 * specific one. Blocking on the count would put the correct answer to a hard
 * case in the same bucket as a hallucination, which is precisely backwards.
 * So the count is reported, visible in the report and in the strip, and the
 * send continues.
 */

import type { TextSpan } from "../../shared/contracts.js";
import { firstFreeSpan, quote } from "./text.js";
import { fail, G13_CLAIM_COUNT, pass, type Gate } from "./types.js";

/** What the draft prompt mandates. */
export const REQUIRED_CLAIM_COUNT = 3;

export const g13ClaimCount: Gate = (draft) => {
  const count = draft.evidence.length;
  if (count === REQUIRED_CLAIM_COUNT) return pass(G13_CLAIM_COUNT);

  // Locate whatever claims there are, so the reviewer can see which parts of
  // the body were treated as personalized and which were filler.
  const spans: TextSpan[] = [];
  for (const ref of draft.evidence) {
    const span = firstFreeSpan(draft.body, ref.claim, spans);
    if (span !== null) spans.push(span);
  }

  if (count === 0) {
    return fail(
      G13_CLAIM_COUNT,
      `Draft makes no personalized claims; the prompt asks for ` +
        `${REQUIRED_CLAIM_COUNT}. This is the correct output when the record ` +
        `holds nothing worth quoting, so check the merchant record before ` +
        `treating it as a defect — a true generic message beats an invented ` +
        `specific one.`,
    );
  }

  const direction = count < REQUIRED_CLAIM_COUNT ? "fewer" : "more";

  return fail(
    G13_CLAIM_COUNT,
    `Draft makes ${count} personalized claim(s), ${direction} than the ` +
      `${REQUIRED_CLAIM_COUNT} the prompt asks for` +
      `${count > REQUIRED_CLAIM_COUNT ? ", and every extra claim is another chance to be wrong" : ""}. ` +
      `Claims made: ${draft.evidence.map((ref) => quote(ref.claim, 40)).join(", ")}.`,
    spans,
  );
};
