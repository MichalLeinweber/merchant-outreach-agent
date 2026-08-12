/**
 * Ingest endpoints: the only way merchants enter the system.
 *
 * A batch is accepted whole or not at all. Validation runs over the entire
 * batch before anything is written, the writes happen inside one transaction,
 * and enrichment runs in that same transaction — so there is no window in
 * which a merchant exists without its signals, and no half-loaded batch to
 * reason about afterwards.
 *
 * Owns: `merchants`, `enrichments`.
 */

import { api, APIError, Query } from "encore.dev/api";

import type { EnrichedMerchant, Merchant, MerchantSignal } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import { deriveSignals } from "./enrich.js";
import { rowToEnrichedMerchant, type MerchantRow } from "./rows.js";
import {
  MERCHANT_CATEGORIES,
  describeProblems,
  validateBatch,
} from "./validation.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// ─── Ingest a batch ────────────────────────────────────────────

export interface IngestMerchantsRequest {
  merchants: Merchant[];
}

export interface IngestMerchantsResponse {
  /** How many merchants the request carried. */
  received: number;
  /** New rows in `merchants`. */
  inserted: number;
  /** Rows that already existed and were overwritten. */
  updated: number;
  /** Signals derived and stored across the batch. */
  signalsWritten: number;
  /** The reference time enrichment used, so a run is reproducible. */
  enrichedAt: string;
}

/**
 * Accept a batch of merchants, store them, and enrich them.
 *
 * Re-sending the same batch is safe: merchants are upserted by id and their
 * signals are recomputed. That matters because enrichment is time-dependent —
 * a seasonal window that was open in October is not open in March, and
 * re-ingesting is how that gets refreshed.
 */
export const ingestMerchants = api(
  { expose: true, method: "POST", path: "/ingest/merchants" },
  async (request: IngestMerchantsRequest): Promise<IngestMerchantsResponse> => {
    const merchants = request.merchants ?? [];

    const problems = validateBatch(merchants);
    if (problems.length > 0) {
      // Loud and complete: every problem in the batch, not just the first.
      throw APIError.invalidArgument(
        `Rejected the batch of ${merchants.length} merchant(s); nothing was written. ` +
          `${problems.length} problem(s): ${describeProblems(problems)}`,
      );
    }

    const enrichedAt = new Date();
    let inserted = 0;
    let signalsWritten = 0;

    const tx = await db.begin();
    try {
      for (const merchant of merchants) {
        // `xmax = 0` is true only for a freshly inserted row, which is how a
        // single upsert can report whether it created or replaced.
        const row = await tx.queryRow<{ inserted: boolean }>`
          INSERT INTO merchants (
            id, name, category, city, country_code, locale, website_url,
            contact_email, rating, review_count, years_in_business,
            has_active_offer, last_offer_ended_at, seats_or_capacity
          ) VALUES (
            ${merchant.id}, ${merchant.name}, ${merchant.category}, ${merchant.city},
            ${merchant.countryCode}, ${merchant.locale}, ${merchant.websiteUrl},
            ${merchant.contactEmail}, ${merchant.rating}::numeric, ${merchant.reviewCount},
            ${merchant.yearsInBusiness}, ${merchant.hasActiveOffer},
            ${merchant.lastOfferEndedAt}::timestamptz, ${merchant.seatsOrCapacity}
          )
          ON CONFLICT (id) DO UPDATE SET
            name                = EXCLUDED.name,
            category            = EXCLUDED.category,
            city                = EXCLUDED.city,
            country_code        = EXCLUDED.country_code,
            locale              = EXCLUDED.locale,
            website_url         = EXCLUDED.website_url,
            contact_email       = EXCLUDED.contact_email,
            rating              = EXCLUDED.rating,
            review_count        = EXCLUDED.review_count,
            years_in_business   = EXCLUDED.years_in_business,
            has_active_offer    = EXCLUDED.has_active_offer,
            last_offer_ended_at = EXCLUDED.last_offer_ended_at,
            seats_or_capacity   = EXCLUDED.seats_or_capacity
          RETURNING (xmax = 0) AS inserted
        `;

        if (row?.inserted) {
          inserted += 1;
        }

        const signals: MerchantSignal[] = deriveSignals(merchant, { now: enrichedAt });
        signalsWritten += signals.length;

        await tx.exec`
          INSERT INTO enrichments (merchant_id, signals, enriched_at)
          VALUES (${merchant.id}, ${JSON.stringify(signals)}::jsonb, ${enrichedAt.toISOString()}::timestamptz)
          ON CONFLICT (merchant_id) DO UPDATE SET
            signals     = EXCLUDED.signals,
            enriched_at = EXCLUDED.enriched_at
        `;
      }

      await tx.commit();
    } catch (cause) {
      // Either the whole batch lands or none of it does.
      await tx.rollback();
      throw cause;
    }

    return {
      received: merchants.length,
      inserted,
      updated: merchants.length - inserted,
      signalsWritten,
      enrichedAt: enrichedAt.toISOString(),
    };
  },
);

