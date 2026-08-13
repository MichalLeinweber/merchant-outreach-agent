/**
 * Persisting a draft against a real database.
 *
 * Same defect as in `ingest.integration.test.ts`, in a second place:
 * `drafts.evidence` is `JSONB` with `CHECK (jsonb_typeof(evidence) = 'array')`,
 * and `saveDraft` bound it as a plain stringified value, which the driver
 * stores as a jsonb string. Every draft the agents produced would have been
 * rejected by the constraint.
 *
 * The evidence array is not incidental here — it is how a personalized claim
 * is traced back to the field it came from, so a draft that cannot be stored
 * with it is a draft with nothing to audit.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { OutreachDraft } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import { resetOutreachTables } from "../../shared/test-db.js";
import { PASSING_BODY, PASSING_EVIDENCE, PASSING_SUBJECT, sampleMerchant } from "../gates/test-helpers.js";
import { saveDraft } from "./store.js";

const MERCHANT = sampleMerchant({ id: "mch_draft_001" });

beforeEach(async () => {
  await resetOutreachTables();

  await db.exec`
    INSERT INTO merchants (
      id, name, category, city, country_code, locale, contact_email, rating, review_count
    ) VALUES (
      ${MERCHANT.id}, ${MERCHANT.name}, ${MERCHANT.category}, ${MERCHANT.city},
      ${MERCHANT.countryCode}, ${MERCHANT.locale}, ${MERCHANT.contactEmail},
      ${MERCHANT.rating}::numeric, ${MERCHANT.reviewCount}
    )
  `;
});

function draft(overrides: Partial<OutreachDraft> = {}): OutreachDraft {
  return {
    id: "drf_integration_001",
    merchantId: MERCHANT.id,
    campaignId: "cmp_2026w33_uk",
    locale: "en-GB",
    subject: PASSING_SUBJECT,
    body: PASSING_BODY,
    evidence: PASSING_EVIDENCE,
    model: "claude-sonnet-5",
    usage: { inputTokens: 1200, outputTokens: 150, cachedInputTokens: 0, costUsd: 0.0041 },
    createdAt: "2026-08-12T09:00:00.000Z",
    ...overrides,
  };
}

describe("saveDraft", () => {
  it("stores the evidence as a JSON array", async () => {
    await saveDraft(draft());

    const stored = await db.queryRow<{ kind: string; claim: string }>`
      SELECT jsonb_typeof(evidence) AS kind, evidence->0->>'claim' AS claim
      FROM drafts WHERE id = 'drf_integration_001'
    `;

    expect(stored?.kind).toBe("array");
    expect(stored?.claim).toBe(PASSING_EVIDENCE[0]?.claim);
  });

  it("stores a draft that claims nothing", async () => {
    // A legitimate answer: when the record holds nothing worth quoting, the
    // prompt tells the model to write a plain message. An empty array is
    // still an array, and the constraint still has to accept it.
    await saveDraft(draft({ id: "drf_integration_002", evidence: [] }));

    const stored = await db.queryRow<{ kind: string; count: number }>`
      SELECT jsonb_typeof(evidence) AS kind, jsonb_array_length(evidence) AS count
      FROM drafts WHERE id = 'drf_integration_002'
    `;

    expect(stored?.kind).toBe("array");
    expect(stored?.count).toBe(0);
  });
});
