import { describe, expect, it } from "vitest";

import type { ModelId } from "../../shared/contracts.js";
import { MODEL_PRICING, costUsd } from "./pricing.js";

const MODELS = Object.keys(MODEL_PRICING) as ModelId[];

describe("costUsd", () => {
  it("prices a million input tokens at the published input rate", () => {
    expect(
      costUsd("claude-haiku-4-5-20251001", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
    ).toBe(1.0);
  });

  it("prices a million output tokens at the published output rate", () => {
    expect(
      costUsd("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
      }),
    ).toBe(15.0);
  });

  it("charges cache reads at a tenth of the input rate", () => {
    const fresh = costUsd("claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    const cached = costUsd("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });

    expect(cached).toBeCloseTo(fresh * 0.1, 6);
  });

  it("is zero for a call that consumed nothing", () => {
    for (const model of MODELS) {
      expect(costUsd(model, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })).toBe(0);
    }
  });

  it("adds up: the total equals the sum of its parts", () => {
    const usage = { inputTokens: 12_345, outputTokens: 6_789, cachedInputTokens: 4_321 };
    const parts =
      costUsd("claude-sonnet-5", { ...usage, outputTokens: 0, cachedInputTokens: 0 }) +
      costUsd("claude-sonnet-5", { ...usage, inputTokens: 0, cachedInputTokens: 0 }) +
      costUsd("claude-sonnet-5", { ...usage, inputTokens: 0, outputTokens: 0 });

    expect(costUsd("claude-sonnet-5", usage)).toBeCloseTo(parts, 6);
  });

  it("rounds to the six decimals the database column stores", () => {
    const value = costUsd("claude-haiku-4-5-20251001", {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 1,
    });

    expect(value).toBe(Number(value.toFixed(6)));
  });

  it("orders the models cheapest to most expensive", () => {
    const usage = { inputTokens: 1_000, outputTokens: 1_000, cachedInputTokens: 0 };

    expect(costUsd("claude-haiku-4-5-20251001", usage)).toBeLessThan(
      costUsd("claude-sonnet-5", usage),
    );
    expect(costUsd("claude-sonnet-5", usage)).toBeLessThan(costUsd("claude-opus-5", usage));
  });
});
