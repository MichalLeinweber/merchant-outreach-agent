/**
 * Database rows in, domain objects out.
 *
 * Same reasoning as `services/ingest/rows.ts`: `TIMESTAMPTZ` arrives as a
 * `Date`, `NUMERIC` as a string, and `JSONB` parsed or not depending on the
 * driver. Keeping the conversion in pure functions is what lets it be tested
 * without a database, which is the only kind of test this project's unit
 * suite runs.
 */

import type {
  EvidenceRef,
  Merchant,
  MerchantCategory,
  ModelId,
  OutreachAttempt,
  OutreachDraft,
  OutreachState,
} from "../../shared/contracts.js";

// ─── Attempts ──────────────────────────────────────────────────

export interface AttemptRow {
  id: string;
  merchant_id: string;
  campaign_id: string;
  draft_id: string;
  state: string;
  dedup_key: string;
  approved_by: string | null;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
  provider_message_id: string | null;
  failure_reason: string | null;
  attempt_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Every state in the contract, enumerable at runtime.
 *
 * Duplicated from `shared/contracts.ts` on purpose — the contract is a type
 * union, and a type cannot be checked against a string that came out of the
 * database. The exhaustiveness proof below is what keeps the copy honest: a
 * state added to the contract stops this file compiling.
 */
const OUTREACH_STATES = [
  "INGESTED", "TRIAGED", "DRAFTED", "GATED", "BLOCKED",
  "PENDING_APPROVAL", "REJECTED", "APPROVED", "QUEUED", "SENT", "FAILED",
] as const satisfies readonly OutreachState[];

type _AllStatesListed =
  Exclude<OutreachState, (typeof OUTREACH_STATES)[number]> extends never ? true : never;
const _statesAreExhaustive: _AllStatesListed = true;
void _statesAreExhaustive;

export function rowToAttempt(row: AttemptRow): OutreachAttempt {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    campaignId: row.campaign_id,
    draftId: row.draft_id,
    state: toState(row.state, row.id),
    dedupKey: row.dedup_key,
    approvedBy: row.approved_by,
    approvedAt: toIsoOrNull(row.approved_at, "approved_at", row.id),
    sentAt: toIsoOrNull(row.sent_at, "sent_at", row.id),
    providerMessageId: row.provider_message_id,
    failureReason: row.failure_reason,
    attemptCount: row.attempt_count,
    createdAt: toIso(row.created_at, "created_at", row.id),
    updatedAt: toIso(row.updated_at, "updated_at", row.id),
  };
}

function toState(value: string, id: string): OutreachState {
  const state = OUTREACH_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    // `attempts_state_valid` makes this unreachable through normal writes, so
    // reaching it means the schema and the contract have drifted apart. Stop
    // rather than guess which one is right.
    throw new Error(
      `Attempt ${id}: state "${value}" is not in the contract (${OUTREACH_STATES.join(", ")}).`,
    );
  }
  return state;
}

// ─── Drafts and merchants ──────────────────────────────────────

/*
 * A note on ownership, because this is a boundary being crossed.
 *
 * `drafts` belongs to the agents service and `merchants` to ingest. The
 * approval service reads both: it needs the recipient and the message text to
 * build an outbox payload, and it needs the whole merchant record to re-run
 * the gates over an edited draft. The architecture says a service reaches
 * another service's tables through its API, and that is what should happen —
 * but a cross-service call needs `~encore/clients`, which lives in the
 * generated `encore.gen` directory, and CI typechecks a fresh clone where that
 * directory does not exist. Importing it would break `npm run typecheck` for
 * everyone.
 *
 * So this reads the two tables directly, and says so rather than hiding it.
 * It is the one deviation in this workstream that is worth arguing about
 * before the PR is merged.
 */

export interface DraftRow {
  id: string;
  merchant_id: string;
  campaign_id: string;
  locale: string;
  subject: string;
  body: string;
  evidence: unknown;
  model: string;
  created_at: Date | string;
}

export function rowToDraft(row: DraftRow): OutreachDraft {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    campaignId: row.campaign_id,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    evidence: toEvidence(row.evidence, row.id),
    model: row.model as ModelId,
    // Token usage is the agents service's business, not the approval
    // service's. The gates never read it, so it is not fetched; zeroes here
    // would be a number nobody should trust, so the draft this service builds
    // is explicitly the gate-shaped subset.
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
    createdAt: toIso(row.created_at, "created_at", row.id),
  };
}

/**
 * Parse the stored `EvidenceRef[]`.
 *
 * Strict, like `toSignals` in ingest: evidence whose shape is wrong is the
 * ungrounded claim the pipeline exists to catch, so it stops the run instead
 * of being filtered out quietly.
 */
export function toEvidence(raw: unknown, draftId: string): EvidenceRef[] {
  if (raw === null || raw === undefined) return [];

  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) {
    throw new Error(`Draft ${draftId}: stored evidence is not a JSON array.`);
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Draft ${draftId}: evidence ${index} is not an object.`);
    }
    const { claim, sourceField, sourceValue } = entry as Record<string, unknown>;
    if (typeof claim !== "string" || typeof sourceField !== "string" ||
        typeof sourceValue !== "string") {
      throw new Error(
        `Draft ${draftId}: evidence ${index} is missing claim, sourceField or sourceValue.`,
      );
    }
    return { claim, sourceField: sourceField as keyof Merchant, sourceValue };
  });
}

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
}

/** Duplicated from the contract for the same reason as `OUTREACH_STATES`. */
const MERCHANT_CATEGORIES = [
  "restaurant", "spa_wellness", "fitness", "beauty", "activity", "class_workshop",
] as const satisfies readonly MerchantCategory[];

type _AllCategoriesListed =
  Exclude<MerchantCategory, (typeof MERCHANT_CATEGORIES)[number]> extends never ? true : never;
const _categoriesAreExhaustive: _AllCategoriesListed = true;
void _categoriesAreExhaustive;

export function rowToMerchant(row: MerchantRow): Merchant {
  const category = MERCHANT_CATEGORIES.find((candidate) => candidate === row.category);
  if (category === undefined) {
    throw new Error(`Merchant ${row.id}: category "${row.category}" is not in the contract.`);
  }

  return {
    id: row.id,
    name: row.name,
    category,
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

// ─── Column conversions ────────────────────────────────────────

function toNumberOrNull(value: number | string | null, column: string, id: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${id}: column ${column} holds "${value}", which is not a number.`);
  }
  return parsed;
}

export function toIsoOrNull(value: Date | string | null, column: string, id: string): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${id}: column ${column} holds "${String(value)}", not a timestamp.`);
  }
  return date.toISOString();
}

function toIso(value: Date | string, column: string, id: string): string {
  const iso = toIsoOrNull(value, column, id);
  if (iso === null) {
    throw new Error(`${id}: column ${column} is null, but the contract requires a timestamp.`);
  }
  return iso;
}
