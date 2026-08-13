/**
 * The approval API — the human gate.
 *
 * Nothing reaches the outbox without one of these three calls. Each one runs
 * as a single transaction that does the state change and the outbox insert
 * together, because the guarantee is exactly that pair being atomic: there is
 * no instant at which an attempt is approved but unqueued, or queued but
 * unapproved.
 *
 * The shared rule for all three, and the reason they can be called twice with
 * no harm: **a repeated call returns the existing attempt, it does not
 * produce a second one.** Two things make that safe rather than hopeful —
 * `SELECT ... FOR UPDATE` at the top of the transaction, which serialises two
 * concurrent clicks on the same row, and the `AND state = ...` predicate on
 * every update, which means a stale caller changes nothing even if the lock
 * were removed.
 *
 * Owns: `outreach_attempts`. Reads `drafts` and `merchants`; see the note in
 * `rows.ts` about that boundary.
 */

import { randomUUID } from "node:crypto";

import { api, APIError } from "encore.dev/api";

import type { OutreachAttempt, OutreachState } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import { blockingFailures, makeGateContext, runGates, toContractReport } from "../gates/index.js";
import { computeDedupKey } from "./dedup.js";
import {
  rowToAttempt,
  rowToDraft,
  rowToMerchant,
  type AttemptRow,
  type DraftRow,
  type MerchantRow,
} from "./rows.js";
import { isUniqueViolation } from "./sql.js";
import { allowedTargets, applyTransition } from "./state-machine.js";

/** A transaction, as `db.begin()` hands it out. */
type Transaction = Awaited<ReturnType<typeof db.begin>>;

// ─── Shared shapes ─────────────────────────────────────────────

export interface ApprovalResponse {
  /** The attempt as it now stands. */
  attempt: OutreachAttempt;
  /**
   * True when this call changed nothing because the decision had already been
   * recorded — the second of two clicks, or a retried request.
   *
   * The client renders both the same way. It is here so that a duplicate is
   * visible in the logs and provable in a test, rather than indistinguishable
   * from the first call.
   */
  alreadyApplied: boolean;
  /**
   * Blocking gates that failed when the gates were re-run over an edit.
   * Empty unless the attempt came back `BLOCKED`.
   */
  blockedGates: string[];
}

/** Longest reviewer identifier we accept; keeps a stray payload out of the audit trail. */
const MAX_ACTOR_LENGTH = 200;
const MAX_REASON_LENGTH = 1000;

/**
 * States in which an approval has already been recorded.
 *
 * `FAILED` is in the list because a failed delivery was still approved — the
 * decision stands and the retry belongs to the worker, not to a second click.
 */
const APPROVAL_ALREADY_RECORDED: readonly OutreachState[] = [
  "APPROVED", "QUEUED", "SENT", "FAILED",
];

// ─── Approve ───────────────────────────────────────────────────

export interface ApproveRequest {
  /** Attempt id, from the path. */
  id: string;
  /** Who approved it. Recorded in `approved_by`; there is no anonymous approval. */
  approvedBy: string;
}

/**
 * Approve a drafted message and queue it for delivery.
 *
 * The gates are not re-run here: this is a decision about content that has
 * already been gated, and the human is deciding whether to send exactly that.
 * `editAndApprove` is the call that changes content, and it does re-run them.
 */
export const approve = api(
  { expose: true, method: "POST", path: "/approval/attempts/:id/approve" },
  async (request: ApproveRequest): Promise<ApprovalResponse> => {
    const approvedBy = requireActor(request.approvedBy, "approvedBy");
    const now = new Date();

    return withTransaction(async (tx) => {
      const attempt = await loadAttemptForUpdate(tx, request.id);

      const alreadyDone = duplicateOf(attempt, APPROVAL_ALREADY_RECORDED);
      if (alreadyDone !== null) return alreadyDone;
      requireState(attempt, "PENDING_APPROVAL", "approved");

      const { draft, merchant } = await loadDraftAndMerchant(tx, attempt);

      // The attempt's own dedupKey, unchanged, so the provider sees the same
      // Idempotency-Key on every retry of this message.
      const queued = await queueForDelivery(tx, attempt, approvedBy, now, {
        to: merchant.contactEmail,
        subject: draft.subject,
        body: draft.body,
        dedupKey: attempt.dedupKey,
      });

      return { attempt: queued, alreadyApplied: false, blockedGates: [] };
    });
  },
);

