/**
 * G05 and G06 are the gates the project is built to demonstrate, so they get
 * the boundary cases as well as the obvious ones. Each boundary here is a
 * place where a slightly more relaxed implementation would let a hallucination
 * through, or a slightly stricter one would reject a correct draft.
 */

import { describe, expect, it } from "vitest";

import { g05EvidenceGrounding, g06NoInventedNumbers } from "./index.js";
import {
  bodyWith,
  highlighted,
  PASSING_EVIDENCE,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G05 evidence grounding", () => {
  it("passes when every claim is quoted from the body and matches the record", () => {
    const outcome = g05EvidenceGrounding(sampleDraft(), merchant, context);

    expect(outcome.passed).toBe(true);
    expect(outcome.severity).toBe("blocking");
  });

  it("fails a claim that does not appear in the body", () => {
    const draft = sampleDraft({
      evidence: [
        ...PASSING_EVIDENCE,
        {
          claim: "the most booked coffee house in Leeds",
          sourceField: "city",
          sourceValue: "Leeds",
        },
      ],
    });

    const outcome = g05EvidenceGrounding(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("does not appear in the body");
    expect(outcome.detail).toContain("rejected rather than repaired");
  });

  // ── Boundary cases ───────────────────────────────────────────

  it("boundary: a claim differing only in case is not grounded", () => {
    const draft = sampleDraft({
      evidence: [{ claim: "A 4.8 Rating", sourceField: "rating", sourceValue: "4.8" }],
    });

    const outcome = g05EvidenceGrounding(draft, merchant, context);

    // "a 4.8 rating" is in the body; "A 4.8 Rating" is not. No case folding,
    // because every relaxation is a place a near-miss starts counting as a hit.
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("does not appear in the body");
  });

  it("boundary: a source value that is the same number written differently is grounded", () => {
    const draft = sampleDraft({
      evidence: [{ claim: "a 4.8 rating", sourceField: "rating", sourceValue: "4.80" }],
    });

    // Numbers are compared as numbers. "4.80" and 4.8 are the same value, and
    // failing this would be a formatting complaint dressed up as a hallucination.
    expect(g05EvidenceGrounding(draft, merchant, context).passed).toBe(true);
  });

  it("boundary: a claim cited more often than it appears is not grounded", () => {
    const body = "With 40 covers, a weekday offer fills the quiet sessions first.";
    const draft = sampleDraft({
      body,
      evidence: [
        { claim: "40 covers", sourceField: "seatsOrCapacity", sourceValue: "40" },
        { claim: "40 covers", sourceField: "seatsOrCapacity", sourceValue: "40" },
      ],
    });

    const outcome = g05EvidenceGrounding(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("cited more often");
  });

  it("boundary: the same phrase written twice supports two claims", () => {
    const body =
      "With 40 covers, a weekday offer works. With 40 covers, the quiet sessions fill first.";
    const draft = sampleDraft({
      body,
      evidence: [
        { claim: "40 covers", sourceField: "seatsOrCapacity", sourceValue: "40" },
        { claim: "40 covers", sourceField: "seatsOrCapacity", sourceValue: "40" },
      ],
    });

    expect(g05EvidenceGrounding(draft, merchant, context).passed).toBe(true);
  });

  it("boundary: a claim sourced from a null field is not grounded", () => {
    const draft = sampleDraft({
      evidence: [
        { claim: "a 4.8 rating", sourceField: "lastOfferEndedAt", sourceValue: "2026-03-14" },
      ],
    });

    const outcome = g05EvidenceGrounding(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("null on the record");
  });

  it("fails and highlights a claim whose source value contradicts the record", () => {
    const draft = sampleDraft({
      evidence: [{ claim: "a 4.8 rating", sourceField: "rating", sourceValue: "5.0" }],
    });

    const outcome = g05EvidenceGrounding(draft, merchant, context);

    // The dangerous shape: quoted perfectly from the body, sourced from a value
    // the record does not hold. Only the second half of the gate catches it.
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("the record says 4.8");
    expect(highlighted(draft.body, outcome.spans)).toEqual(["a 4.8 rating"]);
  });

  it("passes a draft that makes no claims at all", () => {
    // The correct output for a record with nothing worth quoting. G13 is where
    // the count is questioned; G05 has nothing to check.
    expect(g05EvidenceGrounding(sampleDraft({ evidence: [] }), merchant, context).passed).toBe(
      true,
    );
  });
});

describe("G06 no invented numbers", () => {
  it("passes when every number in the body is in the record", () => {
    const outcome = g06NoInventedNumbers(sampleDraft(), merchant, context);

    expect(outcome.passed).toBe(true);
  });

  it("fails an invented number and points at it", () => {
    const body = bodyWith([["62 reviews", "1,200 bookings a month"]]);
    const outcome = g06NoInventedNumbers(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toEqual(["1,200"]);
    // The message names what the record does support, so a reviewer can see
    // the gap without opening the record.
    expect(outcome.detail).toContain("4.8");
  });

  // ── Boundary cases ───────────────────────────────────────────

  it("boundary: a decimal comma is the same number as a decimal point", () => {
    const body = bodyWith([["a 4.8 rating", "a 4,8 rating"]]);

    expect(g06NoInventedNumbers(sampleDraft({ body }), merchant, context).passed).toBe(true);
  });

  it("boundary: thousands separators are read, not rejected", () => {
    const busy = sampleMerchant({ reviewCount: 1234 });

    for (const written of ["1,234 reviews", "1.234 reviews", "1 234 reviews"]) {
      const body = bodyWith([["62 reviews", written]]);
      const outcome = g06NoInventedNumbers(sampleDraft({ body }), busy, context);

      expect(outcome.passed, `"${written}" should be grounded`).toBe(true);
    }
  });

  it("boundary: a year derived from yearsInBusiness is not grounded", () => {
    const body = bodyWith([["in Leeds", "in Leeds, where you have traded since 2023"]]);
    const outcome = g06NoInventedNumbers(sampleDraft({ body }), merchant, context);

    // 2026 minus three years is 2023, and a person would accept it. The gate
    // does not: the arithmetic needs today's date, so the same draft would pass
    // this year and fail next. A gate whose verdict moves with the calendar is
    // not a gate.
    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toEqual(["2023"]);
  });

  it("boundary: the parts of a date on the record are grounded", () => {
    const lapsed = sampleMerchant({ lastOfferEndedAt: "2026-03-14" });
    const body = bodyWith([["in Leeds", "in Leeds, and your last offer closed on 14 March 2026"]]);

    expect(g06NoInventedNumbers(sampleDraft({ body }), lapsed, context).passed).toBe(true);
  });

  it("boundary: digits inside the merchant's own name are grounded", () => {
    const numbered = sampleMerchant({ name: "Studio 66" });
    const body = bodyWith([["Lumen Coffee House", "Studio 66"]]);

    expect(g06NoInventedNumbers(sampleDraft({ body }), numbered, context).passed).toBe(true);
  });

  it("catches a number the evidence never mentions", () => {
    // Wider than G05 on purpose: an uncited number is the easiest kind to ship,
    // because nothing in the evidence array draws attention to it.
    const body = bodyWith([["a clean read", "a 30% lift"]]);
    const outcome = g06NoInventedNumbers(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toEqual(["30"]);
  });
});
