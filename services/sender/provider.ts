/**
 * The mock delivery provider.
 *
 * There is no real email in this repository, so this stands in for the
 * downstream service — and it is deliberately not a stub that always succeeds.
 * It models the three provider behaviours that make idempotency hard:
 *
 * 1. **It honours `Idempotency-Key`.** A repeated request under a key it has
 *    already accepted returns the *original* `messageId` and delivers nothing
 *    a second time. This is the fourth and last layer of defence in
 *    `docs/idempotency.md`: even if the outbox, the claim and the unique index
 *    all failed at once, the provider still refuses to send twice.
 * 2. **It fails sometimes.** A configurable share of calls fails with a
 *    retryable error, which is what the backoff in `retry.ts` exists for.
 * 3. **It can time out on a call it actually accepted.** The nastiest case:
 *    the caller sees a failure, the provider has the message. Only the
 *    idempotency key makes the retry safe, and this mode is how that gets
 *    proven rather than asserted.
 *
 * Randomness is seeded, not `Math.random`. A flaky provider is the point; a
 * flaky *test suite* is not, so the same seed always produces the same run.
 * For tests that need one exact behaviour, `scheduleOutcomes` skips the dice
 * entirely.
 */

import { createHash } from "node:crypto";

import { ProviderError } from "../../shared/errors.js";

// ─── The wire format ───────────────────────────────────────────

/** One outbound message. `payload` of an `outbox` row, plus its key. */
export interface DeliveryRequest {
  /**
   * Sent as the `Idempotency-Key` header. This is the attempt's `dedupKey`:
   * sha256(merchantId|campaignId|sha256(subject+body)).
   */
  idempotencyKey: string;
  /** Synthetic address; everything in this dataset ends in @example.invalid. */
  to: string;
  subject: string;
  body: string;
}

export interface DeliveryReceipt {
  /** The provider's id for the message. Written to `provider_message_id`. */
  messageId: string;
  /** ISO-8601 instant the provider accepted the message. */
  acceptedAt: string;
  /**
   * True when this key was already known and no second message was sent.
   *
   * The caller treats both values the same way — it writes `SENT` with this
   * `messageId` either way. The flag exists so a retry is *visible* in the
   * logs and in tests, not so anybody branches on it.
   */
  deduplicated: boolean;
}

/** What the provider does with a call, once the dice have been rolled. */
export type DeliveryOutcome =
  /** Accept the message and return a receipt. */
  | "accept"
  /** Reject it. Nothing is stored, so a retry can still succeed. */
  | "fail"
  /** Store it, then report a timeout. The caller believes it failed. */
  | "timeout_but_accepted";

// ─── Configuration ─────────────────────────────────────────────

export interface MockProviderConfig {
  /** Share of fresh calls that fail outright, 0–1. */
  failureRate: number;
  /** Share of fresh calls that are accepted but reported as a timeout, 0–1. */
  timeoutButAcceptedRate: number;
  /** Seed for the deterministic PRNG. Same seed, same sequence of outcomes. */
  seed: number;
  /** Injectable clock, so `acceptedAt` is assertable. */
  now: () => Date;
}

export const DEFAULT_PROVIDER_CONFIG: MockProviderConfig = {
  failureRate: 0,
  timeoutButAcceptedRate: 0,
  seed: 1,
  now: () => new Date(),
};

/** A message the provider considers delivered. One per accepted key. */
export interface DeliveredMessage {
  messageId: string;
  idempotencyKey: string;
  to: string;
  subject: string;
  acceptedAt: string;
}

export interface ProviderStats {
  /** Every call to `send`, including the ones that failed. */
  requests: number;
  /** Distinct messages actually delivered. The number that must not drift. */
  delivered: number;
  /** Calls answered from the idempotency store instead of being delivered. */
  deduplicated: number;
  /** Calls that raised — both plain failures and accepted-but-timed-out ones. */
  errors: number;
}

/** What the provider remembers about a key it has accepted. */
interface StoredDelivery extends DeliveredMessage {
  /** Hash of the request body, to detect a key reused for other content. */
  fingerprint: string;
}

// ─── The provider ──────────────────────────────────────────────