// ─── Reject ────────────────────────────────────────────────────

export interface RejectRequest {
  id: string;
  /** Who rejected it. */
  rejectedBy: string;
  /**
   * Why. Required, and not for bureaucracy: rejection reasons are the only
   * labelled data the pipeline produces about what the model gets wrong.
   */
  reason: string;
}

/**
 * Reject a drafted message. It is never sent and never queued.
 *
 * No outbox row is written, and none is deleted — a rejected attempt never
 * had one. Rejecting an already-approved attempt fails rather than
 * "unapproving" it: by then the outbox row exists and a worker may be
 * mid-delivery, which is why `REJECTED` is not reachable from `APPROVED` in
 * the transition table.
 */
export const reject = api(
  { expose: true, method: "POST", path: "/approval/attempts/:id/reject" },
  async (request: RejectRequest): Promise<ApprovalResponse> => {
    const rejectedBy = requireActor(request.rejectedBy, "rejectedBy");
    const reason = (request.reason ?? "").trim();

    if (reason.length === 0) {
      throw APIError.invalidArgument(
        `reason is required when rejecting attempt ${request.id}. ` +
          `Rejections without a reason are the ones nobody can learn anything from.`,
      );
    }
    if (reason.length > MAX_REASON_LENGTH) {
      throw APIError.invalidArgument(
        `reason is ${reason.length} characters; the maximum is ${MAX_REASON_LENGTH}.`,
      );
    }

    const now = new Date();

    return withTransaction(async (tx) => {
      const attempt = await loadAttemptForUpdate(tx, request.id);

      const alreadyDone = duplicateOf(attempt, ["REJECTED"]);
      if (alreadyDone !== null) return alreadyDone;
      requireState(attempt, "PENDING_APPROVAL", "rejected");

      // The reason is recorded by the transition, not written straight into
      // the UPDATE, so that "a rejection carries a reason" is a rule of the
      // state machine rather than of this one handler.
      const rejected = applyTransition(attempt, "REJECTED", {
        at: now,
        failureReason: `Rejected by ${rejectedBy}: ${reason}`,
      });

      const row = await tx.queryRow<AttemptRow>`
        UPDATE outreach_attempts
           SET state          = ${rejected.state},
               failure_reason = ${rejected.failureReason},
               updated_at     = ${rejected.updatedAt}::timestamptz
         WHERE id = ${attempt.id} AND state = ${attempt.state}
         RETURNING *
      `;

      return {
        attempt: rowToAttempt(assertUpdated(row, attempt)),
        alreadyApplied: false,
        blockedGates: [],
      };
    });
  },
);

// ─── Edit and approve ──────────────────────────────────────────

export interface EditAndApproveRequest {
  id: string;
  approvedBy: string;
  /** The edited subject line. */
  subject: string;
  /** The edited body. */
  body: string;
}

/**
 * Edit a draft and approve the edited version in one step.
 *
 * The subtle one, because edited content is *different* content:
 *
 * - The `dedupKey` is recomputed from the edited text. Reusing the original
 *   would let the edited message be deduplicated against the message it
 *   replaced — the provider would return the old `messageId` and the edit
 *   would silently never go out.
 * - The gates run again over the edited body. A human editing a draft can
 *   introduce exactly what the gates exist to catch, and a blocking failure
 *   sends the attempt to `BLOCKED`, not to the queue. A message is not
 *   trustworthy because a person typed it.
 * - The edit, the gate report and the state change share one transaction, so
 *   the queue can never show text nobody approved.
 *
 * Editing a `BLOCKED` attempt is not this endpoint: `BLOCKED` is terminal, and
 * new content means a new `dedupKey`, which means a new attempt row. The
 * blocked row stays as the record of what was caught.
 */
