/**
 * Batch validation for incoming merchants.
 *
 * The database is the real enforcement — `merchants_email_synthetic`,
 * `merchants_rating_range` and the rest cannot be talked out of by any
 * caller, which is why they live there. What this file adds is a readable
 * failure: a constraint violation says "23514 merchants_rating_range", while
 * this says which merchant, which field and what was wrong with it, for the
 * whole batch at once instead of one row at a time.
 *
 * Nothing here is lenient. There is no coercion, no dropping of bad rows and
 * no partial ingest: a batch with one broken merchant is rejected whole.
 */

import type { Merchant, MerchantCategory } from "../../shared/contracts.js";

/**
 * Every field of `Merchant`, derived from the type itself.
 *
 * The map is typed as `Record<keyof Merchant, true>`, so if the frozen
 * contract ever gains a field this stops compiling instead of silently
 * falling out of date. Used to check that a signal's `sourceField` names a
 * field that really exists.
 */
const MERCHANT_FIELD_MAP: Record<keyof Merchant, true> = {
  id: true,
  name: true,
  category: true,
  city: true,
  countryCode: true,
  locale: true,
  websiteUrl: true,
  contactEmail: true,
  rating: true,
  reviewCount: true,
  yearsInBusiness: true,
  hasActiveOffer: true,
  lastOfferEndedAt: true,
  seatsOrCapacity: true,
};

export const MERCHANT_FIELDS = Object.keys(MERCHANT_FIELD_MAP) as (keyof Merchant)[];

export const MERCHANT_CATEGORIES: readonly MerchantCategory[] = [
  "restaurant",
  "spa_wellness",
  "fitness",
  "beauty",
  "activity",
  "class_workshop",
];

/** Reserved by RFC 6761: it can never be delivered to, by design. */
export const SYNTHETIC_EMAIL_DOMAIN = "@example.invalid";

/** Largest batch accepted in one request. */
export const MAX_BATCH_SIZE = 500;

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
/** BCP 47, restricted to the language-REGION shapes this project produces. */
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export interface ValidationProblem {
  /** Position in the submitted batch, so the caller can find the record. */
  index: number;
  merchantId: string;
  problem: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Everything wrong with one merchant. Empty array means it is acceptable. */
export function validateMerchant(merchant: Merchant): string[] {
  const problems: string[] = [];

  if (!isNonEmptyString(merchant.id)) {
    problems.push("id must be a non-empty string");
  }
  if (!isNonEmptyString(merchant.name)) {
    problems.push("name must be a non-empty string");
  } else if (merchant.name !== merchant.name.trim()) {
    // Gate G04 compares the name in the draft byte for byte against this
    // value, so a stray space here becomes a false gate failure later.
    problems.push(`name must not have leading or trailing whitespace: "${merchant.name}"`);
  }

  if (!MERCHANT_CATEGORIES.includes(merchant.category)) {
    problems.push(
      `category "${merchant.category}" is not one of: ${MERCHANT_CATEGORIES.join(", ")}`,
    );
  }
  if (!isNonEmptyString(merchant.city)) {
    problems.push("city must be a non-empty string");
  }
  if (!COUNTRY_CODE_PATTERN.test(merchant.countryCode)) {
    problems.push(
      `countryCode "${merchant.countryCode}" is not an ISO 3166-1 alpha-2 code (two capitals)`,
    );
  }
  if (!LOCALE_PATTERN.test(merchant.locale)) {
    problems.push(`locale "${merchant.locale}" is not a BCP 47 tag such as "en-GB"`);
  }

  if (merchant.websiteUrl !== null) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(merchant.websiteUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      problems.push(`websiteUrl "${merchant.websiteUrl}" is not an http(s) URL`);
    }
  }

  if (!isNonEmptyString(merchant.contactEmail)) {
    problems.push("contactEmail must be a non-empty string");
  } else if (!merchant.contactEmail.endsWith(SYNTHETIC_EMAIL_DOMAIN)) {
    // The same rule as the merchants_email_synthetic CHECK. All data in this
    // repository is synthetic; a real address must not be ingestible.
    problems.push(
      `contactEmail "${merchant.contactEmail}" must end in ${SYNTHETIC_EMAIL_DOMAIN} — ` +
        `all data in this project is synthetic`,
    );
  } else if (merchant.contactEmail.indexOf("@") === 0) {
    problems.push(`contactEmail "${merchant.contactEmail}" has no local part`);
  }

  if (merchant.rating !== null && (merchant.rating < 0 || merchant.rating > 5)) {
    problems.push(`rating ${merchant.rating} is outside 0–5`);
  }
  if (merchant.reviewCount !== null && !isNonNegativeInteger(merchant.reviewCount)) {
    problems.push(`reviewCount ${merchant.reviewCount} must be a non-negative integer`);
  }
  if (merchant.yearsInBusiness !== null && !isNonNegativeInteger(merchant.yearsInBusiness)) {
    problems.push(`yearsInBusiness ${merchant.yearsInBusiness} must be a non-negative integer`);
  }
  if (typeof merchant.hasActiveOffer !== "boolean") {
    problems.push("hasActiveOffer must be a boolean");
  }

  if (merchant.lastOfferEndedAt !== null) {
    if (Number.isNaN(new Date(merchant.lastOfferEndedAt).getTime())) {
      problems.push(`lastOfferEndedAt "${merchant.lastOfferEndedAt}" is not an ISO-8601 timestamp`);
    }
  }

  if (
    merchant.seatsOrCapacity !== null &&
    (!Number.isInteger(merchant.seatsOrCapacity) || merchant.seatsOrCapacity <= 0)
  ) {
    problems.push(`seatsOrCapacity ${merchant.seatsOrCapacity} must be a positive integer`);
  }

  return problems;
}

/**
 * Validate a whole batch, including the things only visible across records:
 * batch size and duplicate ids.
 */
export function validateBatch(merchants: readonly Merchant[]): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  if (merchants.length === 0) {
    problems.push({ index: -1, merchantId: "", problem: "the batch is empty" });
    return problems;
  }
  if (merchants.length > MAX_BATCH_SIZE) {
    problems.push({
      index: -1,
      merchantId: "",
      problem:
        `the batch holds ${merchants.length} merchants, more than the limit of ${MAX_BATCH_SIZE}; ` +
        `split it into smaller requests`,
    });
    return problems;
  }

  const seenIds = new Map<string, number>();

  merchants.forEach((merchant, index) => {
    for (const problem of validateMerchant(merchant)) {
      problems.push({ index, merchantId: merchant.id, problem });
    }

    const firstSeenAt = seenIds.get(merchant.id);
    if (firstSeenAt === undefined) {
      seenIds.set(merchant.id, index);
    } else {
      // Two records with the same id in one batch would silently overwrite
      // each other on upsert, and the caller would never learn which won.
      problems.push({
        index,
        merchantId: merchant.id,
        problem: `duplicate id, already present at index ${firstSeenAt} of this batch`,
      });
    }
  });

  return problems;
}

/** One-line rendering of a batch's problems, for an error message. */
export function describeProblems(problems: readonly ValidationProblem[]): string {
  return problems
    .map(({ index, merchantId, problem }) =>
      index < 0 ? problem : `[${index}] ${merchantId || "(no id)"}: ${problem}`,
    )
    .join("; ");
}
