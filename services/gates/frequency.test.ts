import { describe, expect, it } from "vitest";

import { g11FrequencyCap } from "./index.js";
import { sampleContext, sampleDraft, sampleMerchant } from "./test-helpers.js";

const merchant = sampleMerchant();
const draft = sampleDraft();

/** `NOW` is 2026-08-12T09:00:00Z; these are measured back from it. */
const THIRTY_DAYS_EARLIER = "2026-07-13T09:00:00.000Z";
const NINE_DAYS_EARLIER = "2026-08-03T09:00:00.000Z";

describe("G11 frequency cap", () => {
  it("passes when the merchant has never been approached", () => {
    expect(g11FrequencyCap(draft, merchant, sampleContext()).passed).toBe(true);
  });

  it("fails when the last approach is inside the cap", () => {
    const context = sampleContext({
      previousApproach: { campaignId: "cmp_2026w31_uk", sentAt: NINE_DAYS_EARLIER },
    });

    const outcome = g11FrequencyCap(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("9 day(s) ago");
    expect(outcome.detail).toContain("cmp_2026w31_uk");
    // Nothing in the body is wrong; the timing is. The interface should be able
    // to tell those apart, so there is nothing to highlight.
    expect(outcome.spans).toBeUndefined();
  });

  it("passes on the exact day the cap expires", () => {
    // The boundary is inclusive: thirty days after a send, the next one is due.
    // Testable only because the instant is an argument rather than the clock.
    const context = sampleContext({
      previousApproach: { campaignId: "cmp_2026w28_uk", sentAt: THIRTY_DAYS_EARLIER },
    });

    expect(g11FrequencyCap(draft, merchant, context).passed).toBe(true);
  });

  it("fails loudly when the previous send is not a parseable instant", () => {
    const context = sampleContext({
      previousApproach: { campaignId: "cmp_2026w31_uk", sentAt: "last Tuesday" },
    });

    const outcome = g11FrequencyCap(draft, merchant, context);

    // Treating a broken cap as "no previous approach" is how a merchant gets
    // mailed twice in a week.
    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("cannot be evaluated");
  });
});