export const editAndApprove = api(
  { expose: true, method: "POST", path: "/approval/attempts/:id/edit-and-approve" },
  async (request: EditAndApproveRequest): Promise<ApprovalResponse> => {
    const approvedBy = requireActor(request.approvedBy, "approvedBy");
    const subject = (request.subject ?? "").trim();
    const body = (request.body ?? "").trim();

    // Only emptiness is checked here. Length limits, placeholders, grounding
    // and the rest belong to the gates, which run over the edited text inside
    // the transaction — checking them twice in two places is how the two
    // answers start to disagree.
    if (subject.length === 0 || body.length === 0) {
      throw APIError.invalidArgument(
        `subject and body must both be non-empty when editing attempt ${request.id} ` +
          `(subject: ${subject.length} chars, body: ${body.length} chars).`,
      );
    }

    const now = new Date();

    return withTransaction(async (tx) => {
      const attempt = await loadAttemptForUpdate(tx, request.id);

      const alreadyDone = duplicateOf(attempt, APPROVAL_ALREADY_RECORDED);
      if (alreadyDone !== null) return alreadyDone;
      requireState(attempt, "PENDING_APPROVAL", "edited and approved");

      const { draft, merchant } = await loadDraftAndMerchant(tx, attempt);

      await tx.exec`
        UPDATE drafts
           SET subject = ${subject}, body = ${body}
         WHERE id = ${draft.id}
      `;

      // The evidence array is left as the model wrote it. An edit that breaks
      // a claim's grounding must show up as a G05 failure, not be tidied away
      // by dropping the claim that no longer matches.
      const edited = { ...draft, subject, body };
      const report = runGates(
        edited,
        merchant,
        makeGateContext(now.toISOString(), {
          previousApproach: await loadPreviousApproach(tx, attempt),
        }),
      );
      await saveGateReport(tx, report);

      const dedupKey = computeDedupKey(attempt.merchantId, attempt.campaignId, subject, body);

      if (report.blocked) {
        const blocked = applyTransition(attempt, "BLOCKED", { at: now });
        const row = await updateAttemptState(tx, attempt, blocked, dedupKey);

        // Committed, not rolled back: the edit and the reason it was caught
        // are what the reviewer needs to see next.
        return {
          attempt: rowToAttempt(row),
          alreadyApplied: false,
          blockedGates: blockingFailures(report),
        };
      }

      const queued = await queueForDelivery(tx, attempt, approvedBy, now, {
        to: merchant.contactEmail,
        subject,
        body,
        dedupKey,
      });

      return { attempt: queued, alreadyApplied: false, blockedGates: [] };
    });
  },
);

// ─── The one path that queues anything ─────────────────────────

/** Everything the outbox row needs. */
interface OutboundContent {
  to: string;
  subject: string;
  body: string;
  dedupKey: string;
}

/**
 * Approve an attempt and write its outbox row, in the caller's transaction.
 *
 * Shared by `approve` and `editAndApprove` rather than duplicated, so there is
 * exactly one place where a message becomes sendable.
 *
 * `APPROVED` is passed through rather than rested in: the same commit that
 * approves also enqueues, so an attempt is never observably approved without
 * an outbox row behind it. Both moves go through `applyTransition`, so the
 * transition table stays the only authority on what may follow what.
 */
async function queueForDelivery(
  tx: Transaction,
  attempt: OutreachAttempt,
  approvedBy: string,
  now: Date,
  content: OutboundContent,
): Promise<OutreachAttempt> {
  const approved = applyTransition(attempt, "APPROVED", { at: now, approvedBy });
  const queued = applyTransition(approved, "QUEUED", { at: now });

  const row = await updateAttemptState(tx, attempt, queued, content.dedupKey);

  const inserted = await tx.queryRow<{ id: string }>`
    INSERT INTO outbox (id, attempt_id, payload, idempotency_key)
    VALUES (
      ${randomUUID()},
      ${attempt.id},
      -- The double cast is not decoration: the Encore driver binds a JS string
      -- as a jsonb value in its own right, so a plain ::jsonb would store the
      -- JSON text as a jsonb string. Going through ::text makes Postgres parse
      -- it into the object the column is supposed to hold.
      (${JSON.stringify({ to: content.to, subject: content.subject, body: content.body })}::text)::jsonb,
      ${content.dedupKey}
    )
    ON CONFLICT (attempt_id) DO NOTHING
    RETURNING id
  `;

  if (inserted === null) {
    // `uq_outbox_attempt` fired: the attempt is already queued. That is the
    // duplicate case and not a failure — but only if the queued row would
    // send the same thing. A row under a different key would mean this commit
    // is about to approve content that will never go out.
    const existing = await tx.queryRow<{ idempotency_key: string }>`
      SELECT idempotency_key FROM outbox WHERE attempt_id = ${attempt.id}
    `;

    if (existing === null || existing.idempotency_key !== content.dedupKey) {
      throw APIError.internal(
        `Attempt ${attempt.id} already has an outbox row under key ` +
          `${existing?.idempotency_key ?? "(none)"}, but this approval would send ` +
          `${content.dedupKey}. Refusing to approve content that would never be delivered.`,
      );
    }
  }

  return rowToAttempt(row);
}

