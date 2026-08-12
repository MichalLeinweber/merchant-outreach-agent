import { describe, expect, it } from "vitest";

import { g07BannedClaims, g10SingleCta, g12Compliance } from "./index.js";
import {
  bodyWith,
  highlighted,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G07 banned claims", () => {
  it("passes a draft that describes reach rather than outcomes", () => {
    expect(g07BannedClaims(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails a performance guarantee and points at it", () => {
    const body = bodyWith([
      ["a weekday offer is usually", "this is guaranteed to double your bookings and is usually"],
    ]);
    const outcome = g07BannedClaims(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toContain("guaranteed");
  });

  it("does not read a sign-off as a superlative", () => {
    // "Best regards" ends most of these emails. A gate that fails every polite
    // draft is a gate somebody switches off.
    expect(sampleDraft().body).toContain("Best regards");
    expect(g07BannedClaims(sampleDraft(), merchant, context).passed).toBe(true);
  });
});

describe("G10 single call to action", () => {
  it("passes a draft that asks for exactly one thing", () => {
    const outcome = g10SingleCta(sampleDraft(), merchant, context);

    expect(outcome.passed).toBe(true);
    // A warning, not a blocker: a second ask is a quality defect, not a lie.
    expect(outcome.severity).toBe("warning");
  });

  it("fails a draft that asks for two different things", () => {
    const body = bodyWith([
      [
        "you can register your interest using the link below",
        "reply to this email or book a call using the link below",
      ],
    ]);
    const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("2 different calls to action");
  });

  it("fails a draft that asks for nothing", () => {
    const body = bodyWith([
      [
        "If that shape of offer is useful, you can register your interest using the link below and someone from the team will follow up with the detail.",
        "That is the shape most partners of this size settle on in the end.",
      ],
    ]);
    const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("asks the reader to do nothing");
  });
});

describe("G12 compliance", () => {
  it("passes a draft written as professional correspondence", () => {
    expect(g12Compliance(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails urgency and scarcity language", () => {
    const body = bodyWith([["a weekday offer", "act now, only 3 slots left, and a weekday offer"]]);
    const outcome = g12Compliance(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toContain("act now");
  });

  it("fails a body that shouts", () => {
    const body = bodyWith([["a strong signal", "a REALLY STRONG BUYING signal!!"]]);
    const outcome = g12Compliance(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("capitals");
  });
});
