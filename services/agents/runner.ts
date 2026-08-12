/**
 * The one path every model call in this service takes.
 *
 * Check the cost cap, call, record what it cost. Keeping this in one place is
 * what makes the campaign total trustworthy: a call that skipped the recording
 * step would be spend that no report ever shows.
 */

import type { LlmCallMeta } from "../../shared/contracts.js";
import type { AgentsConfig } from "./config.js";
import type { CostGuard } from "./cost.js";
import type { LlmClient, LlmRequest, LlmResult } from "./llm.js";

/** Which step of the pipeline a call belongs to. Stored on `llm_calls`. */
export type LlmCallPurpose = "triage" | "triage_escalation" | "draft";

export interface LlmCallRecord {
  campaignId: string;
  purpose: LlmCallPurpose;
  meta: LlmCallMeta;
}

export interface AgentDeps {
  llm: LlmClient;
  config: AgentsConfig;
  /** Consulted before every call. Use `UNLIMITED_COST_GUARD` outside a campaign. */
  costGuard: CostGuard;
  /**
   * Persists one call. Optional so the agents can be unit-tested without a
   * database; the campaign runner always supplies it.
   */
  recordCall?: ((record: LlmCallRecord) => Promise<void>) | undefined;
}

/**
 * Guard, call, record — in that order.
 *
 * The guard runs first so the ceiling holds before money is spent, and the
 * recording runs before the caller sees the result so a caller that throws on
 * a bad response still leaves the cost on the books. A call that happened is
 * a call that gets paid for, whether or not its output was usable.
 */
export async function invokeModel(
  request: LlmRequest,
  campaignId: string,
  purpose: LlmCallPurpose,
  deps: AgentDeps,
): Promise<LlmResult> {
  await deps.costGuard.assertCanSpend();

  const result = await deps.llm.call(request);

  await deps.recordCall?.({ campaignId, purpose, meta: result.meta });

  return result;
}
