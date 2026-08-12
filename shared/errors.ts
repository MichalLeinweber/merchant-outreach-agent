/**
 * Domain errors.
 *
 * Every failure that the pipeline can produce on purpose has a type here.
 * The rule the whole project follows: fail loudly with an actionable
 * message, never degrade silently. A silent fallback in an agent pipeline
 * produces plausible output that nobody can trace back to its cause.
 */

import type { GateId, LlmMode, ModelId, OutreachState } from "./contracts.js";

/** Base class so callers can distinguish our failures from unexpected ones. */
export abstract class AppError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown in `fixture` mode when the recorded response for a prompt is
 * missing. The message must tell the reader exactly how to record it —
 * this error is the reason a changed prompt cannot pass unnoticed.
 */
export class MissingFixtureError extends AppError {
  readonly code = "MISSING_FIXTURE";

  constructor(
    readonly fixtureKey: string,
    readonly model: ModelId,
    readonly fixturePath: string,
  ) {
    super(
      `Missing LLM fixture "${fixtureKey}" for model ${model}.\n` +
        `Expected file: ${fixturePath}\n` +
        `The prompt or its parameters changed, so the recorded response no longer matches.\n` +
        `Record it with:  ANTHROPIC_API_KEY=... LLM_MODE=record npm run demo\n` +
        `Refusing to fall back to a live call or a stub response.`,
    );
  }
}

/** A stored fixture exists but does not have the expected shape. */
export class CorruptFixtureError extends AppError {
  readonly code = "CORRUPT_FIXTURE";

  constructor(
    readonly fixturePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Fixture at ${fixturePath} is not usable: ${detail}`, options);
  }
}

/** `live` or `record` mode was requested without an API key. */
export class MissingApiKeyError extends AppError {
  readonly code = "MISSING_API_KEY";

  constructor(readonly mode: LlmMode) {
    super(
      `LLM_MODE=${mode} needs ANTHROPIC_API_KEY, which is not set.\n` +
        `Put it in .env.local (never in the repository), or run in fixture mode:  LLM_MODE=fixture`,
    );
  }
}

/** The model returned something that does not match the expected schema. */
export class LlmResponseError extends AppError {
  readonly code = "LLM_RESPONSE";

  constructor(
    readonly model: ModelId,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Model ${model} returned an unusable response: ${detail}`, options);
  }
}

/**
 * The campaign's configured cost ceiling was reached. The run stops here;
 * unfinished cases keep their current state rather than being half-processed.
 */
export class CostCapExceededError extends AppError {
  readonly code = "COST_CAP_EXCEEDED";

  constructor(
    readonly campaignId: string,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Campaign ${campaignId} reached its cost cap: ` +
        `spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}. ` +
        `Stopping; unprocessed merchants keep their current state.`,
    );
  }
}

/**
 * An illegal state transition was attempted. The state machine is the only
 * way to move an attempt forward, so this is always a programming error.
 */
export class InvalidStateTransitionError extends AppError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(
    readonly attemptId: string,
    readonly from: OutreachState,
    readonly to: OutreachState,
  ) {
    super(
      `Attempt ${attemptId} cannot move from ${from} to ${to}. ` +
        `SENT is terminal and no transition leaves it.`,
    );
  }
}

/** A blocking gate failed, so the draft must not reach the approval queue. */
export class DraftBlockedError extends AppError {
  readonly code = "DRAFT_BLOCKED";

  constructor(
    readonly draftId: string,
    readonly failedGates: GateId[],
  ) {
    super(
      `Draft ${draftId} failed blocking gate(s): ${failedGates.join(", ")}. ` +
        `It goes to BLOCKED, not to PENDING_APPROVAL.`,
    );
  }
}

/** The mock delivery provider rejected or dropped the message. */
export class ProviderError extends AppError {
  readonly code = "PROVIDER";

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
