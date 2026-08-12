/**
 * Enrichment: turning stored facts into signals a draft can be built on.
 *
 * The one rule this file exists to enforce is grounding. Every
 * `MerchantSignal` carries a `sourceField` that names the `Merchant` field it
 * was derived from, and its `value` quotes that field's actual content. A
 * signal that cannot point at a field is not produced at all — there is no
 * "general interest" or "looks promising" catch-all, because a draft built on
 * one of those is exactly the hallucination the gates are meant to catch.
 *
 * Derivation is a pure function of the merchant and a reference date, so the
 * same input always yields the same signals in the same order.
 */

import type { Merchant, MerchantCategory, MerchantSignal } from "../../shared/contracts.js";

// ─── Thresholds ────────────────────────────────────────────────
//
// Named constants rather than inline numbers: these are product decisions,
// and the tests assert against the same names.

/** An offer that ended less recently than this counts as a gap worth raising. */
export const DEAL_GAP_MIN_DAYS = 90;

/** "Well rated but barely reviewed" — the case a model likes to embellish. */
export const HIGH_RATING_MIN = 4.5;
export const LOW_REVIEW_COUNT_MAX = 40;

/** Trading for this long or less still counts as new to the marketplace. */
export const NEW_TO_MARKET_MAX_YEARS = 2;

/** Capacity from which a weekday offer has something to fill, per category. */
export const CAPACITY_HEADROOM_MIN: Record<MerchantCategory, number> = {
  restaurant: 80,
  spa_wellness: 25,
  fitness: 60,
  beauty: 12,
  activity: 40,
  class_workshop: 20,
};

/**
 * Months (1–12) in which demand for a category peaks.
 *
 * Deliberately coarse and hard-coded: a seasonality model is not what this
 * project is demonstrating, and a hard-coded table is honest about that.
 */