// ─── Read back ─────────────────────────────────────────────────

// The column list is repeated in both read queries rather than shared as a
// string: Encore's tagged template is not string concatenation, and an
// interpolated fragment would be sent as a bind parameter, not as SQL.

export interface GetMerchantParams {
  id: string;
}

/** One merchant with its derived signals. */
export const getMerchant = api(
  { expose: true, method: "GET", path: "/ingest/merchants/:id" },
  async ({ id }: GetMerchantParams): Promise<EnrichedMerchant> => {
    const row = await db.queryRow<MerchantRow>`
      SELECT
        m.id, m.name, m.category, m.city, m.country_code, m.locale, m.website_url,
        m.contact_email, m.rating::float8 AS rating, m.review_count,
        m.years_in_business, m.has_active_offer, m.last_offer_ended_at,
        m.seats_or_capacity, e.signals
      FROM merchants m
      LEFT JOIN enrichments e ON e.merchant_id = m.id
      WHERE m.id = ${id}
    `;

    if (row === null) {
      throw APIError.notFound(`No merchant with id "${id}".`);
    }

    return rowToEnrichedMerchant(row);
  },
);

export interface ListMerchantsRequest {
  /** Defaults to 50, capped at 200. */
  limit?: Query<number>;
  offset?: Query<number>;
  /** Optional `MerchantCategory` filter. */
  category?: Query<string>;
}

export interface ListMerchantsResponse {
  merchants: EnrichedMerchant[];
  /** Total matching the filter, ignoring limit and offset. */
  total: number;
}

/**
 * List merchants with their signals.
 *
 * Ordered by id, which is stable and — because ids are assigned in generation
 * order — also the order the seed file is in, so paging is repeatable.
 */
export const listMerchants = api(
  { expose: true, method: "GET", path: "/ingest/merchants" },
  async (request: ListMerchantsRequest): Promise<ListMerchantsResponse> => {
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const offset = Math.max(request.offset ?? 0, 0);

    const category = request.category ?? null;
    if (category !== null && !MERCHANT_CATEGORIES.some((known) => known === category)) {
      throw APIError.invalidArgument(
        `category "${category}" is not one of: ${MERCHANT_CATEGORIES.join(", ")}.`,
      );
    }

    const merchants: EnrichedMerchant[] = [];
    for await (const row of db.query<MerchantRow>`
      SELECT
        m.id, m.name, m.category, m.city, m.country_code, m.locale, m.website_url,
        m.contact_email, m.rating::float8 AS rating, m.review_count,
        m.years_in_business, m.has_active_offer, m.last_offer_ended_at,
        m.seats_or_capacity, e.signals
      FROM merchants m
      LEFT JOIN enrichments e ON e.merchant_id = m.id
      WHERE (${category}::text IS NULL OR m.category = ${category}::text)
      ORDER BY m.id
      LIMIT ${limit} OFFSET ${offset}
    `) {
      merchants.push(rowToEnrichedMerchant(row));
    }

    const totals = await db.queryRow<{ total: number }>`
      SELECT COUNT(*)::int AS total
      FROM merchants m
      WHERE (${category}::text IS NULL OR m.category = ${category}::text)
    `;

    return { merchants, total: totals?.total ?? 0 };
  },
);
