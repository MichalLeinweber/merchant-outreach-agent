import { describe, expect, it } from "vitest";

import type { Merchant, MerchantSignal } from "../../shared/contracts.js";
import { generateMerchants } from "../../scripts/generate-merchants.js";
import {
  CAPACITY_HEADROOM_MIN,
  DEAL_GAP_MIN_DAYS,
  HIGH_RATING_MIN,
  LOW_REVIEW_COUNT_MAX,
  NEW_TO_MARKET_MAX_YEARS,
  capacityHeadroomSignal,
  dealGapSignal,
  deriveSignals,
  highRatingLowVolumeSignal,
  newToMarketSignal,
  seasonalWindowSignal,
} from "./enrich.js";
import { MERCHANT_FIELDS } from "./validation.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A merchant with no signals at all, so each test can add exactly one. */
const NEUTRAL: Merchant = {
  id: "mrc_test_0001",
  name: "The Copper Lantern",
  // August is not a peak month for restaurants, and September is not either,
  // so the baseline produces no seasonal signal.
  category: "restaurant",
  city: "Leeds",
  countryCode: "GB",
  locale: "en-GB",
  websiteUrl: "https://www.the-copper-lantern.example.invalid",
  contactEmail: "the-copper-lantern@example.invalid",
  rating: 4.2,
  reviewCount: 380,
  yearsInBusiness: 11,
  hasActiveOffer: true,
  lastOfferEndedAt: null,
  seatsOrCapacity: 40,
};

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return { ...NEUTRAL, ...overrides };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function keys(signals: readonly MerchantSignal[]): string[] {
  return signals.map((signal) => signal.key);
}

describe("the neutral merchant", () => {
  it("produces no signals, so every test below adds exactly one", () => {
    expect(deriveSignals(NEUTRAL, { now: NOW })).toEqual([]);
  });
});

describe("deal_gap", () => {
  it("fires when the last offer ended long enough ago", () => {
    const signal = dealGapSignal(
      merchant({ hasActiveOffer: false, lastOfferEndedAt: daysAgo(200) }),
      NOW,
    );
    expect(signal).toEqual({
      key: "deal_gap",
      value: "Their last offer ended on 2026-01-24 and none has run since.",
      sourceField: "lastOfferEndedAt",
    });
  });

  it("fires exactly at the threshold", () => {
    const signal = dealGapSignal(
      merchant({ hasActiveOffer: false, lastOfferEndedAt: daysAgo(DEAL_GAP_MIN_DAYS) }),
      NOW,
    );
    expect(signal?.key).toBe("deal_gap");
  });

  it("stays quiet one day below the threshold", () => {
    const signal = dealGapSignal(
      merchant({ hasActiveOffer: false, lastOfferEndedAt: daysAgo(DEAL_GAP_MIN_DAYS - 1) }),
      NOW,
    );
    expect(signal).toBeNull();
  });

  it("stays quiet while an offer is running", () => {
    const signal = dealGapSignal(
      merchant({ hasActiveOffer: true, lastOfferEndedAt: daysAgo(900) }),
      NOW,
    );
    expect(signal).toBeNull();
  });

  it("uses hasActiveOffer as its source when no offer has ever run", () => {
    const signal = dealGapSignal(
      merchant({ hasActiveOffer: false, lastOfferEndedAt: null }),
      NOW,
    );
    expect(signal).toEqual({
      key: "deal_gap",
      value: "No offer has ever run for this merchant.",
      sourceField: "hasActiveOffer",
    });
  });

  it("refuses to guess at an unparseable date", () => {
    expect(() =>
      dealGapSignal(merchant({ hasActiveOffer: false, lastOfferEndedAt: "last Tuesday" }), NOW),
    ).toThrow(/unparseable lastOfferEndedAt/);
  });
});

