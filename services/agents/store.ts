/**
 * Persistence for the tables this service owns: `llm_calls`,
 * `triage_results` and `drafts`.
 *
 * Kept apart from the agents themselves so the agents stay unit-testable
 * without a database, and so every write to these tables is visible in one
 * file.
 */

import { randomUUID } from "node:crypto";

import type { OutreachDraft, TriageResult } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import type { LlmCallRecord } from "./runner.js";

/**
 * Record one model call.
 *
 * Every call lands here, including fixture replays. Keeping replayed calls in
 * the same table as live ones is deliberate: it is what makes a fixture run
 * comparable to a real one instead of a separate universe with no numbers.
 */
export async function recordLlmCall(record: LlmCallRecord): Promise<void> {
  const { campaignId, purpose, meta } = record;

  await db.exec`
    INSERT INTO llm_calls (
      id, campaign_id, purpose, model, mode, fixture_key, latency_ms,
      input_tokens, output_tokens, cached_input_tokens, cost_usd
    ) VALUES (
      ${randomUUID()}, ${campaignId}, ${purpose}, ${meta.model}, ${meta.mode},
      ${meta.fixtureKey}, ${meta.latencyMs},
      ${meta.usage.inputTokens}, ${meta.usage.outputTokens},
      ${meta.usage.cachedInputTokens}, ${meta.usage.costUsd}
    )
  `;
}

/**
 * What a campaign has spent so far, in US dollars.
 *
 * A sum over the recorded calls, not a running counter held in memory: a
 * counter would reset when the process restarts, and the cap would quietly
 * stop meaning anything.
 */
export async function campaignSpendUsd(campaignId: string): Promise<number> {
  const row = await db.queryRow<{ total: string | number | null }>`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM llm_calls
    WHERE campaign_id = ${campaignId}
  `;

  // Postgres NUMERIC arrives as a string, because a float would lose cents.
  return Number(row?.total ?? 0);
}

export async function saveTriageResult(
  campaignId: string,
  result: TriageResult,
): Promise<void> {
  // Re-running triage for a merchant replaces the earlier verdict rather than
  // failing, so a resumed campaign does not need special handling.
  await db.exec`
    INSERT INTO triage_results (
      merchant_id, campaign_id, score, confidence, reason, recommended_action,
      model, escalated, input_tokens, output_tokens, cached_input_tokens, cost_usd
    ) VALUES (
      ${result.merchantId}, ${campaignId}, ${result.score}, ${result.confidence},
      ${result.reason}, ${result.recommendedAction}, ${result.model}, ${result.escalated},
      ${result.usage.inputTokens}, ${result.usage.outputTokens},
      ${result.usage.cachedInputTokens}, ${result.usage.costUsd}
    )
    ON CONFLICT (merchant_id, campaign_id) DO UPDATE SET
      score               = EXCLUDED.score,
      confidence          = EXCLUDED.confidence,
      reason              = EXCLUDED.reason,
      recommended_action  = EXCLUDED.recommended_action,
      model               = EXCLUDED.model,
      escalated           = EXCLUDED.escalated,
      input_tokens        = EXCLUDED.input_tokens,
      output_tokens       = EXCLUDED.output_tokens,
      cached_input_tokens = EXCLUDED.cached_input_tokens,
      cost_usd            = EXCLUDED.cost_usd
  `;
}

export async function saveDraft(draft: OutreachDraft): Promise<void> {
  await db.exec`
    INSERT INTO drafts (
      id, merchant_id, campaign_id, locale, subject, body, evidence, model,
      input_tokens, output_tokens, cached_input_tokens, cost_usd, created_at
    ) VALUES (
      ${draft.id}, ${draft.merchantId}, ${draft.campaignId}, ${draft.locale},
      ${draft.subject}, ${draft.body}, ${JSON.stringify(draft.evidence)}, ${draft.model},
      ${draft.usage.inputTokens}, ${draft.usage.outputTokens},
      ${draft.usage.cachedInputTokens}, ${draft.usage.costUsd}, ${draft.createdAt}
    )
  `;
}
