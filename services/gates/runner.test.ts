import { describe, expect, it } from "vitest";

import {
  blockingFailures,
  GATE_ORDER,
  GATE_SEVERITY,
  runGates,
  toContractReport,
  warningFailures,
} from "./index.js";
import { bodyWith, NOW, sampleContext, sampleDraft, sampleMerchant } from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("runGates", () => {
  it("runs every gate, in order, and passes a clean draft", () => {
    const report = runGates(sampleDraft(), merchant, context);

    expect(report.outcomes.map((outcome) => outcome.gate)).toEqual([...GATE_ORDER]);
    expect(report.blocked).toBe(false);

    const failed = report.outcomes.filter((outcome) => !outcome.passed);
    expect(failed, `unexpected failures: ${JSON.stringify(failed, null, 2)}`).toEqual([]);
  });

  it("reports the draft id and the evaluation instant from the context", () => {
    const report = runGates(sampleDraft(), merchant, context);

    expect(report.draftId).toBe("draft-001");
    // Not `Date.now()`: the report says when the gates were told they ran.
    expect(report.evaluatedAt).toBe(NOW);
  });

  it("blocks when a blocking gate fails", () => {
    const body = bodyWith([["62 reviews", "1,200 bookings a month"]]);
    const report = runGates(sampleDraft({ body }), merchant, context);

    expect(report.blocked).toBe(true);
    expect(blockingFailures(report)).toContain("G06_no_invented_numbers");
  });

  it("does not block when only a warning gate fails", () => {
    // No evidence: G13 warns, G05 has nothing to check, everything else holds.
    const report = runGates(sampleDraft({ evidence: [] }), merchant, context);

    expect(warningFailures(report)).toEqual(["G13_claim_count"]);
    expect(report.blocked).toBe(false);
  });

  it("keeps running after a failure, so the report is complete", () => {
    // A reviewer looking at a blocked draft wants everything wrong with it,
    // and the evals need a verdict from every gate on every draft.
    const draft = sampleDraft({ body: "Too short.", subject: "x".repeat(80), evidence: [] });
    const report = runGates(draft, merchant, context);

    expect(report.outcomes).toHaveLength(GATE_ORDER.length);
    expect(report.blocked).toBe(true);
  });

  it("measures its own duration from an injectable clock", () => {
    let tick = 100;
    const report = runGates(sampleDraft(), merchant, context, {
      monotonicNowMs: () => {
        tick += 7;
        return tick;
      },
    });

    expect(report.durationMs).toBe(7);
  });

  it("carries the severity of each gate onto its outcome", () => {
    const report = runGates(sampleDraft(), merchant, context);

    for (const outcome of report.outcomes) {
      expect(outcome.severity).toBe(GATE_SEVERITY[outcome.gate]);
    }
  });
});

describe("toContractReport", () => {
  it("drops the gate that is not in the frozen contract", () => {
    const report = runGates(sampleDraft({ evidence: [] }), merchant, context);
    const contract = toContractReport(report);

    expect(report.outcomes).toHaveLength(13);
    expect(contract.outcomes).toHaveLength(12);
    expect(contract.outcomes.map((outcome) => outcome.gate)).not.toContain("G13_claim_count");
  });

  it("keeps `blocked` unchanged, because G13 can never have set it", () => {
    const body = bodyWith([["62 reviews", "1,200 bookings a month"]]);
    const report = runGates(sampleDraft({ body }), merchant, context);

    expect(toContractReport(report).blocked).toBe(report.blocked);
    expect(toContractReport(report).draftId).toBe(report.draftId);
  });
});
