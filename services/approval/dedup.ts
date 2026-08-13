/**
 * The deduplication key.
 *
 * ```
 * dedupKey = sha256(merchantId | campaignId | sha256(subject + body))
 * ```
 *
 * The first layer of defence in `docs/idempotency.md`, and the one everything
 * else hangs off. Same content, same merchant, same campaign => the same key
 * => `uq_attempt_dedup` turns a second insert into a conflict rather than a
 * duplicate. It is also what travels to the provider as `Idempotency-Key`, so
 * the key is the single thing that ties an approval, an outbox row and an
 * outbound request together.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * - **Derived from content, not from a row id.** A key that came from the
 *   attempt id would make every retry unique, and the provider's idempotency
 *   check would never fire.
 * - **Recomputed whenever the content changes.** Editing a draft and keeping
 *   the old key would let the edited message be deduplicated against the one
 *   it replaced: the provider would return the original `messageId` and the
 *   edit would silently never go out.
 */

import { createHash } from "node:crypto";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Hash of the message text.
 *
 * The formula in `docs/idempotency.md` is `sha256(subject + body)` and it is
 * kept literally, separator and all — the document is the artifact this repo
 * is meant to be read against, and a key that does not match the written
 * formula would be worse than the theoretical ambiguity it removes. (That
 * ambiguity: subject "ab" with body "c" hashes the same as subject "a" with
 * body "bc". Both would have to be drafted for the same merchant in the same
 * campaign to collide.)
 */
export function contentHash(subject: string, body: string): string {
  return sha256(subject + body);
}

export function computeDedupKey(
  merchantId: string,
  campaignId: string,
  subject: string,
  body: string,
): string {
  return sha256(`${merchantId}|${campaignId}|${contentHash(subject, body)}`);
}
