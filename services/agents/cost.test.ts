import { describe, expect, it } from "vitest";

import type { LlmCallMeta } from "../../shared/contracts.js";
import { ConfigError } from "../../shared/errors.js";
import { CostCapExceededError } from "../../shared/errors.js";
import {
  DEFAULT_CAMPAIGN_COST_CAP_USD,
  DEFAULT_TRIAGE_ESCALATION_THRESHOLD,
  loadAgentsConfig,
} from "./config.js";
import { createCostGuard, sumUsage, UNLIMITED_COST_GUARD } from "./cost.js";

const CAMPAIGN = "campaign-001";

function call(costUsd: number, tokens = 100): LlmCallMeta {
  return {
    model: "claude-sonnet-5",
    mode: "fixture",
    fixtureKey: "x".repeat(64),
    latencyMs: 0,
    usage: {
      inputTokens: tokens,
      outputTokens: tokens,
      cachedInputTokens: tokens,
      costUsd,
    },
  };
}

describe("createCostGuard", () => {
  it("allows a call while the campaign is under its ceiling", async () => {
    const guard = createCostGuard(CAMPAIGN, 5.0, async () => 4.999999);
    await expect(guard.assertCanSpend()).resolves.toBeUndefined();
  });

  it("blocks once spend reaches the ceiling exactly", async () => {
    const guard = createCostGuard(CAMPAIGN, 5.0, async () => 5.0);
    await expect(guard.assertCanSpend()).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it("blocks when spend has passed the ceiling", async () => {
    const guard = createCostGuard(CAMPAIGN, 5.0, async () => 7.5);
    await expect(guard.assertCanSpend()).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it("re-reads spend on every check rather than caching it", async () => {
    let spent = 1.0;
    const guard = createCostGuard(CAMPAIGN, 5.0, async () => spent);

    await guard.assertCanSpend();
    spent = 5.5;

    await expect(guard.assertCanSpend()).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it("never blocks when unlimited", async () => {
    await expect(UNLIMITED_COST_GUARD.assertCanSpend()).resolves.toBeUndefined();
  });
});

describe("sumUsage", () => {
  it("is zero for no calls", () => {
    expect(sumUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    });
  });

  it("adds tokens and cost across calls", () => {
    expect(sumUsage([call(0.001, 100), call(0.002, 50)])).toEqual({
      inputTokens: 150,
      outputTokens: 150,
      cachedInputTokens: 150,
      costUsd: 0.003,
    });
  });

  it("rounds to the six decimals the cost column stores", () => {
    const total = sumUsage([call(0.0000005), call(0.0000005)]);
    expect(total.costUsd).toBe(Number(total.costUsd.toFixed(6)));
  });
});

describe("loadAgentsConfig", () => {
  it("uses the documented defaults when the environment is empty", () => {
    const config = loadAgentsConfig({});

    expect(config.triageEscalationThreshold).toBe(DEFAULT_TRIAGE_ESCALATION_THRESHOLD);
    expect(config.campaignCostCapUsd).toBe(DEFAULT_CAMPAIGN_COST_CAP_USD);
    expect(config.triageModel).toBe("claude-haiku-4-5-20251001");
    expect(config.escalationModel).toBe("claude-sonnet-5");
  });

  it("reads overrides from the environment", () => {
    const config = loadAgentsConfig({
      TRIAGE_ESCALATION_THRESHOLD: "0.85",
      CAMPAIGN_COST_CAP_USD: "12.5",
    });

    expect(config.triageEscalationThreshold).toBe(0.85);
    expect(config.campaignCostCapUsd).toBe(12.5);
  });

  it.each([
    ["TRIAGE_ESCALATION_THRESHOLD", "not-a-number"],
    ["TRIAGE_ESCALATION_THRESHOLD", "1.5"],
    ["TRIAGE_ESCALATION_THRESHOLD", "-0.1"],
    ["CAMPAIGN_COST_CAP_USD", "0"],
    ["CAMPAIGN_COST_CAP_USD", "-3"],
  ])("rejects %s=%s instead of falling back to the default", (name, value) => {
    // A mistyped cost cap that silently reverts to a default is the kind of
    // thing only noticed on the invoice.
    expect(() => loadAgentsConfig({ [name]: value })).toThrow(ConfigError);
  });
});
