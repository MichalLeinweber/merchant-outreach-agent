/**
 * Draft agent.
 *
 * Writes the outreach message and, alongside it, the evidence for every
 * personalized claim it made. The evidence is checked against the body the
 * moment the response is parsed: a claim that does not appear verbatim means
 * the draft is thrown away, not patched up.
 */

import { randomUUID } from "node:crypto";

import type {
  EnrichedMerchant,
  LlmCallMeta,
  OutreachDraft,
} from "../../shared/contracts.js";
import type { AgentsConfig } from "./config.js";
import { assertEvidenceGrounded } from "./grounding.js";
import type { LlmRequest } from "./llm.js";
import { loadPrompt, renderPrompt } from "./prompts.js";
import { invokeModel, type AgentDeps } from "./runner.js";
import { DRAFT_SCHEMA, parseDraftPayload } from "./schemas.js";

export interface DraftOutcome {
  draft: OutreachDraft;
  calls: LlmCallMeta[];
}

export interface DraftDeps extends AgentDeps {
  /** Injectable so tests get stable ids. */
  newId?: (() => string) | undefined;
  /** Injectable so tests get a stable `createdAt`. */
  now?: (() => Date) | undefined;
}

/**
 * Build the exact request the draft agent sends.
 *
 * Exported for the same reason as its triage counterpart: the fixture key is
 * derived from the request, so tests and the recorder must construct it here
 * rather than reproduce it.
 */
export async function buildDraftRequest(
  merchant: EnrichedMerchant,
  campaignId: string,
  config: AgentsConfig,
): Promise<LlmRequest> {
  const template = await loadPrompt("draft");

  return {
    model: config.draftModel,
    system: renderPrompt("draft", template.system, {}),
    userPrompt: renderPrompt("draft", template.user, {
      merchant: JSON.stringify(merchant, null, 2),
      locale: merchant.locale,
      campaignId,
    }),
    maxTokens: config.draftMaxTokens,
    jsonSchema: DRAFT_SCHEMA,
  };
}

export async function runDraft(
  merchant: EnrichedMerchant,
  campaignId: string,
  deps: DraftDeps,
): Promise<DraftOutcome> {
  const result = await invokeModel(
    await buildDraftRequest(merchant, campaignId, deps.config),
    campaignId,
    "draft",
    deps,
  );

  const payload = parseDraftPayload(result.meta.model, result.text);

  // Before the draft becomes an object anyone can act on.
  assertEvidenceGrounded(merchant.id, payload.body, payload.evidence);

  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  return {
    draft: {
      id: newId(),
      merchantId: merchant.id,
      campaignId,
      locale: merchant.locale,
      subject: payload.subject,
      body: payload.body,
      evidence: payload.evidence,
      model: result.meta.model,
      usage: result.meta.usage,
      createdAt: now().toISOString(),
    },
    calls: [result.meta],
  };
}