export const SEASONAL_PEAK_MONTHS: Record<MerchantCategory, readonly number[]> = {
  restaurant: [11, 12],
  spa_wellness: [1, 2, 11, 12],
  fitness: [1, 2, 9],
  beauty: [5, 6, 12],
  activity: [4, 5, 6, 7, 8],
  class_workshop: [1, 9, 10],
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Category names as they should read inside a sentence. */
const CATEGORY_LABELS: Record<MerchantCategory, string> = {
  restaurant: "restaurant",
  spa_wellness: "spa and wellness",
  fitness: "fitness",
  beauty: "beauty",
  activity: "activity",
  class_workshop: "class and workshop",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EnrichOptions {
  /**
   * Reference date for anything time-dependent. Injected rather than read
   * from the clock so tests — and fixtures — stay deterministic.
   */
  now?: Date;
}

// ─── Helpers ───────────────────────────────────────────────────

function monthName(monthNumber: number): string {
  const name = MONTH_NAMES[monthNumber - 1];
  if (name === undefined) {
    throw new Error(`Month ${monthNumber} is out of range 1–12.`);
  }
  return name;
}

/** The date part of an ISO timestamp, which is what a draft would quote. */
function isoDatePart(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

// ─── Individual signals ────────────────────────────────────────
//
// Each returns null when the merchant does not support the claim. Null is the
// normal case, not a failure: a merchant with three signals is simply better
// material than a merchant with one.

/**
 * `deal_gap` — nothing is running now, and nothing has for a while.
 *
 * Two shapes, because "their last offer ended in November" and "they have
 * never run one" are different sales conversations and come from different
 * fields.
 */
export function dealGapSignal(merchant: Merchant, now: Date): MerchantSignal | null {
  if (merchant.hasActiveOffer) {
    return null;
  }

  if (merchant.lastOfferEndedAt === null) {
    return {
      key: "deal_gap",
      value: "No offer has ever run for this merchant.",
      sourceField: "hasActiveOffer",
    };
  }

  const endedAt = new Date(merchant.lastOfferEndedAt);
  if (Number.isNaN(endedAt.getTime())) {
    throw new Error(
      `Merchant ${merchant.id} has an unparseable lastOfferEndedAt: "${merchant.lastOfferEndedAt}".`,
    );
  }

  if (wholeDaysBetween(endedAt, now) < DEAL_GAP_MIN_DAYS) {
    return null;
  }

  return {
    key: "deal_gap",
    // Only the stored date appears in the text. A derived number such as
    // "282 days" would be a number that gate G06 could not find in the
    // source record.
    value: `Their last offer ended on ${isoDatePart(merchant.lastOfferEndedAt)} and none has run since.`,
    sourceField: "lastOfferEndedAt",
  };
}

/** `high_rating_low_volume` — strong reputation, small sample. */
export function highRatingLowVolumeSignal(merchant: Merchant): MerchantSignal | null {
  const { rating, reviewCount } = merchant;
  if (rating === null || reviewCount === null) {
    return null;
  }
  if (rating < HIGH_RATING_MIN || reviewCount > LOW_REVIEW_COUNT_MAX) {
    return null;
  }

  return {
    key: "high_rating_low_volume",
    value: `Rated ${rating} out of 5 from only ${reviewCount} reviews.`,
    sourceField: "rating",
  };
}

/**
 * `seasonal_window` — the category's peak month is here or next month.
 *
 * Next month counts too: an outreach that lands the week the season starts is
 * already late.
 */
export function seasonalWindowSignal(merchant: Merchant, now: Date): MerchantSignal | null {
  const peakMonths = SEASONAL_PEAK_MONTHS[merchant.category];
  const currentMonth = now.getUTCMonth() + 1;
  const nextMonth = (currentMonth % 12) + 1;

  const label = CATEGORY_LABELS[merchant.category];

  if (peakMonths.includes(currentMonth)) {
    return {
      key: "seasonal_window",
      value: `${monthName(currentMonth)} is a peak month for ${label} bookings.`,
      sourceField: "category",
    };
  }

  if (peakMonths.includes(nextMonth)) {
    return {
      key: "seasonal_window",
      value: `${monthName(nextMonth)} is a peak month for ${label} bookings and it starts next month.`,
      sourceField: "category",
    };
  }

  return null;
}

/** `capacity_headroom` — enough seats that a quiet weekday hurts. */
export function capacityHeadroomSignal(merchant: Merchant): MerchantSignal | null {
  const { seatsOrCapacity } = merchant;
  if (seatsOrCapacity === null) {
    return null;
  }
  if (seatsOrCapacity < CAPACITY_HEADROOM_MIN[merchant.category]) {
    return null;
  }

  return {
    key: "capacity_headroom",
    value: `Capacity of ${seatsOrCapacity} leaves room to fill on quieter days.`,
    sourceField: "seatsOrCapacity",
  };
}

/** `new_to_market` — young business, still building an audience. */
export function newToMarketSignal(merchant: Merchant): MerchantSignal | null {
  const { yearsInBusiness } = merchant;
  if (yearsInBusiness === null || yearsInBusiness > NEW_TO_MARKET_MAX_YEARS) {
    return null;
  }

  const traded =
    yearsInBusiness === 0
      ? "Opened within the last year"
      : `Trading for ${yearsInBusiness} year${yearsInBusiness === 1 ? "" : "s"}`;

  return {
    key: "new_to_market",
    value: `${traded}, so still building an audience.`,
    sourceField: "yearsInBusiness",
  };
}

// ─── Derivation ────────────────────────────────────────────────

/**
 * Derive every signal a merchant supports.
 *
 * The order is fixed — it is the order the functions are listed in below, not
 * the order the data happens to arrive in — so two runs over the same
 * merchant produce identical JSON and a diff of stored signals means a real
 * change.
 */
export function deriveSignals(merchant: Merchant, options: EnrichOptions = {}): MerchantSignal[] {
  const now = options.now ?? new Date();

  const candidates = [
    dealGapSignal(merchant, now),
    highRatingLowVolumeSignal(merchant),
    seasonalWindowSignal(merchant, now),
    capacityHeadroomSignal(merchant),
    newToMarketSignal(merchant),
  ];

  return candidates.filter((signal): signal is MerchantSignal => signal !== null);
}
