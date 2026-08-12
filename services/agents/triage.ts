/**
 * Triage agent.
 *
 * Scores a merchant on the cheap model. When the model is not sure of its own
 * score, the same question goes to a stronger one and the case is marked
 * `escalated`. Cheap model for volume, expensive model for the hard cases —
 * and the escalation rate becomes a number you can look at, which is the
 * point of doing it this way rather than putting everything on one model.
 */

import type {
  EnrichedMerchant,
  LlmCallMeta,
  ModelId,
  TriageResult,
} from "../../shared/contracts.js";
import type { AgentsConfig } from "./config.js";
import { sumUsage } from "./cost.js";
import type { LlmRequest } from "./llm.js";
import { loadPrompt, renderPrompt } from "./prompts.js";
import { invokeModel, type AgentDeps } from "./runner.js";
import { TRIAGE_SCHEMA, parseTriagePayload, type TriagePayload } from "./schemas.js";

export interface TriageOutcome {
  result: TriageResult;
  /** Every call this triage made, in order. Two when it escalated, one otherwise. */
  calls: LlmCallMeta[];
}

/**
 * Build the exact request the triage agent sends.
 *
 * Exported because the fixture key is derived from it: tests and the fixture
 * recorder both need to produce the identical request, and duplicating this
 * construction is how fixtures silently stop matching.
 */
export async function buildTriageRequest(
  merchant: EnrichedMerchant,
  config: AgentsConfig,
  model: ModelId,
): Promise<LlmRequest> {
  const template = await loadPrompt("triage");

  return {
    model,
    system: renderPrompt("triage", template.system, {}),
    userPrompt: renderPrompt("triage", template.user, {
      merchant: JSON.stringify(merchant, null, 2),
    }),
    maxTokens: config.triageMaxTokens,
    jsonSchema: TRIAGE_SCHEMA,
  };
}

export async function runTriage(
  merchant: EnrichedMerchant,
  campaignId: string,
  deps: AgentDeps,
): Promise<TriageOutcome> {
  const calls: LlmCallMeta[] = [];

  // First pass: the cheap model.
  const first = await invokeModel(
    await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
    campaignId,
    "triage",
    deps,
  );
  calls.push(first.meta);

  let payload: TriagePayload = parseTriagePayload(first.meta.model, first.text);
  let model = first.meta.model;
  let escalated = false;

  // Second pass, only when the model doubts itself.
  if (payload.confidence < deps.config.triageEscalationThreshold) {
    const second = await invokeModel(
      await buildTriageRequest(merchant, deps.config, deps.config.escalationModel),
      campaignId,
      "triage_escalation",
      deps,
    );
    calls.push(second.meta);

    payload = parseTriagePayload(second.meta.model, second.text);
    model = second.meta.model;
    escalated = true;
  }

  return {
    result: {
      merchantId: merchant.id,
      score: payload.score,
      confidence: payload.confidence,
      reason: payload.reason,
      recommendedAction: payload.recommendedAction,
      // The model that produced the answer being reported...
      model,
      escalated,
      // ...but the cost of reaching it, which includes the discarded first
      // attempt. Reporting only the second call would make escalation look
      // free, and the whole reason to track it is that it is not.
      usage: sumUsage(calls),
    },
    calls,
  };
}
