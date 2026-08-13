import { describe, expect, it } from "vitest";

import { MockDeliveryProvider } from "./provider.js";
import { deliverClaimedRow, type ClaimedOutboxRow } from "./delivery.js";

/**
 * Only `deliverClaimedRow` is covered here — it is the part of a tick that
 * touches no database. The claim and the write are SQL, and they are covered
 * against real Postgres in `idempotency.integration.test.ts`.
 */
function claimedRow(overrides: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: "obx_0001",
    attemptId: "att_0001",
    idempotencyKey: "dedup_a1b2c3",
    payload: {
      to: "hello@bistro-morava.example.invalid",
      subject: "Weekday covers for Bistro Morava",
      body: "Your 4.8 rating with 62 reviews suggests room on quiet weekdays.",
    },
    attemptCount: 1,
    claimedAt: "2026-08-12T09:00:00.000Z",
    createdAt: "2026-08-12T08:59:00.000Z",
    ...overrides,
  };
}

const NO_WAITING = { retry: { sleep: async () => {} } };

describe("deliverClaimedRow", () => {
  it("delivers the row and reports the receipt", async () => {
    const provider = new MockDeliveryProvider();

    const result = await deliverClaimedRow(claimedRow(), { provider, ...NO_WAITING });

    expect(result).toMatchObject({ status: "sent", attemptId: "att_0001", deduplicated: false });
    expect(provider.messages()[0]?.idempotencyKey).toBe("dedup_a1b2c3");
  });

  it("carries the row's idempotency key through every retry", async () => {
    const provider = new MockDeliveryProvider();
    provider.scheduleOutcomes("fail", "timeout_but_accepted");

    const result = await deliverClaimedRow(claimedRow(), { provider, ...NO_WAITING });

    // Three requests, one message: the retries are safe precisely because the
    // key does not change between them.
    expect(result).toMatchObject({ status: "sent", deduplicated: true });
    expect(provider.currentStats().requests).toBe(3);
    expect(provider.deliveredCount()).toBe(1);
  });

  it("returns a failure instead of throwing, so the caller can still record it", async () => {
    const provider = new MockDeliveryProvider({ failureRate: 1 });

    const result = await deliverClaimedRow(claimedRow(), { provider, ...NO_WAITING });

    // The row is claimed. An exception here would skip the write that
    // releases it and sets `last_error`.
    expect(result.status).toBe("failed");
    expect(provider.deliveredCount()).toBe(0);
  });
});
