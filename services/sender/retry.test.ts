import { describe, expect, it } from "vitest";

import { ProviderError } from "../../shared/errors.js";
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  isRetryableError,
  withRetry,
  type RetryAttemptInfo,
} from "./retry.js";

/** No jitter, so the schedule is a fixed sequence rather than a distribution. */
const DETERMINISTIC = { ...DEFAULT_RETRY_POLICY, jitter: "none" } as const;

/** Records what was slept instead of sleeping. */
function recordingSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("backoff schedule", () => {
  it("doubles from the base delay", () => {
    const schedule = [1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, DETERMINISTIC));

    // Four waits between five attempts: 0.5s, 1s, 2s, 4s — 7.5 seconds total,
    // which is the right order of magnitude for a delivery nobody is watching.
    expect(schedule).toEqual([500, 1000, 2000, 4000]);
  });

  it("caps a single delay", () => {
    const policy = { ...DETERMINISTIC, maxDelayMs: 1500 };

    expect([1, 2, 3, 4].map((attempt) => backoffDelayMs(attempt, policy))).toEqual([
      500, 1000, 1500, 1500,
    ]);
  });

  it("spreads the delay across the whole window under full jitter", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: "full" as const };

    // Full jitter picks uniformly from [0, delay). Without it, a hundred
    // workers that failed together retry together.
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(3, policy, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(3, policy, () => 0.999)).toBe(1998);
  });
});

describe("what counts as retryable", () => {
  it("retries a provider error that says it is retryable", () => {
    expect(isRetryableError(new ProviderError("timed out", true))).toBe(true);
  });

  it("does not retry a provider error that says it is not", () => {
    expect(isRetryableError(new ProviderError("bad request", false))).toBe(false);
  });

  it("does not retry an error it does not recognise", () => {
    // The conservative choice for a pipeline whose claim is that it never
    // sends twice: an unknown failure might have happened after the send.
    expect(isRetryableError(new Error("something else"))).toBe(false);
    expect(isRetryableError("not even an error")).toBe(false);
  });
});

describe("withRetry", () => {
  it("does not retry an operation that succeeds", async () => {
    let calls = 0;
    const { slept, sleep } = recordingSleep();

    const result = await withRetry(
      async () => {
        calls += 1;
        return "delivered";
      },
      { sleep },
    );

    expect(result).toBe("delivered");
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("retries until it succeeds", async () => {
    let calls = 0;
    const { slept, sleep } = recordingSleep();

    const result = await withRetry(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new ProviderError("timed out", true);
        return attempt;
      },
      { policy: DETERMINISTIC, sleep },
    );

    expect(result).toBe(3);
    expect(calls).toBe(3);
    expect(slept).toEqual([500, 1000]);
  });

  it("stops after five attempts and rethrows the last failure", async () => {
    let calls = 0;
    const { slept, sleep } = recordingSleep();

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderError(`attempt ${calls} timed out`, true);
        },
        { policy: DETERMINISTIC, sleep },
      ),
      // The real reason, not a generic wrapper: this text ends up in
      // `outbox.last_error` and in front of a human.
    ).rejects.toThrow("attempt 5 timed out");

    expect(calls).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    // Four waits, not five: nothing is slept after the final attempt.
    expect(slept).toEqual([500, 1000, 2000, 4000]);
  });

  it("gives up immediately on a non-retryable failure", async () => {
    let calls = 0;
    const { slept, sleep } = recordingSleep();

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderError("Idempotency-Key missing", false);
        },
        { policy: DETERMINISTIC, sleep },
      ),
    ).rejects.toThrow("Idempotency-Key missing");

    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("reports every retry to the caller", async () => {
    const seen: RetryAttemptInfo[] = [];

    await withRetry(
      async (attempt) => {
        if (attempt < 3) throw new ProviderError("timed out", true);
        return attempt;
      },
      { policy: DETERMINISTIC, sleep: async () => {}, onRetry: (info) => void seen.push(info) },
    );

    expect(seen.map((info) => info.attempt)).toEqual([1, 2]);
    expect(seen.map((info) => info.delayMs)).toEqual([500, 1000]);
    expect(seen[0]?.error).toBeInstanceOf(ProviderError);
  });

  it("honours a custom retryable predicate", async () => {
    let calls = 0;

    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("transient in this caller's world");
        },
        { policy: DETERMINISTIC, sleep: async () => {}, isRetryable: () => true },
      ),
    ).rejects.toThrow("transient");

    expect(calls).toBe(5);
  });

  it("refuses a policy that would never run anything", async () => {
    await expect(withRetry(async () => "x", { policy: { maxAttempts: 0 } })).rejects.toThrow(
      RangeError,
    );
  });
});
