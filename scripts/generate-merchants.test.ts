import { describe, expect, it } from "vitest";

import type { Merchant, MerchantCategory } from "../shared/contracts.js";
import { validateMerchant } from "../services/ingest/validation.js";
import {
  DEFAULT_REFERENCE_DATE,
  EDGE_CASES,
  MIN_COUNT,
  MIN_PER_EDGE_CASE,
  Rng,
  generateMerchants,
  hasApostrophe,
  hasDiacritics,
  slugify,
  summariseEdgeCases,
} from "./generate-merchants.js";

const SEED = "test-seed";

function generate(count: number, seed: string = SEED): Merchant[] {
  return generateMerchants({ seed, count });
}

describe("Rng", () => {
  it("produces the same stream for the same seed", () => {
    const first = Array.from({ length: 10 }, () => new Rng("abc").next());
    const second = Array.from({ length: 10 }, () => new Rng("abc").next());
    expect(first).toEqual(second);
  });

  it("produces a different stream for a different seed", () => {
    const a = new Rng("abc");
    const b = new Rng("abd");
    const streamA = Array.from({ length: 10 }, () => a.next());
    const streamB = Array.from({ length: 10 }, () => b.next());
    expect(streamA).not.toEqual(streamB);
  });

  it("stays inside the requested integer range", () => {
    const rng = new Rng("range");
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("keeps every element when shuffling", () => {
    const rng = new Rng("shuffle");
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = rng.shuffle(input);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(input);
  });
});

describe("slugify", () => {
  it("strips diacritics and punctuation", () => {
    expect(slugify("Zoë's Crêperie")).toBe("zoe-s-creperie");
    expect(slugify("Björn's Steam Rooms")).toBe("bjorn-s-steam-rooms");
    expect(slugify("The Copper Lantern")).toBe("the-copper-lantern");
  });
});

describe("hasDiacritics / hasApostrophe", () => {
  it("recognises accented characters", () => {
    expect(hasDiacritics("Zoë")).toBe(true);
    expect(hasDiacritics("Kristýna")).toBe(true);
    expect(hasDiacritics("Harriet")).toBe(false);
  });

  it("recognises both apostrophe shapes", () => {
    expect(hasApostrophe("Zoë's Kitchen")).toBe(true);
    expect(hasApostrophe("Zoë’s Kitchen")).toBe(true);
    expect(hasApostrophe("The Copper Lantern")).toBe(false);
  });
});

describe("generateMerchants — determinism", () => {
  it("returns an identical batch for the same seed", () => {
    expect(generate(60)).toEqual(generate(60));
  });

  it("returns a different batch for a different seed", () => {
    expect(generate(60, "seed-a")).not.toEqual(generate(60, "seed-b"));
  });

  it("does not depend on the wall clock", () => {
    // Every date comes from referenceDate, so passing it explicitly must give
    // exactly what the default gives.
    const explicit = generateMerchants({
      seed: SEED,
      count: 40,
      referenceDate: DEFAULT_REFERENCE_DATE,
    });
    expect(explicit).toEqual(generate(40));
  });

  it("refuses a batch too small to hold every edge case", () => {
    expect(() => generate(MIN_COUNT - 1)).toThrow(/at least/);
  });
});

describe("generateMerchants — shape of the data", () => {
  const merchants = generate(200);

  it("returns the requested number of merchants", () => {
    expect(merchants).toHaveLength(200);
  });

  it("passes the same validation the ingest endpoint applies", () => {
    const problems = merchants.flatMap((merchant) =>
      validateMerchant(merchant).map((problem) => `${merchant.id}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it("gives every merchant a unique id and contact address", () => {
    expect(new Set(merchants.map((m) => m.id)).size).toBe(merchants.length);
    expect(new Set(merchants.map((m) => m.contactEmail)).size).toBe(merchants.length);
  });

  it("never produces a deliverable email address or a real website", () => {
    for (const merchant of merchants) {
      expect(merchant.contactEmail.endsWith("@example.invalid")).toBe(true);
      if (merchant.websiteUrl !== null) {
        expect(merchant.websiteUrl).toMatch(/^https:\/\/www\.[a-z0-9-]+\.example\.invalid$/);
      }
    }
  });

  it("keeps ratings inside 0–5 with one decimal place", () => {
    for (const { rating } of merchants) {
      if (rating === null) {
        continue;
      }
      expect(rating).toBeGreaterThanOrEqual(0);
      expect(rating).toBeLessThanOrEqual(5);
      expect(Math.round(rating * 10)).toBe(rating * 10);
    }
  });

  it("ties review count to the presence of a rating", () => {
    for (const { rating, reviewCount } of merchants) {
      expect(rating === null).toBe(reviewCount === null);
    }
  });

  it("dates every past offer before the reference date", () => {
    for (const { lastOfferEndedAt, hasActiveOffer } of merchants) {
      if (lastOfferEndedAt === null) {
        continue;
      }
      expect(hasActiveOffer).toBe(false);
      expect(new Date(lastOfferEndedAt).getTime()).toBeLessThan(
        DEFAULT_REFERENCE_DATE.getTime(),
      );
    }
  });
});

describe("generateMerchants — distributions", () => {
  const merchants = generate(200);

  it("covers every category", () => {
    const categories = new Set<MerchantCategory>(merchants.map((m) => m.category));
    expect(categories.size).toBe(6);
  });

  it("makes restaurants the largest category", () => {
    const counts = new Map<MerchantCategory, number>();
    for (const { category } of merchants) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const restaurants = counts.get("restaurant") ?? 0;
    for (const [category, count] of counts) {
      if (category !== "restaurant") {
        expect(restaurants).toBeGreaterThan(count);
      }
    }
  });

  it("keeps en-GB dominant without making it the only locale", () => {
    const englishGb = merchants.filter((m) => m.locale === "en-GB").length;
    expect(englishGb / merchants.length).toBeGreaterThan(0.5);
    expect(englishGb).toBeLessThan(merchants.length);
  });

  it("keeps ratings realistic: most merchants above four stars", () => {
    const rated = merchants.filter((m): m is Merchant & { rating: number } => m.rating !== null);
    const aboveFour = rated.filter((m) => m.rating >= 4).length;
    expect(aboveFour / rated.length).toBeGreaterThan(0.5);
  });

  it("produces a long tail of review counts rather than one bucket", () => {
    const counts = merchants
      .map((m) => m.reviewCount)
      .filter((count): count is number => count !== null);
    expect(Math.min(...counts)).toBeLessThan(30);
    expect(Math.max(...counts)).toBeGreaterThan(500);
  });
});

describe("generateMerchants — guaranteed edge cases", () => {
  // Small batches are where a sampled population is most likely to miss a
  // case, so the guarantee is checked across sizes rather than only at 200.
  for (const count of [MIN_COUNT, 25, 60, 200]) {
    it(`covers every edge case at least ${MIN_PER_EDGE_CASE}× in a batch of ${count}`, () => {
      const summary = summariseEdgeCases(generate(count));
      for (const edgeCase of EDGE_CASES) {
        expect(
          summary[edgeCase.key],
          `${edgeCase.key} appears ${summary[edgeCase.key]}× in a batch of ${count}`,
        ).toBeGreaterThanOrEqual(MIN_PER_EDGE_CASE);
      }
    });
  }

  it("covers every edge case under several different seeds", () => {
    for (const seed of ["alpha", "beta", "gamma", "delta"]) {
      const summary = summariseEdgeCases(generate(30, seed));
      for (const edgeCase of EDGE_CASES) {
        expect(summary[edgeCase.key], `${edgeCase.key} with seed ${seed}`).toBeGreaterThanOrEqual(
          MIN_PER_EDGE_CASE,
        );
      }
    }
  });

  it("leaves forced merchants valid and internally consistent", () => {
    const merchants = generate(MIN_COUNT);

    const noMaterial = merchants.filter(
      (m) => m.websiteUrl === null && m.rating === null && m.reviewCount === null,
    );
    expect(noMaterial.length).toBeGreaterThanOrEqual(MIN_PER_EDGE_CASE);

    const highRating = merchants.filter(
      (m) => m.rating !== null && m.rating >= 4.8 && m.reviewCount !== null && m.reviewCount <= 10,
    );
    expect(highRating.length).toBeGreaterThanOrEqual(MIN_PER_EDGE_CASE);
    // The forced pair is exactly the case from the spec: 4.9 from 6 reviews.
    expect(highRating.some((m) => m.rating === 4.9 && m.reviewCount === 6)).toBe(true);

    for (const merchant of merchants.filter((m) => m.hasActiveOffer)) {
      expect(merchant.lastOfferEndedAt).toBeNull();
    }

    const accented = merchants.filter(
      (m) => hasDiacritics(m.name) && hasApostrophe(m.name),
    );
    expect(accented.length).toBeGreaterThanOrEqual(MIN_PER_EDGE_CASE);
    for (const merchant of accented) {
      // The address is derived from the name, so it must have followed the
      // forced rename — and must still be ASCII.
      expect(merchant.contactEmail).toMatch(/^[a-z0-9-]+@example\.invalid$/);
      expect(merchant.contactEmail.startsWith(slugify(merchant.name))).toBe(true);
    }

    expect(validateBatchProblems(merchants)).toEqual([]);
  });
});

/** Every validation problem across a batch, flattened for readable failures. */
function validateBatchProblems(merchants: readonly Merchant[]): string[] {
  return merchants.flatMap((merchant) =>
    validateMerchant(merchant).map((problem) => `${merchant.id}: ${problem}`),
  );
}
