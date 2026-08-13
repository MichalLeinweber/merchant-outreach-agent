import { describe, expect, it } from "vitest";

import { ProviderError } from "../../shared/errors.js";
import { MockDeliveryProvider, type DeliveryRequest } from "./provider.js";
import { withRetry } from "./retry.js";

const FIXED_NOW = new Date("2026-08-12T09:00:00.000Z");

function request(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    idempotencyKey: "dedup_a1b2c3",
    to: "hello@bistro-morava.example.invalid",
    subject: "Weekday covers for Bistro Morava",
    body: "Your 4.8 rating with 62 reviews suggests room on quiet weekdays.",
    ...overrides,
  };
}

function provider(config: Partial<ConstructorParameters<typeof MockDeliveryProvider>[0]> = {}) {
  return new MockDeliveryProvider({ now: () => FIXED_NOW, ...config });
}

describe("mock provider: delivery", () => {
  it("accepts a message and returns a receipt", async () => {
    const p = provider();

    const receipt = await p.send(request());

    expect(receipt.messageId).toMatch(/^msg_\d{6}$/);
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.acceptedAt).toBe(FIXED_NOW.toISOString());
    expect(p.deliveredCount()).toBe(1);
  });

  it("delivers separate messages under different keys", async () => {
    const p = provider();

    const first = await p.send(request({ idempotencyKey: "dedup_one" }));
    const second = await p.send(request({ idempotencyKey: "dedup_two", subject: "Another" }));

    expect(first.messageId).not.toBe(second.messageId);
    expect(p.deliveredCount()).toBe(2);
  });

  it("refuses a request with no Idempotency-Key, and does not retry it", async () => {
    const p = provider();

    // Not retryable: no amount of trying makes an absent key appear.
    await expect(p.send(request({ idempotencyKey: "  " }))).rejects.toMatchObject({
      code: "PROVIDER",
      retryable: false,
    });
    expect(p.deliveredCount()).toBe(0);
  });
});

describe("mock provider: idempotency key", () => {
  it("returns the original messageId for a repeated key and sends nothing twice", async () => {
    const p = provider();

    const first = await p.send(request());
    const second = await p.send(request());

    // The message id is a counter, so an identical id can only mean the
    // provider answered from its store rather than delivering again.
    expect(second.messageId).toBe(first.messageId);
    expect(second.deduplicated).toBe(true);
    expect(p.deliveredCount()).toBe(1);
    expect(p.currentStats()).toMatchObject({ requests: 2, delivered: 1, deduplicated: 1 });
  });

  it("answers a known key before simulating any failure", async () => {
    // The ordering that makes retries terminate: a delivered message stays
    // delivered even when the provider is configured to fail every call.
    const p = provider({ failureRate: 1 });
    p.scheduleOutcomes("accept");

    const first = await p.send(request());
    const second = await p.send(request());

    expect(second.messageId).toBe(first.messageId);
    expect(p.deliveredCount()).toBe(1);
  });

  it("rejects a key reused for different content", async () => {
    const p = provider();
    await p.send(request());

    // Same key, new subject: the caller computed the key wrong. Returning the
    // old receipt would silently swallow the new message.
    await expect(
      p.send(request({ subject: "A different offer entirely" })),
    ).rejects.toMatchObject({ code: "PROVIDER", retryable: false });
    expect(p.deliveredCount()).toBe(1);
  });
});

describe("mock provider: failure modes", () => {
  it("fails without delivering, and a retry with the same key then succeeds", async () => {
    const p = provider();
    p.scheduleOutcomes("fail");

    await expect(p.send(request())).rejects.toMatchObject({ retryable: true });
    expect(p.deliveredCount()).toBe(0);

    const receipt = await p.send(request());
    expect(receipt.deduplicated).toBe(false);
    expect(p.deliveredCount()).toBe(1);
  });

  it("simulates a timeout on a message it actually accepted", async () => {
    const p = provider();
    p.scheduleOutcomes("timeout_but_accepted");

    // The caller sees a failure. The provider has the message. This is the
    // case that makes "check before sending" useless and the key necessary.
    await expect(p.send(request())).rejects.toBeInstanceOf(ProviderError);
    expect(p.deliveredCount()).toBe(1);
  });

  it("returns the original messageId when the timed-out call is retried", async () => {
    const p = provider();
    p.scheduleOutcomes("timeout_but_accepted");

    const delivered = await p.send(request()).catch(() => null);
    expect(delivered).toBeNull();

    const receipt = await p.send(request());

    expect(receipt.deduplicated).toBe(true);
    expect(receipt.messageId).toBe(p.messages()[0]?.messageId);
    // The point of the whole exercise: two requests, one message.
    expect(p.currentStats().requests).toBe(2);
    expect(p.deliveredCount()).toBe(1);
  });

  it("delivers exactly once when a timeout is followed by the retry policy", async () => {
    const p = provider();
    p.scheduleOutcomes("timeout_but_accepted");

    const receipt = await withRetry(() => p.send(request()), {
      policy: { maxAttempts: 5 },
      sleep: async () => {},
    });

    expect(receipt.deduplicated).toBe(true);
    expect(p.deliveredCount()).toBe(1);
  });

  it("gives up on a permanently failing provider after the policy's attempts", async () => {
    const p = provider({ failureRate: 1 });
    let attempts = 0;

    await expect(
      withRetry(
        () => {
          attempts += 1;
          return p.send(request());
        },
        { policy: { maxAttempts: 5 }, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER", retryable: true });

    expect(attempts).toBe(5);
    expect(p.deliveredCount()).toBe(0);
  });
});

describe("mock provider: configuration", () => {
  it("is deterministic for a given seed", async () => {
    const outcomes = async () => {
      const p = provider({ failureRate: 0.5, seed: 42 });
      const results: string[] = [];
      for (let i = 0; i < 20; i += 1) {
        results.push(
          await p
            .send(request({ idempotencyKey: `key_${i}` }))
            .then(() => "ok")
            .catch(() => "error"),
        );
      }
      return results.join(",");
    };

    // A flaky provider is the point; a flaky test suite is not.
    expect(await outcomes()).toBe(await outcomes());
  });

  it("produces roughly the configured failure rate", async () => {
    const p = provider({ failureRate: 0.3, seed: 7 });
    let failures = 0;

    for (let i = 0; i < 200; i += 1) {
      await p.send(request({ idempotencyKey: `key_${i}` })).catch(() => {
        failures += 1;
      });
    }

    // Wide band on purpose: this asserts the knob is wired up, not that a
    // PRNG hits a target to three decimal places.
    expect(failures).toBeGreaterThan(40);
    expect(failures).toBeLessThan(80);
  });

  it("rejects a rate outside 0–1", () => {
    expect(() => provider({ failureRate: 1.5 })).toThrow(ProviderError);
  });

  it("rejects failure shares that add up to more than every call", () => {
    // They are bands of one roll, not independent dice.
    expect(() => provider({ failureRate: 0.7, timeoutButAcceptedRate: 0.5 })).toThrow(
      /exceeds 1/,
    );
  });

  it("forgets everything on reset", async () => {
    const p = provider();
    await p.send(request());

    p.reset();

    expect(p.deliveredCount()).toBe(0);
    expect(p.currentStats()).toEqual({ requests: 0, delivered: 0, deduplicated: 0, errors: 0 });
  });
});
