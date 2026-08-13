import { describe, expect, it } from "vitest";

import { computeDedupKey, contentHash } from "./dedup.js";

const MERCHANT = "mch_0001";
const CAMPAIGN = "cmp_2026w33_uk";
const SUBJECT = "Filling weekday tables at Lumen Coffee House";
const BODY = "Your 4.8 rating from 62 reviews is a strong signal.";

describe("the dedup key", () => {
  it("is stable for the same message", () => {
    // The property everything else rests on: the same approval, retried, must
    // produce the same key, or nothing downstream can recognise a repeat.
    expect(computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY)).toBe(
      computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY),
    );
  });

  it("is a sha256 digest", () => {
    expect(computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the body changes", () => {
    // An edited draft must not be deduplicated against the message it
    // replaced: the provider would return the old messageId and the edit
    // would silently never go out.
    expect(computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, `${BODY} One more sentence.`)).not.toBe(
      computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY),
    );
  });

  it("changes when the subject changes", () => {
    expect(computeDedupKey(MERCHANT, CAMPAIGN, "A different subject", BODY)).not.toBe(
      computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY),
    );
  });

  it("separates merchants and campaigns", () => {
    const key = computeDedupKey(MERCHANT, CAMPAIGN, SUBJECT, BODY);

    // The same text to a different merchant is a different message, and the
    // same text in a later campaign is a legitimate second approach.
    expect(computeDedupKey("mch_0002", CAMPAIGN, SUBJECT, BODY)).not.toBe(key);
    expect(computeDedupKey(MERCHANT, "cmp_2026w40_uk", SUBJECT, BODY)).not.toBe(key);
  });

  it("hashes the content independently of the ids", () => {
    // contentHash is the inner digest; the same text in two campaigns shares
    // it, which is what makes the outer key readable as "who, where, what".
    expect(contentHash(SUBJECT, BODY)).toBe(contentHash(SUBJECT, BODY));
    expect(contentHash(SUBJECT, BODY)).not.toBe(contentHash(SUBJECT, `${BODY} `));
  });
});
