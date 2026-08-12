import { describe, expect, it } from "vitest";

import { g13ClaimCount, REQUIRED_CLAIM_COUNT } from "./index.js";
import { PASSING_EVIDENCE, sampleContext, sampleDraft, sampleMerchant } from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G13 claim count", () => {
  it("passes a draft making exactly the three claims the prompt asks for", () => {
    const outcome = g13ClaimCount(sampleDraft(), merchant, context);

    expect(REQUIRED_CLAIM_COUNT).toBe(3);
    expect(outcome.passed).toBe(true);
    expect(outcome.gate).toBe("G13_claim_count");
  });

  it("warns rather than blocks when a draft makes no claims", () => {
    const outcome = g13ClaimCount(sampleDraft({ evidence: [] }), merchant, context);

    expect(outcome.passed).toBe(false);
    // The severity is the whole point of this gate. An empty evidence array is
    // the correct output for a record with nothing to quote, so the count is
    // reported and the send continues.
    expect(outcome.severity).toBe("warning");
    expect(outcome.detail).toContain("correct output when the record");
  });

  it("warns when a draft makes too few claims, and shows which it made", () => {
    const evidence = PASSING_EVIDENCE.slice(0, 2);
    const outcome = g13ClaimCount(sampleDraft({ evidence }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("2 personalized claim(s), fewer than");
    expect(outcome.spans).toHaveLength(2);
  });

  it("warns when a draft makes more claims than it was asked for", () => {
    const evidence = [
      ...PASSING_EVIDENCE,
      { claim: "in Leeds", sourceField: "city" as const, sourceValue: "Leeds" },
    ];
    const outcome = g13ClaimCount(sampleDraft({ evidence }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("another chance to be wrong");
  });
});
