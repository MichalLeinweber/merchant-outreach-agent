import { describe, expect, it } from "vitest";

import { rowToAttempt, rowToDraft, rowToMerchant, toEvidence, type AttemptRow } from "./rows.js";

function attemptRow(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "att_0001",
    merchant_id: "mch_0001",
    campaign_id: "cmp_0001",
    draft_id: "drf_0001",
    state: "PENDING_APPROVAL",
    dedup_key: "dedup_a1b2c3",
    approved_by: null,
    approved_at: null,
    sent_at: null,
    provider_message_id: null,
    failure_reason: null,
    attempt_count: 0,
    created_at: new Date("2026-08-12T08:00:00.000Z"),
    updated_at: new Date("2026-08-12T08:00:00.000Z"),
    ...overrides,
  };
}

describe("rowToAttempt", () => {
  it("turns timestamps into the ISO strings the contract asks for", () => {
    const attempt = rowToAttempt(
      attemptRow({
        state: "SENT",
        approved_by: "michal",
        approved_at: new Date("2026-08-12T08:30:00.000Z"),
        sent_at: new Date("2026-08-12T08:31:00.000Z"),
        provider_message_id: "msg_000001",
      }),
    );

    expect(attempt.approvedAt).toBe("2026-08-12T08:30:00.000Z");
    expect(attempt.sentAt).toBe("2026-08-12T08:31:00.000Z");
    expect(attempt.providerMessageId).toBe("msg_000001");
  });

  it("keeps nulls as nulls", () => {
    const attempt = rowToAttempt(attemptRow());

    expect(attempt.approvedAt).toBeNull();
    expect(attempt.sentAt).toBeNull();
    expect(attempt.failureReason).toBeNull();
  });

  it("refuses a state the contract does not have", () => {
    // `attempts_state_valid` makes this unreachable through normal writes, so
    // reaching it means the schema and the contract have drifted apart.
    expect(() => rowToAttempt(attemptRow({ state: "ALMOST_SENT" }))).toThrow(
      /is not in the contract/,
    );
  });
});

describe("rowToDraft", () => {
  const row = {
    id: "drf_0001",
    merchant_id: "mch_0001",
    campaign_id: "cmp_0001",
    locale: "en-GB",
    subject: "A subject",
    body: "A body with a 4.8 rating in it.",
    evidence: [{ claim: "a 4.8 rating", sourceField: "rating", sourceValue: "4.8" }],
    model: "claude-sonnet-5",
    created_at: new Date("2026-08-12T08:00:00.000Z"),
  };

  it("parses evidence that arrives already decoded", () => {
    expect(rowToDraft(row).evidence).toEqual([
      { claim: "a 4.8 rating", sourceField: "rating", sourceValue: "4.8" },
    ]);
  });

  it("parses evidence that arrives as text", () => {
    expect(rowToDraft({ ...row, evidence: JSON.stringify(row.evidence) }).evidence).toHaveLength(1);
  });

  it("rejects evidence that is not shaped like evidence", () => {
    // A malformed claim is the ungrounded claim the pipeline exists to catch,
    // so it stops the run rather than being filtered out quietly.
    expect(() => toEvidence([{ claim: "a 4.8 rating" }], "drf_0001")).toThrow(/is missing claim/);
    expect(() => toEvidence("{}", "drf_0001")).toThrow(/not a JSON array/);
  });

  it("treats missing evidence as no claims", () => {
    expect(toEvidence(null, "drf_0001")).toEqual([]);
  });
});

describe("rowToMerchant", () => {
  const row = {
    id: "mch_0001",
    name: "Lumen Coffee House",
    category: "restaurant",
    city: "Leeds",
    country_code: "GB",
    locale: "en-GB",
    website_url: null,
    contact_email: "hello@example.invalid",
    rating: "4.8",
    review_count: 62,
    years_in_business: 3,
    has_active_offer: false,
    last_offer_ended_at: null,
    seats_or_capacity: 40,
  };

  it("reads a NUMERIC rating that arrived as a string", () => {
    // NUMERIC comes back as text, because a float would lose precision. The
    // gates compare it against numbers in the body, so it has to be a number.
    expect(rowToMerchant(row).rating).toBe(4.8);
  });

  it("refuses a category the contract does not have", () => {
    expect(() => rowToMerchant({ ...row, category: "nightclub" })).toThrow(
      /is not in the contract/,
    );
  });
});
