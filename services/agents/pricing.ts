import type { ModelId, TokenUsage } from "../../shared/contracts.js";

/**
 * Model pricing, in US dollars per million tokens.
 *
 * Verified against platform.claude.com/docs/en/pricing on 2026-08-12.
 *
 * Claude Sonnet 5 has introductory pricing of $2.00 / $10.00 per million
 * tokens running through 2026-08-31. The standard rate is used here on
 * purpose: a cost figure that is too low the day the promotion ends is worse
 * than one that is slightly conservative today.
 */
export const MODEL_PRICING: Record<
  ModelId,
  { inputPerMTok: number; outputPerMTok: number }
> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

/**
 * Reading from the prompt cache costs a tenth of the normal input rate.
 * Cache *writes* cost 1.25x, but they arrive in the API response as ordinary
 * input tokens, so they need no separate term here.
 */
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Turn a token count into dollars.
 *
 * A pure function on purpose: the cost of a campaign is a sum of these, and
 * a sum is only trustworthy if each term can be tested on its own.
 */
export function costUsd(
  model: ModelId,
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">,
): number {
  const price = MODEL_PRICING[model];

  const dollars =
    (usage.inputTokens * price.inputPerMTok +
      usage.cachedInputTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000;

  // Six decimals matches the NUMERIC(12, 6) columns the usage is stored in.
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