/**
 * Write a computed next state, guarded by the state it came from.
 *
 * The predicate is the optimistic lock from `docs/idempotency.md`. The row is
 * already locked by the `SELECT ... FOR UPDATE` that started the transaction,
 * so this cannot fail in practice — it is kept because the lock is an
 * implementation detail of this file and the predicate is the part that would
 * still be correct without it.
 */
async function updateAttemptState(
  tx: Transaction,
  from: OutreachAttempt,
  next: OutreachAttempt,
  dedupKey: string,
): Promise<AttemptRow> {
  try {
    const row = await tx.queryRow<AttemptRow>`
      UPDATE outreach_attempts
         SET state         = ${next.state},
             dedup_key     = ${dedupKey},
             approved_by   = ${next.approvedBy},
             approved_at   = ${next.approvedAt}::timestamptz,
             attempt_count = ${next.attemptCount},
             updated_at    = ${next.updatedAt}::timestamptz
       WHERE id = ${from.id} AND state = ${from.state}
       RETURNING *
    `;

    return assertUpdated(row, from);
  } catch (error) {
    if (isUniqueViolation(error, "uq_attempt_dedup")) {
      // Editing a draft back to text that already exists as another attempt.
      // Reported rather than swallowed: the two attempts would be the same
      // message, and only one of them can ever be delivered.
      throw APIError.alreadyExists(
        `The edited content already exists as another attempt for merchant ` +
          `${from.merchantId} in campaign ${from.campaignId} (dedup key ${dedupKey}). ` +
          `Approve that attempt instead of duplicating it.`,
      );
    }
    throw error;
  }
}

// ─── Reading the row ───────────────────────────────────────────

/**
 * Load the attempt and hold it for the rest of the transaction.
 *
 * `FOR UPDATE` is what makes reading before writing safe here: a second
 * concurrent call blocks on this line until the first commits, and then reads
 * the state the first one left behind. Without it, both callers would read
 * `PENDING_APPROVAL` and race — which is the failure the whole document is
 * about.
 */
async function loadAttemptForUpdate(tx: Transaction, id: string): Promise<OutreachAttempt> {
  const row = await tx.queryRow<AttemptRow>`
    SELECT * FROM outreach_attempts WHERE id = ${id} FOR UPDATE
  `;

  if (row === null) {
    throw APIError.notFound(`No outreach attempt with id "${id}".`);
  }

  return rowToAttempt(row);
}

async function loadDraftAndMerchant(
  tx: Transaction,
  attempt: OutreachAttempt,
): Promise<{ draft: ReturnType<typeof rowToDraft>; merchant: ReturnType<typeof rowToMerchant> }> {
  const draftRow = await tx.queryRow<DraftRow>`
    SELECT id, merchant_id, campaign_id, locale, subject, body, evidence, model, created_at
    FROM drafts WHERE id = ${attempt.draftId}
  `;

  if (draftRow === null) {
    throw APIError.internal(
      `Attempt ${attempt.id} points at draft ${attempt.draftId}, which does not exist.`,
    );
  }

  const merchantRow = await tx.queryRow<MerchantRow>`
    SELECT id, name, category, city, country_code, locale, website_url, contact_email,
           rating::float8 AS rating, review_count, years_in_business, has_active_offer,
           last_offer_ended_at, seats_or_capacity
    FROM merchants WHERE id = ${attempt.merchantId}
  `;

  if (merchantRow === null) {
    throw APIError.internal(
      `Attempt ${attempt.id} points at merchant ${attempt.merchantId}, which does not exist.`,
    );
  }

  return { draft: rowToDraft(draftRow), merchant: rowToMerchant(merchantRow) };
}

