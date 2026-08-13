/**
 * The outreach state machine.
 *
 * The legal transitions are a data structure, not a series of `if`s spread
 * across the service. There is one table, every caller reads it, and a state
 * added to the contract that nobody wired up is a compile error rather than a
 * path that silently never runs.
 *
 * The graph is the one in SPEC.md:
 *
 * ```
 * INGESTED -> TRIAGED -> DRAFTED -> GATED
 *                                    |-- BLOCKED           (a blocking gate failed)
 *                                    `-- PENDING_APPROVAL
 *                                           |-- REJECTED
 *                                           |-- BLOCKED    (gates re-run on an edit)
 *                                           `-- APPROVED -> QUEUED -> SENT
 *                                                                  `-> FAILED -> QUEUED
 * ```
 *
 * One edge is not in that diagram: `PENDING_APPROVAL -> BLOCKED`. It is here
 * because `editAndApprove` re-runs the gates over the edited text, and a human
 * editing a draft can introduce exactly what the gates exist to catch. The
 * diagram in SPEC.md predates the edit path; without this edge, an edit that
 * fails a blocking gate would have nowhere legal to go, and the only ways out
 * would be to approve it anyway or to drop the human's edit on the floor.
 *
 * `SENT` is terminal and irreversible. That is not a convention here — it is
 * the reason `uq_attempt_sent` can be a unique index at all.
 */

import type { OutreachAttempt, OutreachState } from "../../shared/contracts.js";
import { AppError, InvalidStateTransitionError } from "../../shared/errors.js";

// ─── The table ─────────────────────────────────────────────────

/**
 * Every state, and everything it may become.
 *
 * A total `Record` over `OutreachState`: a new state in the contract does not
 * compile until it is given a row here, and an existing state cannot be left
 * out by accident. An empty array means terminal.
 *
 * Two entries deserve their reasoning written down:
 *
 * - **`BLOCKED` is terminal.** A draft that failed a blocking gate does not
 *   get walked back into the approval queue, because the content that failed
 *   is still the content that would be sent. Fixing it means new content,
 *   which means a different `sha256(subject + body)`, which means a different
 *   `dedupKey` — a *new* attempt row, not this one changing its mind. That
 *   falls out of the dedup key design rather than needing a rule of its own.
 *   (`editAndApprove` therefore refuses a blocked attempt; fixing one means
 *   drafting a new attempt row, not reviving this one.)
 *
 * - **`FAILED -> QUEUED` is allowed, and it is the only way back.** A delivery
 *   that failed can be retried; it cannot jump to `SENT` without passing
 *   through the outbox again, so a retry always carries the same idempotency
 *   key through the same claim.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<OutreachState, readonly OutreachState[]>> = {
  INGESTED: ["TRIAGED"],
  TRIAGED: ["DRAFTED"],
  DRAFTED: ["GATED"],
  GATED: ["BLOCKED", "PENDING_APPROVAL"],
  BLOCKED: [],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "BLOCKED"],
  REJECTED: [],
  APPROVED: ["QUEUED"],
  QUEUED: ["SENT", "FAILED"],
  FAILED: ["QUEUED"],
  SENT: [],
};

/** States nothing leaves. Derived from the table, so it cannot drift from it. */
export const TERMINAL_STATES: readonly OutreachState[] = (
  Object.keys(ALLOWED_TRANSITIONS) as OutreachState[]
).filter((state) => ALLOWED_TRANSITIONS[state].length === 0);

