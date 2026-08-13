/**
 * Retry with exponential backoff.
 *
 * Retrying a delivery is only safe because every attempt carries the same
 * `Idempotency-Key`; this module is the other half of that bargain and does
 * nothing clever. Three decisions worth stating:
 *
 * **Only retryable errors are retried.** `ProviderError` says whether the
 * failure can plausibly go away. Anything else — a bug in our payload, an
 * unknown exception — is raised immediately. Retrying a deterministic failure
 * five times just delays the report by half a minute and triples the noise.
 *
 * **The last error is rethrown, not wrapped in a generic one.** After the
 * final attempt the caller gets the real reason the send failed, which is the
 * text that ends up in `outbox.last_error` and in front of a human.
 *
 * **Sleeping and jitter are injectable.** The tests assert on the delay
 * sequence without waiting for it, and the demo run does not synchronise its
 * retries into a thundering herd.
 */

import { ProviderError } from "../../shared/errors.js";

export interface RetryPolicy {
  /** Total tries, including the first. Five, per the workstream brief. */
  maxAttempts: number;
  /** Delay after the first failure, before any exponential growth. */
  baseDelayMs: number;
  /** Multiplier per attempt. 2 = 0.5s, 1s, 2s, 4s. */
  factor: number;
  /** Ceiling on a single delay, before jitter. */
  maxDelayMs: number;
  /**
   * `full` picks uniformly from [0, delay); `none` uses the delay as is.
   * Full jitter is the AWS recommendation and the reason a hundred workers
   * that fail together do not retry together.
   */
  jitter: "full" | "none";
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
  jitter: "full",
};

/** Handed to `onRetry` before each wait, so a caller can log the retry. */
export interface RetryAttemptInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** How long the next attempt will wait. */
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  /** Defaults to "retry `ProviderError` when it says it is retryable". */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Injectable so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable so a jittered delay is assertable. */
  random?: () => number;
}

/**
 * Whether a failure is worth another try.
 *
 * An unknown error is *not* retried. That is the conservative choice for a
 * pipeline whose whole claim is that it never sends twice: an exception we do
 * not recognise might have come from anywhere, including after the message
 * left, and the honest answer is to stop and surface it.
 */
export function isRetryableError(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

/**
 * The delay before attempt `attempt + 1`, given that `attempt` just failed.
 *
 * Exported on its own because the backoff schedule is a thing worth asserting
 * on directly, separately from the loop that uses it.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, policy.maxDelayMs);
  return policy.jitter === "full" ? Math.round(capped * random()) : Math.round(capped);
}

/**
 * Run `operation` until it succeeds, it fails unretryably, or the attempts run
 * out. The attempt number is passed in so the caller can log it.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${policy.maxAttempts}.`);
  }

  const shouldRetry = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const isLastAttempt = attempt >= policy.maxAttempts;
      if (isLastAttempt || !shouldRetry(error)) throw error;

      const delayMs = backoffDelayMs(attempt, policy, random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
