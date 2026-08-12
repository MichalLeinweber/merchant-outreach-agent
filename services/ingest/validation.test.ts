import { describe, expect, it } from "vitest";

import type { Merchant } from "../../shared/contracts.js";
import {
  MAX_BATCH_SIZE,
  MERCHANT_CATEGORIES,
  MERCHANT_FIELDS,
  describeProblems,
  validateBatch,
  validateMerchant,
} from "./validation.js";

const VALID: Merchant = {
  id: "mrc_abc123_0001",
  name: "Zoë's Steam Rooms",
  category: "spa_wellness",
  city: "Kraków",
  countryCode: "PL",
  locale: "pl-PL",
  websiteUrl: "https://www.zoe-s-steam-rooms.example.invalid",
  contactEmail: "zoe-s-steam-rooms@example.invalid",
  rating: 4.9,
  reviewCount: 6,
  yearsInBusiness: 1,
  hasActiveOffer: false,
  lastOfferEndedAt: "2025-11-03T00:00:00.000Z",
  seatsOrCapacity: 30,
};

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return { ...VALID, ...overrides };
}

describe("MERCHANT_FIELDS", () => {
  it("lists every field of the frozen Merchant contract", () => {
    // Derived from the type, so this fails the moment the two drift apart.
    expect([...MERCHANT_FIELDS].sort()).toEqual([...Object.keys(VALID)].sort());
  });
});

describe("validateMerchant", () => {
  it("accepts a well-formed merchant, edge cases included", () => {
    expect(validateMerchant(VALID)).toEqual([]);
  });

  it("accepts a merchant with nothing to personalise from", () => {
    expect(
      validateMerchant(
        merchant({
          websiteUrl: null,
          rating: null,
          reviewCount: null,
          yearsInBusiness: null,
          seatsOrCapacity: null,
          lastOfferEndedAt: null,
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a real, deliverable email address", () => {
    const problems = validateMerchant(merchant({ contactEmail: "hello@a-real-shop.co.uk" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/@example\.invalid/);
  });

  it("rejects an empty id or name", () => {
    expect(validateMerchant(merchant({ id: "" }))).toContain("id must be a non-empty string");
    expect(validateMerchant(merchant({ name: "   " }))).toContain(
      "name must be a non-empty string",
    );
  });

  it("rejects a name with surrounding whitespace, which gate G04 would trip on", () => {
    const problems = validateMerchant(merchant({ name: " The Copper Lantern " }));
    expect(problems.join(" ")).toMatch(/leading or trailing whitespace/);
  });

  it("rejects a category outside the contract", () => {
    const problems = validateMerchant(merchant({ category: "hotel" as Merchant["category"] }));
    expect(problems.join(" ")).toContain(MERCHANT_CATEGORIES.join(", "));
  });

  it("rejects a malformed country code or locale", () => {
    expect(validateMerchant(merchant({ countryCode: "pol" })).join(" ")).toMatch(/alpha-2/);
    expect(validateMerchant(merchant({ locale: "polish" })).join(" ")).toMatch(/BCP 47/);
  });

  it("rejects a website that is not an http(s) URL", () => {
    expect(validateMerchant(merchant({ websiteUrl: "www.example.invalid" })).join(" ")).toMatch(
      /http\(s\) URL/,
    );
    expect(
      validateMerchant(merchant({ websiteUrl: "ftp://files.example.invalid" })).join(" "),
    ).toMatch(/http\(s\) URL/);
  });

  it("rejects out-of-range or non-integer numbers", () => {
    expect(validateMerchant(merchant({ rating: 5.4 })).join(" ")).toMatch(/outside 0–5/);
    expect(validateMerchant(merchant({ reviewCount: -1 })).join(" ")).toMatch(/non-negative/);
    expect(validateMerchant(merchant({ yearsInBusiness: 2.5 })).join(" ")).toMatch(/non-negative/);
    expect(validateMerchant(merchant({ seatsOrCapacity: 0 })).join(" ")).toMatch(/positive/);
  });

  it("rejects a timestamp it cannot parse", () => {
    expect(validateMerchant(merchant({ lastOfferEndedAt: "last Tuesday" })).join(" ")).toMatch(
      /ISO-8601/,
    );
  });

  it("reports every problem at once rather than only the first", () => {
    const problems = validateMerchant(
      merchant({ id: "", contactEmail: "real@example.com", rating: 9 }),
    );
    expect(problems).toHaveLength(3);
  });
});

describe("validateBatch", () => {
  it("accepts a clean batch", () => {
    expect(validateBatch([merchant({ id: "a" }), merchant({ id: "b" })])).toEqual([]);
  });

  it("rejects an empty batch", () => {
    expect(validateBatch([])).toEqual([
      { index: -1, merchantId: "", problem: "the batch is empty" },
    ]);
  });

  it("rejects a batch above the size limit", () => {
    const oversized = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_unused, index) =>
      merchant({ id: `mrc_${index}` }),
    );
    const problems = validateBatch(oversized);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/more than the limit/);
  });

  it("reports duplicate ids with the position of the first occurrence", () => {
    const problems = validateBatch([
      merchant({ id: "same" }),
      merchant({ id: "other" }),
      merchant({ id: "same" }),
    ]);
    expect(problems).toEqual([
      { index: 2, merchantId: "same", problem: "duplicate id, already present at index 0 of this batch" },
    ]);
  });

  it("keeps the index of every broken merchant", () => {
    const problems = validateBatch([
      merchant({ id: "ok" }),
      merchant({ id: "bad", rating: 7 }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.index).toBe(1);
    expect(problems[0]?.merchantId).toBe("bad");
  });
});

describe("describeProblems", () => {
  it("renders batch-level and record-level problems differently", () => {
    expect(
      describeProblems([
        { index: -1, merchantId: "", problem: "the batch is empty" },
        { index: 3, merchantId: "mrc_x", problem: "rating 9 is outside 0–5" },
      ]),
    ).toBe("the batch is empty; [3] mrc_x: rating 9 is outside 0–5");
  });
});