describe("high_rating_low_volume", () => {
  it("fires on the case the spec calls out: 4.9 from 6 reviews", () => {
    const signal = highRatingLowVolumeSignal(merchant({ rating: 4.9, reviewCount: 6 }));
    expect(signal).toEqual({
      key: "high_rating_low_volume",
      value: "Rated 4.9 out of 5 from only 6 reviews.",
      sourceField: "rating",
    });
  });

  it("fires exactly at both thresholds", () => {
    const signal = highRatingLowVolumeSignal(
      merchant({ rating: HIGH_RATING_MIN, reviewCount: LOW_REVIEW_COUNT_MAX }),
    );
    expect(signal?.key).toBe("high_rating_low_volume");
  });

  it("stays quiet when the rating is lower", () => {
    expect(highRatingLowVolumeSignal(merchant({ rating: 4.4, reviewCount: 6 }))).toBeNull();
  });

  it("stays quiet when the sample is large", () => {
    expect(highRatingLowVolumeSignal(merchant({ rating: 4.9, reviewCount: 4100 }))).toBeNull();
  });

  it("stays quiet when there is no rating at all", () => {
    expect(highRatingLowVolumeSignal(merchant({ rating: null, reviewCount: null }))).toBeNull();
  });
});

describe("seasonal_window", () => {
  it("fires when the current month is a peak month", () => {
    const signal = seasonalWindowSignal(merchant({ category: "activity" }), NOW);
    expect(signal).toEqual({
      key: "seasonal_window",
      value: "August is a peak month for activity bookings.",
      sourceField: "category",
    });
  });

  it("fires a month ahead, because outreach needs lead time", () => {
    // October: restaurants peak in November.
    const signal = seasonalWindowSignal(
      merchant({ category: "restaurant" }),
      new Date("2026-10-05T00:00:00.000Z"),
    );
    expect(signal?.value).toBe(
      "November is a peak month for restaurant bookings and it starts next month.",
    );
  });

  it("wraps from December to January", () => {
    const signal = seasonalWindowSignal(
      merchant({ category: "fitness" }),
      new Date("2026-12-20T00:00:00.000Z"),
    );
    expect(signal?.value).toBe(
      "January is a peak month for fitness bookings and it starts next month.",
    );
  });

  it("stays quiet outside the window", () => {
    expect(
      seasonalWindowSignal(merchant({ category: "restaurant" }), NOW),
    ).toBeNull();
  });
});

describe("capacity_headroom", () => {
  it("fires when capacity clears the category's threshold", () => {
    const signal = capacityHeadroomSignal(merchant({ seatsOrCapacity: 120 }));
    expect(signal).toEqual({
      key: "capacity_headroom",
      value: "Capacity of 120 leaves room to fill on quieter days.",
      sourceField: "seatsOrCapacity",
    });
  });

  it("uses a threshold that depends on the category", () => {
    // Twelve chairs is a lot for a salon and nothing for a restaurant.
    expect(
      capacityHeadroomSignal(merchant({ category: "beauty", seatsOrCapacity: 12 }))?.key,
    ).toBe("capacity_headroom");
    expect(
      capacityHeadroomSignal(merchant({ category: "restaurant", seatsOrCapacity: 12 })),
    ).toBeNull();
    expect(CAPACITY_HEADROOM_MIN.beauty).toBeLessThan(CAPACITY_HEADROOM_MIN.restaurant);
  });

  it("stays quiet when capacity is unknown", () => {
    expect(capacityHeadroomSignal(merchant({ seatsOrCapacity: null }))).toBeNull();
  });
});

describe("new_to_market", () => {
  it("fires for a business in its first years", () => {
    expect(newToMarketSignal(merchant({ yearsInBusiness: 1 }))).toEqual({
      key: "new_to_market",
      value: "Trading for 1 year, so still building an audience.",
      sourceField: "yearsInBusiness",
    });
    expect(newToMarketSignal(merchant({ yearsInBusiness: 2 }))?.value).toBe(
      "Trading for 2 years, so still building an audience.",
    );
  });

  it("phrases the zero case without a misleading number", () => {
    expect(newToMarketSignal(merchant({ yearsInBusiness: 0 }))?.value).toBe(
      "Opened within the last year, so still building an audience.",
    );
  });

  it("stays quiet for an established business", () => {
    expect(
      newToMarketSignal(merchant({ yearsInBusiness: NEW_TO_MARKET_MAX_YEARS + 1 })),
    ).toBeNull();
  });

  it("stays quiet when the age is unknown", () => {
    expect(newToMarketSignal(merchant({ yearsInBusiness: null }))).toBeNull();
  });
});

