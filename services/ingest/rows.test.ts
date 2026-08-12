import { describe, expect, it } from "vitest";

import { rowToEnrichedMerchant, rowToMerchant, toSignals, type MerchantRow } from "./rows.js";

const ROW: MerchantRow = {
  id: "mrc_abc123_0001",
  name: "Zoë's Steam Rooms",
  category: "spa_wellness",
  city: "Kraków",
  country_code: "PL",
  locale: "pl-PL",
  website_url: "https://www.zoe-s-steam-rooms.example.invalid",
  contact_email: "zoe-s-steam-rooms@example.invalid",
  rating: 4.9,
  review_count: 6,
  years_in_business: 1,
  has_active_offer: false,
  last_offer_ended_at: new Date("2025-11-03T00:00:00.000Z"),
  seats_or_capacity: 30,
};

function row(overrides: Partial<MerchantRow> = {}): MerchantRow {
  return { ...ROW, ...overrides };
}

describe("rowToMerchant", () => {
  it("maps snake_case columns onto the contract", () => {
    expect(rowToMerchant(ROW)).toEqual({
      id: "mrc_abc123_0001",
      name: "Zoë's Steam Rooms",
      category: "spa_wellness",
      city: "Kraków",
      countryCode: "PL",
      locale: "pl-PL",
      websiteUrl: "https://www.zoe-s-steam-rooms.example.invalid",
      contactEmail: "zoe-s-steam-rooms@example.invalid",
      rating: 4.9,
      reviewCount: 6,
      yearsInBusiness: 1,
      hasActiveOffer: false,
      lastOfferEndedAt: "2025-11-03T00:00:00.000Z",
      seatsOrCapacity: 30,
    });
  });

  it("accepts NUMERIC as a string, which is how some drivers return it", () => {
    expect(rowToMerchant(row({ rating: "4.9" })).rating).toBe(4.9);
  });

  it("accepts a timestamp as either a Date or a string", () => {
    expect(rowToMerchant(row({ last_offer_ended_at: "2025-11-03T00:00:00Z" })).lastOfferEndedAt)
      .toBe("2025-11-03T00:00:00.000Z");
  });

  it("keeps nulls as nulls", () => {
    const merchant = rowToMerchant(
      row({
        rating: null,
        review_count: null,
        years_in_business: null,
        last_offer_ended_at: null,
        seats_or_capacity: null,
        website_url: null,
      }),
    );
    expect(merchant.rating).toBeNull();
    expect(merchant.lastOfferEndedAt).toBeNull();
    expect(merchant.websiteUrl).toBeNull();
  });

  it("refuses a category the contract does not know", () => {
    expect(() => rowToMerchant(row({ category: "hotel" }))).toThrow(/not in the contract/);
  });

  it("refuses a value that cannot be a number or a date", () => {
    expect(() => rowToMerchant(row({ rating: "four" }))).toThrow(/not a number/);
    expect(() => rowToMerchant(row({ last_offer_ended_at: "whenever" }))).toThrow(/not a timestamp/);
  });
});

describe("toSignals", () => {
  const stored = [
    { key: "high_rating_low_volume", value: "Rated 4.9 out of 5 from only 6 reviews.", sourceField: "rating" },
  ];

  it("reads signals whether the driver parsed the JSONB or not", () => {
    expect(toSignals(stored, "id")).toEqual(stored);
    expect(toSignals(JSON.stringify(stored), "id")).toEqual(stored);
  });

  it("treats a missing enrichment row as no signals", () => {
    expect(toSignals(null, "id")).toEqual([]);
    expect(toSignals(undefined, "id")).toEqual([]);
  });

  it("refuses a signal whose sourceField is not a Merchant field", () => {
    // An ungrounded signal is the exact failure this project exists to
    // prevent, so it stops the read rather than being filtered out quietly.
    expect(() =>
      toSignals([{ key: "deal_gap", value: "…", sourceField: "vibes" }], "mrc_1"),
    ).toThrow(/not a field of Merchant/);
  });

  it("refuses an unknown signal key or an empty value", () => {
    expect(() =>
      toSignals([{ key: "gut_feeling", value: "…", sourceField: "rating" }], "mrc_1"),
    ).toThrow(/unknown key/);
    expect(() =>
      toSignals([{ key: "deal_gap", value: "", sourceField: "rating" }], "mrc_1"),
    ).toThrow(/no readable value/);
  });

  it("refuses stored signals that are not an array", () => {
    expect(() => toSignals({ key: "deal_gap" }, "mrc_1")).toThrow(/not a JSON array/);
  });
});

describe("rowToEnrichedMerchant", () => {
  it("attaches the signals to the merchant", () => {
    const enriched = rowToEnrichedMerchant(
      row({
        signals: [
          { key: "new_to_market", value: "Trading for 1 year, so still building an audience.", sourceField: "yearsInBusiness" },
        ],
      }),
    );
    expect(enriched.id).toBe(ROW.id);
    expect(enriched.signals).toHaveLength(1);
    expect(enriched.signals[0]?.sourceField).toBe("yearsInBusiness");
  });

  it("returns an empty signal list when the merchant has not been enriched", () => {
    expect(rowToEnrichedMerchant(row()).signals).toEqual([]);
  });
});