/** The single question every caller asks. */
export function canTransition(from: OutreachState, to: OutreachState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: OutreachState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

/** For error messages: what this state could legally have become. */
export function allowedTargets(from: OutreachState): readonly OutreachState[] {
  return ALLOWED_TRANSITIONS[from];
}

// ─── Applying one ──────────────────────────────────────────────

/**
 * Everything a transition needs besides the attempt and the target state.
 *
 * The instant is an argument rather than read from the clock, for the same
 * reason the gates take one: a pure function of its inputs is the only kind
 * whose behaviour can be pinned down by a test.
 */
export interface TransitionContext {
  /** The instant to stamp on whatever timestamp this transition sets. */
  at: Date;
  /** Required for `PENDING_APPROVAL -> APPROVED`. */
  approvedBy?: string;
  /** Required for `QUEUED -> SENT`; the provider's receipt. */
  providerMessageId?: string;
  /** Required for `QUEUED -> FAILED` and for `PENDING_APPROVAL -> REJECTED`. */
  failureReason?: string;
}

/**
 * A transition is legal but the caller did not supply what it needs.
 *
 * Separate from `InvalidStateTransitionError`, because the two say different
 * things: that one means the move itself is not allowed, this one means the
 * move is allowed and the row that would result could not be written. Both of
 * the fields it guards are also database constraints; failing here produces a
 * message that names the field, which a constraint violation does not.
 */
export class MissingTransitionFieldError extends AppError {
  readonly code = "MISSING_TRANSITION_FIELD";

  constructor(
    readonly attemptId: string,
    readonly to: OutreachState,
    readonly field: string,
    detail: string,
  ) {
    super(`Attempt ${attemptId} cannot move to ${to}: ${field} is required. ${detail}`);
  }
}

/**
 * Move an attempt to a new state, or fail loudly.
 *
 * Pure: it returns the next `OutreachAttempt` and writes nothing.
 * Persistence is the caller's transaction, so that the state change and the
 * outbox insert can land in the same commit.
 *
 * Worth stating for the interview: this function is *not* where double
 * sending is prevented. It is application code, and the next caller can
 * bypass it. It exists to make the illegal move impossible to write by
 * accident; `uq_attempt_sent` is what makes it impossible to commit.
 */
export function applyTransition(
  attempt: OutreachAttempt,
  to: OutreachState,
  context: TransitionContext,
): OutreachAttempt {
  // Never return the attempt unchanged instead of throwing: a silently
  // ignored transition is a send that quietly did not happen, which is the
  // exact failure mode this project is built to demonstrate against.
  if (!canTransition(attempt.state, to)) {
    throw new InvalidStateTransitionError(attempt.id, attempt.state, to);
  }

  const at = context.at.toISOString();

  // A new object, never a mutation: callers hold the previous row for logging
  // and for the response to a duplicate request. The spread is also what
  // carries `approvedBy` and `approvedAt` forward — nothing below clears
  // them, so a `FAILED -> QUEUED` retry keeps the approver who authorised the
  // message being retried.
  const next: OutreachAttempt = { ...attempt, state: to, updatedAt: at };

  switch (to) {
    case "APPROVED": {
      next.approvedBy = requireField(context.approvedBy, attempt, to, "approvedBy",
        "Every approval is recorded against a person; attempts_approved_requires_approver enforces it.");
      next.approvedAt = at;
      break;
    }

    case "QUEUED": {
      // Only here, so the count measures delivery attempts rather than state
      // changes. The claim increments the outbox row's own counter separately.
      next.attemptCount = attempt.attemptCount + 1;
      break;
    }

    case "SENT": {
      next.providerMessageId = requireField(context.providerMessageId, attempt, to, "providerMessageId",
        "A SENT row with no receipt is a send nobody can verify afterwards; " +
          "attempts_sent_requires_receipt enforces it.");
      next.sentAt = at;
      break;
    }

    case "FAILED": {
      next.failureReason = requireField(context.failureReason, attempt, to, "failureReason",
        "The reason goes in front of a human deciding whether to retry.");
      break;
    }

    case "REJECTED": {
      // Rejections are the only labelled data this pipeline produces about
      // what the model gets wrong, so the reason is required by the state
      // machine rather than by whichever handler happens to be calling.
      next.failureReason = requireField(context.failureReason, attempt, to, "failureReason",
        "A rejection with no stated reason teaches the eval suite nothing.");
      break;
    }

    default:
      break;
  }

  // Mirrors `attempts_approved_requires_approver`. Reachable when an attempt
  // is queued or sent without ever having been approved — which the
  // transition table already forbids, but which a hand-written row in the
  // database would not. Better a named field than a constraint violation.
  if ((to === "APPROVED" || to === "QUEUED" || to === "SENT") &&
      (next.approvedBy === null || next.approvedAt === null)) {
    throw new MissingTransitionFieldError(
      attempt.id, to, "approvedBy",
      `The attempt carries no approver, so ${to} would be a message nobody authorised.`,
    );
  }

  return next;
}

/** A required transition field, or a failure that names it. */
function requireField(
  value: string | undefined,
  attempt: OutreachAttempt,
  to: OutreachState,
  field: string,
  detail: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new MissingTransitionFieldError(attempt.id, to, field, detail);
  }
  return trimmed;
}