/** The most recent send to this merchant from any other campaign, for G11. */
async function loadPreviousApproach(
  tx: Transaction,
  attempt: OutreachAttempt,
): Promise<{ campaignId: string; sentAt: string } | null> {
  const row = await tx.queryRow<{ campaign_id: string; sent_at: Date | string }>`
    SELECT campaign_id, sent_at
      FROM outreach_attempts
     WHERE merchant_id = ${attempt.merchantId}
       AND campaign_id <> ${attempt.campaignId}
       AND state = 'SENT'
     ORDER BY sent_at DESC
     LIMIT 1
  `;

  if (row === null) return null;

  const sentAt = row.sent_at instanceof Date ? row.sent_at.toISOString() : row.sent_at;
  return { campaignId: row.campaign_id, sentAt };
}

/**
 * Store the gate report for the edited draft.
 *
 * One report per draft, overwritten: the report is the verdict on the text
 * that is in the row now, and keeping the verdict on text that no longer
 * exists would mislead every screen that reads it.
 */
async function saveGateReport(
  tx: Transaction,
  report: ReturnType<typeof runGates>,
): Promise<void> {
  const contract = toContractReport(report);

  await tx.exec`
    INSERT INTO gate_reports (draft_id, outcomes, blocked, evaluated_at, duration_ms)
    VALUES (
      ${contract.draftId}, (${JSON.stringify(contract.outcomes)}::text)::jsonb, ${contract.blocked},
      ${contract.evaluatedAt}::timestamptz, ${contract.durationMs}
    )
    ON CONFLICT (draft_id) DO UPDATE SET
      outcomes     = EXCLUDED.outcomes,
      blocked      = EXCLUDED.blocked,
      evaluated_at = EXCLUDED.evaluated_at,
      duration_ms  = EXCLUDED.duration_ms
  `;
}

// ─── Duplicates, conflicts and other plumbing ──────────────────

/**
 * The already-decided answer for this attempt, or null if there is work to do.
 *
 * Zero changed rows has two possible meanings and they must not be conflated:
 * the decision was already recorded (a duplicate click — success, nothing
 * changes), or the attempt is in a state this call has no business touching
 * (a conflict — an error). Reporting both as success would hide a real bug
 * behind the harmless case.
 */
function duplicateOf(
  attempt: OutreachAttempt,
  decidedStates: readonly OutreachState[],
): ApprovalResponse | null {
  if (!decidedStates.includes(attempt.state)) return null;
  return { attempt, alreadyApplied: true, blockedGates: [] };
}

/** The conflict half of the same question. */
function requireState(attempt: OutreachAttempt, expected: OutreachState, verb: string): void {
  if (attempt.state === expected) return;

  throw APIError.failedPrecondition(
    `Attempt ${attempt.id} is ${attempt.state} and cannot be ${verb}; ` +
      `only a ${expected} attempt can. From ${attempt.state} it can go to: ` +
      `${allowedTargets(attempt.state).join(", ") || "nowhere — the state is terminal"}.`,
  );
}

/**
 * A guarded update that changed nothing.
 *
 * Unreachable while the row lock is held, which is exactly why it throws
 * rather than returning: if it ever fires, the assumption this file is built
 * on has stopped being true and the run must stop rather than continue on a
 * row it does not understand.
 */
function assertUpdated(row: AttemptRow | null, attempt: OutreachAttempt): AttemptRow {
  if (row === null) {
    throw APIError.aborted(
      `Attempt ${attempt.id} changed state underneath a locked transaction ` +
        `(expected ${attempt.state}). Nothing was written; retry the request.`,
    );
  }
  return row;
}

/** Run `work` in one transaction: commit on success, roll back on anything else. */
async function withTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.begin();
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/**
 * Every decision is attributable. An empty approver would satisfy the
 * database constraint (`approved_by IS NOT NULL`) while telling nobody
 * anything, so it is rejected here where a useful message can be produced.
 */
function requireActor(value: string | undefined, field: string): string {
  const actor = (value ?? "").trim();

  if (actor.length === 0) {
    throw APIError.invalidArgument(
      `${field} is required: every approval decision is recorded against a person.`,
    );
  }
  if (actor.length > MAX_ACTOR_LENGTH) {
    throw APIError.invalidArgument(
      `${field} is ${actor.length} characters; the maximum is ${MAX_ACTOR_LENGTH}.`,
    );
  }

  return actor;
}
