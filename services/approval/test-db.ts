/**
 * Seeding for the integration suite.
 *
 * The five tests in `docs/idempotency.md` are about what the database does
 * under concurrency, so they need real rows: a merchant, a draft and an
 * attempt waiting for a human. This builds them.
 *
 * Not a test file — vitest only collects `*.test.ts`, and this must not be
 * collected. It is also not importable by the unit suite: it reaches
 * `shared/db.ts`, which throws on import outside the Encore runtime.
 *
 * The draft text is the gates' own `PASSING_BODY`, reused rather than
 * reinvented. It is the one body in this repository known to pass all
 * thirteen gates, and `editAndApprove` re-runs them — a hand-written fixture
 * would start failing for reasons that have nothing to do with what is being
 * tested.
 */

import { randomUUID } from "node:crypto";

import type { OutreachState } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import {
  PASSING_BODY,
  PASSING_EVIDENCE,
  PASSING_SUBJECT,
  sampleMerchant,
} from "../gates/test-helpers.js";
import { computeDedupKey } from "./dedup.js";

export interface SeededAttempt {
  attemptId: string;
  draftId: string;
  merchantId: string;
  campaignId: string;
  contactEmail: string;
  subject: string;
  body: string;
  dedupKey: string;
}

export interface SeedOptions {
  /** Reuse an existing merchant, for tests about a second attempt at one. */
  merchantId?: string;
  campaignId?: string;
  subject?: string;
  body?: string;
  /** Defaults to `PENDING_APPROVAL`: an attempt waiting for a human. */
  state?: OutreachState;
}

/** A merchant, a draft and an attempt in `PENDING_APPROVAL`. */
export async function seedAttempt(options: SeedOptions = {}): Promise<SeededAttempt> {
  const suffix = randomUUID().slice(0, 8);

  const merchantId = options.merchantId ?? `mch_${suffix}`;
  const campaignId = options.campaignId ?? `cmp_${suffix}`;
  const subject = options.subject ?? PASSING_SUBJECT;
  const body = options.body ?? PASSING_BODY;
  const state = options.state ?? "PENDING_APPROVAL";

  const merchant = sampleMerchant({ id: merchantId });

  await db.exec`
    INSERT INTO merchants (
      id, name, category, city, country_code, locale, website_url, contact_email,
      rating, review_count, years_in_business, has_active_offer, seats_or_capacity
    ) VALUES (
      ${merchant.id}, ${merchant.name}, ${merchant.category}, ${merchant.city},
      ${merchant.countryCode}, ${merchant.locale}, ${merchant.websiteUrl},
      ${merchant.contactEmail}, ${merchant.rating}::numeric, ${merchant.reviewCount},
      ${merchant.yearsInBusiness}, ${merchant.hasActiveOffer}, ${merchant.seatsOrCapacity}
    )
    ON CONFLICT (id) DO NOTHING
  `;

  const draftId = `drf_${randomUUID().slice(0, 8)}`;
  await db.exec`
    INSERT INTO drafts (
      id, merchant_id, campaign_id, locale, subject, body, evidence, model
    ) VALUES (
      ${draftId}, ${merchantId}, ${campaignId}, ${merchant.locale}, ${subject}, ${body},
      (${JSON.stringify(PASSING_EVIDENCE)}::text)::jsonb, 'claude-sonnet-5'
    )
  `;

  const attemptId = `att_${randomUUID().slice(0, 8)}`;
  const dedupKey = computeDedupKey(merchantId, campaignId, subject, body);

  await db.exec`
    INSERT INTO outreach_attempts (
      id, merchant_id, campaign_id, draft_id, state, dedup_key
    ) VALUES (
      ${attemptId}, ${merchantId}, ${campaignId}, ${draftId}, ${state}, ${dedupKey}
    )
  `;

  return {
    attemptId,
    draftId,
    merchantId,
    campaignId,
    contactEmail: merchant.contactEmail,
    subject,
    body,
    dedupKey,
  };
}

// ─── Reading rows back ─────────────────────────────────────────

export interface AttemptSnapshot {
  state: string;
  provider_message_id: string | null;
  sent_at: Date | string | null;
  approved_by: string | null;
  failure_reason: string | null;
  attempt_count: number;
  dedup_key: string;
}

export async function readAttempt(attemptId: string): Promise<AttemptSnapshot> {
  const row = await db.queryRow<AttemptSnapshot>`
    SELECT state, provider_message_id, sent_at, approved_by, failure_reason,
           attempt_count, dedup_key
    FROM outreach_attempts WHERE id = ${attemptId}
  `;

  if (row === null) throw new Error(`No attempt ${attemptId}.`);
  return row;
}

export interface OutboxSnapshot {
  id: string;
  attempt_id: string;
  idempotency_key: string;
  claimed_at: Date | string | null;
  processed_at: Date | string | null;
  attempt_count: number;
  last_error: string | null;
}

export async function readOutboxRows(): Promise<OutboxSnapshot[]> {
  const rows: OutboxSnapshot[] = [];
  for await (const row of db.query<OutboxSnapshot>`
    SELECT id, attempt_id, idempotency_key, claimed_at, processed_at, attempt_count, last_error
    FROM outbox ORDER BY created_at
  `) {
    rows.push(row);
  }
  return rows;
}

export async function countRows(table: "outreach_attempts" | "outbox"): Promise<number> {
  // The table name cannot be interpolated — Encore's tagged template sends
  // every `${}` as a bind parameter, which is the right default and the
  // reason this is a union type rather than a string.
  const row =
    table === "outbox"
      ? await db.queryRow<{ count: number }>`SELECT COUNT(*)::int AS count FROM outbox`
      : await db.queryRow<{ count: number }>`SELECT COUNT(*)::int AS count FROM outreach_attempts`;

  return row?.count ?? 0;
}

/** Push a claim into the past, so the claim timeout is reachable in a test. */
export async function expireClaim(outboxRowId: string, minutesAgo: number): Promise<void> {
  await db.exec`
    UPDATE outbox
       SET claimed_at = NOW() - make_interval(mins => ${minutesAgo})
     WHERE id = ${outboxRowId}
  `;
}
