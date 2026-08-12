/**
 * Agent configuration.
 *
 * Read once from the environment and passed down explicitly, rather than
 * looked up from `process.env` deep inside the agents. That keeps the agents
 * testable without mutating global state, and makes every knob visible in one
 * place.
 */

import type { ModelId } from "../../shared/contracts.js";
import { ConfigError } from "../../shared/errors.js";

export interface AgentsConfig {
  /** Triage runs here first: cheap model, high volume. */
  triageModel: ModelId;
  /** Where a low-confidence triage goes for a second opinion. */
  escalationModel: ModelId;
  /** Drafting runs here. */
  draftModel: ModelId;

  /**
   * Triage confidence below this escalates to the stronger model.
   * The escalation rate is a metric, not an implementation detail: it shows
   * what uncertainty costs.
   */
  triageEscalationThreshold: number;

  /** Hard ceiling on model spend for one campaign, in US dollars. */
  campaignCostCapUsd: number;

  triageMaxTokens: number;
  draftMaxTokens: number;
}

export const DEFAULT_TRIAGE_ESCALATION_THRESHOLD = 0.6;
export const DEFAULT_CAMPAIGN_COST_CAP_USD = 5.0;

const DEFAULTS = {
  triageModel: "claude-haiku-4-5-20251001",
  escalationModel: "claude-sonnet-5",
  draftModel: "claude-sonnet-5",
  triageMaxTokens: 1024,
  draftMaxTokens: 2048,
} as const satisfies Partial<AgentsConfig>;

export function loadAgentsConfig(env: NodeJS.ProcessEnv = process.env): AgentsConfig {
  return {
    ...DEFAULTS,
    triageEscalationThreshold: readNumber(
      env,
      "TRIAGE_ESCALATION_THRESHOLD",
      DEFAULT_TRIAGE_ESCALATION_THRESHOLD,
      { min: 0, max: 1 },
    ),
    campaignCostCapUsd: readNumber(
      env,
      "CAMPAIGN_COST_CAP_USD",
      DEFAULT_CAMPAIGN_COST_CAP_USD,
      { min: 0, exclusiveMin: true },
    ),
  };
}

interface Bounds {
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
}

/**
 * Parse a numeric environment variable, or fail loudly.
 *
 * A typo in a cost cap that silently falls back to a default is the kind of
 * thing that is only noticed on the invoice.
 */
function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: Bounds = {},
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(name, `must be a number, got "${raw}"`);
  }

  const { min, max, exclusiveMin } = bounds;
  if (min !== undefined && (exclusiveMin ? value <= min : value < min)) {
    throw new ConfigError(
      name,
      `must be ${exclusiveMin ? "greater than" : "at least"} ${min}, got ${value}`,
    );
  }
  if (max !== undefined && value > max) {
    throw new ConfigError(name, `must be at most ${max}, got ${value}`);
  }

  return value;
}
