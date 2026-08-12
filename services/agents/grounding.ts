/**
 * Evidence grounding.
 *
 * `EvidenceRef.claim` must be an exact substring of the draft body. This is
 * the single check that makes the difference between "the model wrote
 * something plausible" and "the model can point at the words it used".
 *
 * Deliberately strict: no trimming, no case folding, no whitespace
 * normalisation, no fuzzy matching. A claim that is *nearly* in the body is a
 * failure. Every relaxation here is a place a hallucination can hide, and the
 * rate at which the model gets this wrong is one of the numbers this project
 * exists to report — softening the check would make that number look better
 * while making the pipeline worse.
 */

import type { EvidenceRef } from "../../shared/contracts.js";
import { EvidenceNotGroundedError } from "../../shared/errors.js";

/** Claims that do not appear verbatim in the body, in the order given. */
export function findUngroundedClaims(
  body: string,
  evidence: readonly EvidenceRef[],
): string[] {
  return evidence.filter((ref) => !body.includes(ref.claim)).map((ref) => ref.claim);
}

/**
 * Throw unless every claim appears verbatim in the body.
 *
 * The draft is rejected, not repaired. Repairing it — dropping the bad
 * evidence entry, or rewording the body to match — would produce a draft that
 * passes review while hiding that the model invented something.
 */
export function assertEvidenceGrounded(
  merchantId: string,
  body: string,
  evidence: readonly EvidenceRef[],
): void {
  const ungrounded = findUngroundedClaims(body, evidence);
  if (ungrounded.length > 0) {
    throw new EvidenceNotGroundedError(merchantId, ungrounded);
  }
}
