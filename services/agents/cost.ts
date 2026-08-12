/**
 * Campaign cost accounting.
 *
 * Cost is a summed quantity, never an estimate: every model call writes its
 * token usage to `llm_calls`, and the campaign total is the sum of that
 * column. The cap is checked *before* each call, so the ceiling is a ceiling
 * rather than something noticed after the fact.
 *
 * When the cap is reached the run stops with a typed error. It never
 * continues on a cheaper model, never skips the remaining merchants quietly,
 * and never truncates the work. Unfinished cases keep whatever state they
 * already had.
 */

import type { LlmCallMeta, TokenUsage } from "../../shared/contracts.js";
import { CostCapExceededError } from "../../shared/errors.js";

/** Reads how much a campaign has spent so far. Injectable, so it can be tested without a database. */
export type SpendReader = (campaignId: string) => Promise<number>;

export interface CostGuard {
  /** Throws `CostCapExceededError` if the campaign has reached its ceiling. */
  assertCanSpend(): Promise<void>;
}

export function createCostGuard(
  campaignId: string,
  capUsd: number,
  getSpentUsd: SpendReader,
): CostGuard {
  return {
    async assertCanSpend(): Promise<void> {
      const spentUsd = await getSpentUsd(campaignId);
      if (spentUsd >= capUsd) {
        throw new CostCapExceededError(campaignId, spentUsd, capUsd);
      }
    },
  };
}

/** A guard that never blocks. For one-off scripts that are not campaign-bound. */
export const UNLIMITED_COST_GUARD: CostGuard = {
  assertCanSpend: async () => {},
};

/**
 * Add up the usage of several calls.
 *
 * Used where one logical step took more than one call — an escalated triage
 * costs the cheap attempt *and* the expensive one, and reporting only the
 * second would make escalation look free.
 */
export function sumUsage(calls: readonly LlmCallMeta[]): TokenUsage {
  const total = calls.reduce<TokenUsage>(
    (acc, call) => ({
      inputTokens: acc.inputTokens + call.usage.inputTokens,
      outputTokens: acc.outputTokens + call.usage.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + call.usage.cachedInputTokens,
      costUsd: acc.costUsd + call.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
  );

  // Match the six decimals of the NUMERIC(12, 6) column this ends up in.
  return { ...total, costUsd: Math.round(total.costUsd * 1_000_000) / 1_000_000 };
}