export class MockDeliveryProvider {
  private readonly config: MockProviderConfig;
  private readonly byKey = new Map<string, StoredDelivery>();
  private readonly forcedOutcomes: DeliveryOutcome[] = [];
  private nextRandom: () => number;
  private messageCounter = 0;
  private stats: ProviderStats = { requests: 0, delivered: 0, deduplicated: 0, errors: 0 };

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...DEFAULT_PROVIDER_CONFIG, ...config };

    const { failureRate, timeoutButAcceptedRate } = this.config;
    assertRate("failureRate", failureRate);
    assertRate("timeoutButAcceptedRate", timeoutButAcceptedRate);
    if (failureRate + timeoutButAcceptedRate > 1) {
      throw new ProviderError(
        `Mock provider misconfigured: failureRate (${failureRate}) plus ` +
          `timeoutButAcceptedRate (${timeoutButAcceptedRate}) exceeds 1. ` +
          `They are shares of the same call, not independent rolls.`,
        false,
      );
    }

    this.nextRandom = mulberry32(this.config.seed);
  }

  /**
   * Deliver a message, or don't.
   *
   * The order of the checks is the whole design, so it is worth reading in
   * order: a known key is answered *before* any failure is simulated. If the
   * dice were rolled first, a retry of an already-delivered message could
   * fail, and the caller would retry again — which is exactly the loop the
   * idempotency key is there to end.
   */
  async send(request: DeliveryRequest): Promise<DeliveryReceipt> {
    this.stats.requests += 1;

    const key = request.idempotencyKey?.trim();
    if (!key) {
      // Not retryable: retrying a request with no key cannot start working.
      this.stats.errors += 1;
      throw new ProviderError(
        `Delivery request for "${request.to}" carries no Idempotency-Key. ` +
          `Every outbound call must carry the attempt's dedupKey; refusing to send.`,
        false,
      );
    }

    const fingerprint = fingerprintOf(request);
    const existing = this.byKey.get(key);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        // A real provider (Stripe, for one) treats this as a client bug, and
        // so does this one: the same key with different content means the
        // caller computed the key wrong. Answering with the old message would
        // silently drop the new one.
        this.stats.errors += 1;
        throw new ProviderError(
          `Idempotency-Key ${key} was already used for a different message ` +
            `(previously "${existing.subject}" to ${existing.to}, now "${request.subject}" ` +
            `to ${request.to}). The key must be derived from the content it sends.`,
          false,
        );
      }

      this.stats.deduplicated += 1;
      return { messageId: existing.messageId, acceptedAt: existing.acceptedAt, deduplicated: true };
    }

    switch (this.drawOutcome()) {
      case "fail": {
        this.stats.errors += 1;
        throw new ProviderError(
          `Provider rejected message for ${request.to} (simulated failure). ` +
            `Nothing was delivered; retrying with the same Idempotency-Key is safe.`,
          true,
        );
      }

      case "timeout_but_accepted": {
        // Store first, then throw. That ordering is the failure being modelled:
        // the provider has the message, the caller does not know it.
        const stored = this.record(request, key, fingerprint);
        this.stats.errors += 1;
        throw new ProviderError(
          `Provider timed out for ${request.to} after ${TIMEOUT_MS} ms. ` +
            `The message may or may not have been accepted; retry with the same ` +
            `Idempotency-Key (${key}) to find out without sending twice. ` +
            `[the message was, in fact, accepted as ${stored.messageId}]`,
          true,
        );
      }

      case "accept": {
        const stored = this.record(request, key, fingerprint);
        return { messageId: stored.messageId, acceptedAt: stored.acceptedAt, deduplicated: false };
      }
    }
  }

  /**
   * Force the next call(s) to behave a given way, ahead of the PRNG.
   *
   * Rates are how the demo run gets realistic; this is how a test gets one
   * exact scenario without tuning a probability until it happens to fire.
   */
  scheduleOutcomes(...outcomes: DeliveryOutcome[]): this {
    this.forcedOutcomes.push(...outcomes);
    return this;
  }

  /** Every distinct message delivered, in acceptance order. */
  messages(): readonly DeliveredMessage[] {
    return [...this.byKey.values()].map(({ fingerprint: _fingerprint, ...message }) => message);
  }

  /** How many messages reached the recipient. The invariant tests assert on this. */
  deliveredCount(): number {
    return this.byKey.size;
  }

  currentStats(): Readonly<ProviderStats> {
    return { ...this.stats };
  }

  /** Forget everything, including the PRNG position. For test setup. */
  reset(): void {
    this.byKey.clear();
    this.forcedOutcomes.length = 0;
    this.messageCounter = 0;
    this.stats = { requests: 0, delivered: 0, deduplicated: 0, errors: 0 };
    this.nextRandom = mulberry32(this.config.seed);
  }

  private drawOutcome(): DeliveryOutcome {
    const forced = this.forcedOutcomes.shift();
    if (forced !== undefined) return forced;

    // One roll split into bands, rather than two independent rolls, so the
    // configured shares add up to exactly the share of calls that misbehave.
    const roll = this.nextRandom();
    if (roll < this.config.timeoutButAcceptedRate) return "timeout_but_accepted";
    if (roll < this.config.timeoutButAcceptedRate + this.config.failureRate) return "fail";
    return "accept";
  }

  private record(request: DeliveryRequest, key: string, fingerprint: string): StoredDelivery {
    this.messageCounter += 1;

    // A counter, not a hash of the key: an id derived from the key would come
    // out identical on a genuine second delivery, and the tests would pass
    // while the provider double-sent. A fresh id per acceptance means "same
    // messageId" can only mean "same acceptance".
    const stored: StoredDelivery = {
      messageId: `msg_${String(this.messageCounter).padStart(6, "0")}`,
      idempotencyKey: key,
      to: request.to,
      subject: request.subject,
      acceptedAt: this.config.now().toISOString(),
      fingerprint,
    };

    this.byKey.set(key, stored);
    this.stats.delivered += 1;
    return stored;
  }
}

// ─── Internals ─────────────────────────────────────────────────

/** Only used in the timeout message, so the number is not a magic constant. */
const TIMEOUT_MS = 10_000;

function assertRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProviderError(
      `Mock provider misconfigured: ${name} must be between 0 and 1, got ${value}.`,
      false,
    );
  }
}

/** Content hash of a request, used to catch a key reused for other content. */
function fingerprintOf(request: DeliveryRequest): string {
  return createHash("sha256")
    .update([request.to, request.subject, request.body].join(" "))
    .digest("hex");
}

/**
 * Mulberry32: a small, fast, seeded PRNG.
 *
 * Not cryptographic, and it does not need to be — its only job is to make a
 * failure rate reproducible across runs and machines.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
