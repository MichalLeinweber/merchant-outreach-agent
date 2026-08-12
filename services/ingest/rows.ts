/**
 * Database rows in, domain objects out.
 *
 * Kept apart from the endpoints because the conversion is where the
 * unpleasant surprises live: `NUMERIC` can arrive as a string, `TIMESTAMPTZ`
 * as a `Date`, and `JSONB` either parsed or as text depending on the driver.
 * Doing it in a pure function means it can be tested without a database,
 * which is the only kind of test that runs in this project's unit suite.
 */

import type {
  EnrichedMerchant,
  Merchant,
  MerchantCategory,
  MerchantSignal,
} from "../../shared/contracts.js";
import { MERCHANT_CATEGORIES, MERCHANT_FIELDS } from "./validation.js";

/** A row of `merchants`, optionally joined with `enrichments.signals`. */
export interface MerchantRow {
  id: string;
  name: string;
  category: string;
  city: string;
  country_code: string;
  locale: string;
  website_url: string | null;
  contact_email: string;
  rating: number | string | null;
  review_count: number | null;
  years_in_business: number | null;
  has_active_offer: boolean;
  last_offer_ended_at: Date | string | null;
  seats_or_capacity: number | null;
  signals?: unknown;
}

const SIGNAL_KEYS: readonly MerchantSignal["key"][] = [
  "deal_gap",
  "high_rating_low_volume",
  "seasonal_window",
  "capacity_headroom",
  "new_to_market",
];

function toNumberOrNull(value: number | string | null, column: string, id: string): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Merchant ${id}: column ${column} holds "${value}", which is not a number.`);
  }
  return parsed;
}

/** `TIMESTAMPTZ` reaches us as a Date; the contract wants an ISO string. */
function toIsoOrNull(value: Date | string | null, column: string, id: string): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Merchant ${id}: column ${column} holds "${String(value)}", not a timestamp.`);
  }
  return date.toISOString();
}

function toCategory(value: string, id: string): MerchantCategory {
  const category = MERCHANT_CATEGORIES.find((candidate) => candidate === value);
  if (category === undefined) {
    // The merchants_category_valid CHECK makes this unreachable through
    // normal writes, so reaching it means the schema and the contract have
    // drifted apart and the run should stop rather than guess.
    throw new Error(
      `Merchant ${id}: category "${value}" is not in the contract (${MERCHANT_CATEGORIES.join(", ")}).`,
    );
  }
  return category;
}

/**
 * Parse the stored `MerchantSignal[]`.
 *
 * Strict on purpose: a signal whose `sourceField` is not a real `Merchant`
 * field is exactly the ungrounded claim the pipeline is built to prevent, so
 * it is an error rather than something to filter out quietly.
 */
export function toSignals(raw: unknown, id: string): MerchantSignal[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) {
    throw new Error(`Merchant ${id}: stored signals are not a JSON array.`);
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Merchant ${id}: signal ${index} is not an object.`);
    }
    const { key, value, sourceField } = entry as Record<string, unknown>;

    if (typeof key !== "string" || !SIGNAL_KEYS.includes(key as MerchantSignal["key"])) {
      throw new Error(`Merchant ${id}: signal ${index} has unknown key "${String(key)}".`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Merchant ${id}: signal ${index} has no readable value.`);
    }
    if (
      typeof sourceField !== "string" ||
      !MERCHANT_FIELDS.includes(sourceField as keyof Merchant)
    ) {
      throw new Error(
        `Merchant ${id}: signal ${index} has sourceField "${String(sourceField)}", ` +
          `which is not a field of Merchant.`,
      );
    }

    return {
      key: key as MerchantSignal["key"],
      value,
      sourceField: sourceField as keyof Merchant,
    };
  });
}

export function rowToMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    category: toCategory(row.category, row.id),
    city: row.city,
    countryCode: row.country_code,
    locale: row.locale,
    websiteUrl: row.website_url,
    contactEmail: row.contact_email,
    rating: toNumberOrNull(row.rating, "rating", row.id),
    reviewCount: row.review_count,
    yearsInBusiness: row.years_in_business,
    hasActiveOffer: row.has_active_offer,
    lastOfferEndedAt: toIsoOrNull(row.last_offer_ended_at, "last_offer_ended_at", row.id),
    seatsOrCapacity: row.seats_or_capacity,
  };
}

export function rowToEnrichedMerchant(row: MerchantRow): EnrichedMerchant {
  return {
    ...rowToMerchant(row),
    signals: toSignals(row.signals, row.id),
  };
}
