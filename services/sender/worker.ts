/**
 * The outbox worker.
 *
 * One tick is three steps: claim a row by writing to it, try to deliver it,
 * record what happened. The claim and the record are the two points where
 * correctness lives in SQL, and they are kept at the top level so neither can
 * be quietly buried inside the delivery logic. The middle step lives in
 * `delivery.ts`, which touches no database.
 *
 * The tick is deliberately one row at a time. Batching would be faster and
 * would make the claim harder to reason about, and throughput is not this
 * project's problem — provable single delivery is.
 *
 * Owns: `outbox`. It also writes `outreach_attempts` when a delivery
 * resolves; see the note on `recordTickResult`.
 */

import type { OutreachAttempt } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import { rowToAttempt, type AttemptRow } from "../approval/rows.js";
import { applyTransition } from "../approval/state-machine.js";
import { deliverClaimedRow, type ClaimedOutboxRow, type TickResult, type WorkerDeps } from "./delivery.js";

export {
  deliverClaimedRow,
  type ClaimedOutboxRow,
  type OutboxPayload,
  type TickResult,
  type WorkerDeps,
} from "./delivery.js";

/** A transaction, as `db.begin()` hands it out. */
type Transaction = Awaited<ReturnType<typeof db.begin>>;

/**
 * How long a claim is held before another worker may take the row.
 *
 * Five minutes, per `docs/idempotency.md`. This is the answer to "the worker
 * was killed mid-send": nothing is lost, the row simply becomes claimable
 * again, and the idempotency key makes the second delivery a no-op.
 */
export const CLAIM_TIMEOUT_MINUTES = 5;

interface OutboxRow {
  id: string;
  attempt_id: string;
  payload: unknown;
  idempotency_key: string;
  claimed_at: Date | string | null;
  attempt_count: number;
  created_at: Date | string;
}

// ─── One tick ──────────────────────────────────────────────────

export async function runOutboxWorkerOnce(deps: WorkerDeps): Promise<TickResult> {
  const row = await claimNextOutboxRow();
  if (row === null) return { status: "idle" };

  const result = await deliverClaimedRow(row, deps);
  await recordTickResult(row, result, deps.now?.() ?? new Date());
  return result;
}

/**
 * Take ownership of the oldest claimable row, or return null.
 *
 * Every clause here is load-bearing:
 *
 * - **The claim is a write, never a read.** A `SELECT` followed by an
 *   `UPDATE` is two statements with a gap between them, and two workers will
 *   eventually both win that gap. This is a single `UPDATE ... RETURNING *`,
 *   so "which row is mine" and "nobody else may have it" are the same fact,
 *   decided by the database.
 *
 * - **`FOR UPDATE SKIP LOCKED` in the inner select.** Without it, a second
 *   worker blocks on the row the first one is claiming and then claims it
 *   anyway once the lock lifts. With it, the second worker skips straight to
 *   the next row: concurrent workers never contend and never overlap.
 *
 * - **Claimable is `processed_at IS NULL` and an expired-or-absent claim.**
 *   The first half makes a redelivered queue message a no-op; the second is
 *   the crash recovery — a worker that died holding a claim releases it by
 *   the clock, not by anyone noticing.
 *
 * - **`ORDER BY created_at`, `LIMIT 1`.** Oldest first, one row per tick.
 *   This is what `ix_outbox_claimable` exists for.
 *
 * - **`attempt_count` is incremented by the claim itself.** The count is
 *   evidence of how often a row was retried; incrementing it after a delivery
 *   would lose exactly the crashes it is there to record.
 *
 * Returns null when nothing is claimable — an ordinary idle tick, not an error.
 */
export async function claimNextOutboxRow(): Promise<ClaimedOutboxRow | null> {
  const row = await db.queryRow<OutboxRow>`
    UPDATE outbox
       SET claimed_at = NOW(), attempt_count = attempt_count + 1
     WHERE id = (
         SELECT id FROM outbox
          WHERE processed_at IS NULL
            AND (claimed_at IS NULL
                 OR claimed_at < NOW() - make_interval(mins => ${CLAIM_TIMEOUT_MINUTES}))
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
     )
     RETURNING id, attempt_id, payload, idempotency_key, claimed_at, attempt_count, created_at
  `;

  return row === null ? null : toClaimedRow(row);
}

/**
 * Persist the outcome of a tick, in one transaction.
 *
 * On success both writes land together: an outbox row marked processed while
 * its attempt stayed `QUEUED` would be a message nobody can account for, and
 * an attempt marked `SENT` while its outbox row stayed claimable would be
 * delivered again five minutes later.
 *
 * What is deliberately *not* here: nothing re-reads the attempt to check
 * whether it was already sent. That check would be a race between the read
 * and the write. `uq_attempt_sent` is the check, it runs inside the same
 * commit, and a violation is allowed to surface — see `markSent`.
 *
 * A note on the boundary: this writes `outreach_attempts`, which the approval
 * service owns, and it moves the row with that service's `applyTransition`.
 * The architecture says to go through the owning service's API; that needs
 * `~encore/clients`, which is generated code CI does not have when it
 * typechecks a fresh clone. Same deviation as in `approval/rows.ts`, same
 * reason, and it is worth arguing about before the PR is merged.
 */