describe("deriveSignals", () => {
  it("returns signals in a fixed order regardless of the merchant", () => {
    const everything = merchant({
      category: "activity",
      hasActiveOffer: false,
      lastOfferEndedAt: daysAgo(400),
      rating: 4.9,
      reviewCount: 6,
      seatsOrCapacity: 100,
      yearsInBusiness: 1,
    });

    expect(keys(deriveSignals(everything, { now: NOW }))).toEqual([
      "deal_gap",
      "high_rating_low_volume",
      "seasonal_window",
      "capacity_headroom",
      "new_to_market",
    ]);
  });

  it("is deterministic for the same merchant and reference date", () => {
    const input = merchant({ hasActiveOffer: false, lastOfferEndedAt: daysAgo(400) });
    expect(deriveSignals(input, { now: NOW })).toEqual(deriveSignals(input, { now: NOW }));
  });

  it("produces nothing for a merchant with no material and an active offer", () => {
    const bare = merchant({
      rating: null,
      reviewCount: null,
      websiteUrl: null,
      seatsOrCapacity: null,
      yearsInBusiness: null,
    });
    expect(deriveSignals(bare, { now: NOW })).toEqual([]);
  });
});

describe("grounding", () => {
  // The point of the whole enrichment step: nothing is claimed that cannot be
  // traced back to a field of the merchant record it came from.
  const merchants = generateMerchants({ seed: "grounding", count: 200 });

  it("gives every signal a sourceField that exists on Merchant", () => {
    for (const record of merchants) {
      for (const signal of deriveSignals(record, { now: NOW })) {
        expect(MERCHANT_FIELDS, `${record.id} / ${signal.key}`).toContain(signal.sourceField);
      }
    }
  });

  it("never points a signal at a field that is null", () => {
    for (const record of merchants) {
      for (const signal of deriveSignals(record, { now: NOW })) {
        expect(
          record[signal.sourceField],
          `${record.id} / ${signal.key} points at empty ${signal.sourceField}`,
        ).not.toBeNull();
      }
    }
  });

  it("quotes the actual field value in the signal text", () => {
    for (const record of merchants) {
      for (const signal of deriveSignals(record, { now: NOW })) {
        switch (signal.key) {
          case "deal_gap":
            if (signal.sourceField === "lastOfferEndedAt" && record.lastOfferEndedAt !== null) {
              expect(signal.value).toContain(record.lastOfferEndedAt.slice(0, 10));
            }
            break;
          case "high_rating_low_volume":
            expect(signal.value).toContain(String(record.rating));
            expect(signal.value).toContain(String(record.reviewCount));
            break;
          case "capacity_headroom":
            expect(signal.value).toContain(String(record.seatsOrCapacity));
            break;
          case "new_to_market":
            if (record.yearsInBusiness !== 0) {
              expect(signal.value).toContain(String(record.yearsInBusiness));
            }
            break;
          case "seasonal_window":
            // Grounded in the category, which is named in the text.
            expect(signal.value.toLowerCase()).toContain(
              record.category.split("_")[0] ?? record.category,
            );
            break;
        }
      }
    }
  });

  it("covers all five signal types across a generated batch", () => {
    const seen = new Set<string>();
    // Two reference dates, because seasonal windows are month-dependent and
    // no single month is a peak for every category.
    for (const now of [NOW, new Date("2026-01-15T00:00:00.000Z")]) {
      for (const record of merchants) {
        for (const signal of deriveSignals(record, { now })) {
          seen.add(signal.key);
        }
      }
    }
    expect([...seen].sort()).toEqual([
      "capacity_headroom",
      "deal_gap",
      "high_rating_low_volume",
      "new_to_market",
      "seasonal_window",
    ]);
  });
});
