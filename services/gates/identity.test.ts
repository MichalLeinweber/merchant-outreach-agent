import { describe, expect, it } from "vitest";

import { g04MerchantName, g08Pii } from "./index.js";
import {
  bodyWith,
  highlighted,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G04 merchant name", () => {
  it("passes when the body spells the name as the record does", () => {
    expect(g04MerchantName(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails when the body only gets the capitalisation wrong", () => {
    const body = bodyWith([["Lumen Coffee House", "Lumen coffee house"]]);
    const outcome = g04MerchantName(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("must match the record exactly");
    expect(highlighted(body, outcome.spans)).toEqual(["Lumen coffee house"]);
  });

  it("points at a truncated name rather than reporting it as absent", () => {
    const body = bodyWith([["Lumen Coffee House", "Lumen Coffee"]]);
    const outcome = g04MerchantName(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("only part of");
    expect(highlighted(body, outcome.spans)).toEqual(["Lumen Coffee"]);
  });

  it("fails with no spans when the merchant is never named", () => {
    const body = bodyWith([["Lumen Coffee House holds", "The venue holds"]]);
    const outcome = g04MerchantName(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("never names the merchant");
    expect(outcome.spans).toBeUndefined();
  });
});

describe("G08 personal data", () => {
  it("passes a body that carries no contact details of its own", () => {
    expect(g08Pii(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails an invented phone number", () => {
    const body = bodyWith([
      ["someone from the team will follow up", "call me on +44 20 7946 0958"],
    ]);
    const outcome = g08Pii(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("phone number");
    expect(highlighted(body, outcome.spans)).toEqual(["+44 20 7946 0958"]);
  });

  it("fails an email address that is not the one on the record", () => {
    const body = bodyWith([["the link below", "owner@othershop.example.invalid"]]);
    const outcome = g08Pii(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("email address");
  });

  it("allows the merchant's own website and the campaign's host", () => {
    const body = bodyWith([
      [
        "the link below",
        "https://partners.example.invalid/register and https://lumen.example.invalid",
      ],
    ]);

    expect(g08Pii(sampleDraft({ body }), merchant, context).passed).toBe(true);
  });
});
