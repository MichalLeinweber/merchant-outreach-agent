/**
 * Delivering one claimed outbox row.
 *
 * Split out of `worker.ts` for one reason, and it is a hard constraint rather
 * than a preference: importing `shared/db.ts` outside the Encore runtime
 * throws at module load, so anything a unit test imports must not reach the
 * database, directly or transitively. `worker.ts` owns the SQL; this file owns
 * the part between the claim and the write, and can therefore be tested
 * against the mock provider with no Postgres anywhere.
 *
 * It is also the part where the idempotency key earns its keep: every attempt
 * in the retry loop carries the same key, so the call after a timeout is
 * answered from the provider's store instead of delivering a second message.
 */

import { ProviderError } from "../../shared/errors.js";
import type { DeliveryRequest, MockDeliveryProvider } from "./provider.js";
import { withRetry, type RetryOptions } from "./retry.js";

/** The message body an outbox row carries, as stored in `outbox.payload`. */
export interface OutboxPayload {
  to: string;
  subject: string;
  body: string;
}

/** One row of `outbox`, as the worker sees it after a successful claim. */
export interface ClaimedOutboxRow {
  id: string;
  attemptId: string;
  payload: OutboxPayload;
  /** `outbox.idempotency_key` — the attempt's dedupKey. */
  idempotencyKey: string;
  /** Already incremented by the claim itself. */
  attemptCount: number;
  claimedAt: string;
  createdAt: string;
}

/** What one tick did, for logging and for the tests. */
export type TickResult =
  /** Nothing was claimable. The worker sleeps and tries again. */
  | { status: "idle" }
  /** Delivered (possibly by the provider recognising a repeated key). */
  | { status: "sent"; rowId: string; attemptId: string; messageId: string; deduplicated: boolean }
  /** Not delivered. The row stays claimable once its claim expires. */
  | { status: "failed"; rowId: string; attemptId: string; error: ProviderError | Error };

export interface WorkerDeps {
  provider: Pick<MockDeliveryProvider, "send">;
  /** Injectable clock, so a test can pin the instant a send is stamped with. */
  now?: () => Date;
  /** Overrides for the backoff. Defaults to `DEFAULT_RETRY_POLICY`. */
  retry?: RetryOptions;
}

/**
 * Try to deliver one claimed row.
 *
 * A failure is returned rather than thrown. The row is claimed; the caller
 * still has to record the outcome either way, and an exception here would
 * skip that.
 */
export async function deliverClaimedRow(
  row: ClaimedOutboxRow,
  deps: WorkerDeps,
): Promise<TickResult> {
  const request: DeliveryRequest = {
    idempotencyKey: row.idempotencyKey,
    to: row.payload.to,
    subject: row.payload.subject,
    body: row.payload.body,
  };

  try {
    const receipt = await withRetry(() => deps.provider.send(request), deps.retry ?? {});
    return {
      status: "sent",
      rowId: row.id,
      attemptId: row.attemptId,
      messageId: receipt.messageId,
      deduplicated: receipt.deduplicated,
    };
  } catch (error) {
    return {
      status: "failed",
      rowId: row.id,
      attemptId: row.attemptId,
      error: error instanceof Error ? error : new ProviderError(String(error), false),
    };
  }
}