export async function recordTickResult(
  row: ClaimedOutboxRow,
  result: TickResult,
  now: Date = new Date(),
): Promise<void> {
  if (result.status === "idle") return;

  const tx = await db.begin();
  try {
    if (result.status === "sent") {
      await markSent(tx, row, result.messageId, now);
    } else if (result.status === "failed") {
      await markFailed(tx, row, result.error, now);
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/**
 * The delivery succeeded: close the outbox row and move the attempt to `SENT`.
 *
 * If another row for the same merchant and campaign is already `SENT`, this
 * throws — `uq_attempt_sent` rejects the update, the transaction rolls back,
 * and the error propagates. That is the whole point of the index and the last
 * line of defence in the design; catching it here would turn the one thing
 * the database can prove into something application code decides.
 */
async function markSent(
  tx: Transaction,
  row: ClaimedOutboxRow,
  messageId: string,
  now: Date,
): Promise<void> {
  const attempt = await loadAttemptForUpdate(tx, row.attemptId);
  const sent = applyTransition(requeueIfFailed(attempt, now), "SENT", {
    at: now,
    providerMessageId: messageId,
  });

  const updated = await tx.queryRow<{ id: string }>`
    UPDATE outreach_attempts
       SET state               = ${sent.state},
           sent_at             = ${sent.sentAt}::timestamptz,
           provider_message_id = ${sent.providerMessageId},
           failure_reason      = NULL,
           attempt_count       = ${sent.attemptCount},
           updated_at          = ${sent.updatedAt}::timestamptz
     WHERE id = ${attempt.id} AND state = ${attempt.state}
     RETURNING id
  `;
  assertWritten(updated, attempt.id, "SENT");

  await tx.exec`
    UPDATE outbox
       SET processed_at = ${now.toISOString()}::timestamptz, last_error = NULL
     WHERE id = ${row.id}
  `;
}

/**
 * The delivery failed: record why, and leave the row to become claimable
 * again on its own.
 *
 * `processed_at` and `claimed_at` are deliberately not cleared. The row
 * returns to the queue when the five-minute claim expires, which throttles a
 * permanently failing row instead of spinning on it. `FAILED` is not
 * terminal — the state machine allows `FAILED -> QUEUED` for the retry.
 */
async function markFailed(
  tx: Transaction,
  row: ClaimedOutboxRow,
  error: Error,
  now: Date,
): Promise<void> {
  const attempt = await loadAttemptForUpdate(tx, row.attemptId);
  const failed = applyTransition(requeueIfFailed(attempt, now), "FAILED", {
    at: now,
    failureReason: error.message,
  });

  const updated = await tx.queryRow<{ id: string }>`
    UPDATE outreach_attempts
       SET state          = ${failed.state},
           failure_reason = ${failed.failureReason},
           attempt_count  = ${failed.attemptCount},
           updated_at     = ${failed.updatedAt}::timestamptz
     WHERE id = ${attempt.id} AND state = ${attempt.state}
     RETURNING id
  `;
  assertWritten(updated, attempt.id, "FAILED");

  await tx.exec`
    UPDATE outbox SET last_error = ${error.message} WHERE id = ${row.id}
  `;
}

/**
 * A re-claimed row belongs to an attempt that is `FAILED`, not `QUEUED`.
 *
 * The first delivery failed, the attempt was moved to `FAILED`, and five
 * minutes later the claim expired and the row came back. The state machine
 * says the way back is `FAILED -> QUEUED`, and only then `-> SENT`, so the
 * retry takes that path rather than jumping the edge that does not exist.
 *
 * It happens inside the same transaction as the outcome, so the intermediate
 * `QUEUED` is never observable — but the path is still the legal one, and
 * `attemptCount` gets the increment that makes the retry visible in the data.
 */
function requeueIfFailed(attempt: OutreachAttempt, now: Date): OutreachAttempt {
  return attempt.state === "FAILED" ? applyTransition(attempt, "QUEUED", { at: now }) : attempt;
}

async function loadAttemptForUpdate(tx: Transaction, attemptId: string) {
  const row = await tx.queryRow<AttemptRow>`
    SELECT * FROM outreach_attempts WHERE id = ${attemptId} FOR UPDATE
  `;

  if (row === null) {
    throw new Error(
      `Outbox row references attempt ${attemptId}, which does not exist. ` +
        `The foreign key makes this unreachable; the run stops rather than guessing.`,
    );
  }

  return rowToAttempt(row);
}

function toClaimedRow(row: OutboxRow): ClaimedOutboxRow {
  const payload: unknown = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;

  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Outbox row ${row.id}: payload is not an object.`);
  }

  const { to, subject, body } = payload as Record<string, unknown>;
  if (typeof to !== "string" || typeof subject !== "string" || typeof body !== "string") {
    throw new Error(
      `Outbox row ${row.id}: payload is missing to, subject or body. ` +
        `Refusing to send a message whose recipient or text is unknown.`,
    );
  }

  return {
    id: row.id,
    attemptId: row.attempt_id,
    payload: { to, subject, body },
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    claimedAt: toIso(row.claimed_at) ?? new Date(0).toISOString(),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * A guarded update that changed nothing.
 *
 * The row is locked for the length of the transaction and `applyTransition`
 * has already checked the state, so this cannot fire. It throws rather than
 * shrugging because if it ever does fire, something is true about the
 * database that this file does not know, and continuing would mean writing an
 * outbox row as processed for an attempt that never moved.
 */
function assertWritten(row: { id: string } | null, attemptId: string, to: string): void {
  if (row === null) {
    throw new Error(
      `Attempt ${attemptId} changed state underneath a locked transaction while ` +
        `recording ${to}. Nothing was written.`,
    );
  }
}

/*
 * A note on the other direction: there is deliberately no `enqueue()` here.
 *
 * Writing the `outbox` row is not this service's job — it happens inside the
 * approval transaction, in the same commit that moves the attempt out of
 * `PENDING_APPROVAL`. That is the whole point of a transactional outbox, and
 * splitting it across two services would reintroduce the gap it removes.
 * `uq_outbox_attempt` makes a second enqueue for the same attempt a conflict
 * rather than a second delivery.
 */
