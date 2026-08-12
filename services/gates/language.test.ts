import { describe, expect, it } from "vitest";

import { g09Locale } from "./index.js";
import {
  bodyWith,
  highlighted,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G09 locale", () => {
  it("passes a British English draft for a British English merchant", () => {
    expect(g09Locale(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails when the draft is labelled for a different market", () => {
    const outcome = g09Locale(sampleDraft({ locale: "en-IE" }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("written for the wrong market");
  });

  it("fails an English body written for a German merchant", () => {
    // The labels agree, so only reading the prose catches this — and it is the
    // failure that actually reaches a merchant.
    const german = sampleMerchant({ locale: "de-DE", city: "Berlin", countryCode: "DE" });
    const draft = sampleDraft({ locale: "de-DE", body: bodyWith([["in Leeds", "in Berlin"]]) });

    const outcome = g09Locale(draft, german, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("does not read as de");
  });

  it("fails US spelling in an en-GB draft and points at the word", () => {
    const body = bodyWith([["follow up with the detail", "get the offer authorized"]]);
    const outcome = g09Locale(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toEqual(["authorized"]);
  });

  it("does not mistake ordinary words ending in -ize for US spelling", () => {
    // "size" and "downsizing" end the same way as "organize" and are not the
    // same thing. `seatsOrCapacity` means venue size comes up constantly.
    const body = bodyWith([["Partners of that size", "Partners of that size, without downsizing,"]]);

    expect(g09Locale(sampleDraft({ body }), merchant, context).passed).toBe(true);
  });
});
