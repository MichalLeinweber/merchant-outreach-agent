/**
 * Synthetic merchant generator.
 *
 * Every merchant in this repository comes from here. Nothing is scraped, and
 * no real business, address or mailbox is used: names are assembled from the
 * word lists below, contact addresses always end in `@example.invalid`, and
 * websites point at the same reserved domain. The database enforces the email
 * rule with a CHECK constraint, so a real address cannot slip in even by
 * mistake.
 *
 * Two properties matter more than realism:
 *
 *   1. Determinism. The same seed produces byte-identical output on every
 *      machine and at any time, which is why the clock is an injected
 *      `referenceDate` rather than `Date.now()`.
 *   2. Guaranteed edge cases. A generator that only samples from a
 *      distribution will, sooner or later, produce a batch without the
 *      awkward cases — exactly the ones the pipeline has to survive. The
 *      cases listed in EDGE_CASES are therefore checked after generation and
 *      forced in when the sampled population does not already cover them.
 *
 * Run as a CLI:
 *
 *   node scripts/generate-merchants.ts --count 200 --seed moa-2026 \
 *        --out fixtures/merchants/seed-200.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Merchant, MerchantCategory } from "../shared/contracts.js";

// ─── Deterministic randomness ──────────────────────────────────

/** FNV-1a, 32-bit. Turns a human-readable seed into a numeric one. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, and good enough for test data. */
function mulberry32(numericSeed: number): () => number {
  let state = numericSeed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Indexed access that fails loudly instead of returning `undefined`.
 *
 * `noUncheckedIndexedAccess` is on, and a silent `undefined` in a generator
 * would show up much later as a broken merchant record.
 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Index ${index} is out of range (length ${items.length}).`);
  }
  return value;
}

/** The single source of randomness. One instance per generation run. */
export class Rng {
  private readonly next01: () => number;

  constructor(seed: string) {
    this.next01 = mulberry32(hashSeed(seed));
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Uniform integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new Error(`Empty range: [${minInclusive}, ${maxInclusive}].`);
    }
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("Cannot pick from an empty list.");
    }
    return at(items, this.int(0, items.length - 1));
  }

  /** Picks by relative weight. Weights need not sum to one. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0) {
      throw new Error("Weighted pick needs at least one positive weight.");
    }
    let threshold = this.next() * total;
    for (const [value, weight] of entries) {
      threshold -= weight;
      if (threshold < 0) {
        return value;
      }
    }
    // Only reachable through floating-point drift on the last entry.
    return at(entries, entries.length - 1)[0];
  }

  /**
   * Triangular distribution. Used for ratings: a marketplace's ratings pile
   * up just above four and thin out towards both ends, which a uniform draw
   * does not reproduce.
   */
  triangular(min: number, mode: number, max: number): number {
    const sample = this.next();
    const split = (mode - min) / (max - min);
    return sample < split
      ? min + Math.sqrt(sample * (max - min) * (mode - min))
      : max - Math.sqrt((1 - sample) * (max - min) * (max - mode));
  }

  /** Fisher–Yates, driven by this generator so shuffles stay reproducible. */
  shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapWith = this.int(0, index);
      const a = at(result, index);
      const b = at(result, swapWith);
      result[index] = b;
      result[swapWith] = a;
    }
    return result;
  }
}

// ─── Word lists ────────────────────────────────────────────────
//
// Names are assembled from these fragments. They are ordinary English and
// European words, deliberately combined into shapes ("The Copper Lantern",
// "Zoë's Crêperie") that read as a plausible small business without being
// taken from any real listing.

const NAME_ADJECTIVES = [
  "Copper", "Velvet", "Gilded", "Amber", "Hidden", "Northern", "Quiet",
  "Crimson", "Salted", "Wandering", "Little", "Old", "Golden", "Silver",
  "Wild", "Blue", "Painted", "Humble", "Bright", "Slow",
] as const;

const NAME_NOUNS: Record<MerchantCategory, readonly string[]> = {
  restaurant: ["Lantern", "Fork", "Table", "Kitchen", "Kettle", "Pantry", "Larder", "Spoon", "Hearth", "Canteen"],
  spa_wellness: ["Springs", "Retreat", "Sanctuary", "Bathhouse", "Steam Rooms", "Grotto", "Wellhouse", "Hollow"],
  fitness: ["Forge", "Barbell Club", "Strength Rooms", "Athletic Club", "Yard", "Engine Room", "Gym Floor"],
  beauty: ["Salon", "Beauty Rooms", "Parlour", "Atelier", "Chair", "Studio"],
  activity: ["Trails", "Adventures", "Climbing Centre", "Paddle Club", "Escape Rooms", "Archery Range", "Karting Track"],
  class_workshop: ["Workshop", "Academy", "Pottery Rooms", "Craft Loft", "Cookery School", "Print Studio"],
};

/** Owner-style first names. The accented ones cover the diacritics case. */
const OWNER_NAMES = [
  "Aoife", "Dara", "Fintan", "Harriet", "Isolde", "Marnie", "Niamh", "Rufus",
  "Tamsin", "Wilfred",
] as const;

/**
 * Owner names that carry a diacritic, so that "Name with a diacritic and an
 * apostrophe" is producible rather than hoped for.
 */
const ACCENTED_OWNER_NAMES = [
  "Zoë", "Björn", "Céline", "Émile", "Kristýna", "Lorcán", "Órla", "Renée",
  "Sørina", "Jarosław",
] as const;

interface CityProfile {
  readonly city: string;
  readonly countryCode: string;
  readonly locale: string;
  /** Relative frequency. The marketplace is UK-first, hence the weights. */
  readonly weight: number;
}

const CITY_PROFILES: readonly CityProfile[] = [
  { city: "London", countryCode: "GB", locale: "en-GB", weight: 22 },
  { city: "Manchester", countryCode: "GB", locale: "en-GB", weight: 10 },
  { city: "Birmingham", countryCode: "GB", locale: "en-GB", weight: 8 },
  { city: "Leeds", countryCode: "GB", locale: "en-GB", weight: 7 },
  { city: "Glasgow", countryCode: "GB", locale: "en-GB", weight: 6 },
  { city: "Bristol", countryCode: "GB", locale: "en-GB", weight: 6 },
  { city: "Edinburgh", countryCode: "GB", locale: "en-GB", weight: 5 },
  { city: "Dublin", countryCode: "IE", locale: "en-IE", weight: 6 },
  { city: "Paris", countryCode: "FR", locale: "fr-FR", weight: 6 },
  { city: "Lyon", countryCode: "FR", locale: "fr-FR", weight: 3 },
  { city: "Berlin", countryCode: "DE", locale: "de-DE", weight: 5 },
  { city: "Munich", countryCode: "DE", locale: "de-DE", weight: 3 },
  { city: "Amsterdam", countryCode: "NL", locale: "nl-NL", weight: 4 },
  { city: "Barcelona", countryCode: "ES", locale: "es-ES", weight: 4 },
  { city: "Kraków", countryCode: "PL", locale: "pl-PL", weight: 3 },
  { city: "Prague", countryCode: "CZ", locale: "cs-CZ", weight: 2 },
];

const DEFAULT_LOCALE = "en-GB";

const NON_DEFAULT_CITY_PROFILES = CITY_PROFILES.filter(
  (profile) => profile.locale !== DEFAULT_LOCALE,
);

/**
 * Category mix. Restaurants dominate a local-experience marketplace; classes
 * and workshops are the long tail.
 */
const CATEGORY_WEIGHTS: readonly (readonly [MerchantCategory, number])[] = [
  ["restaurant", 34],
  ["spa_wellness", 16],
  ["fitness", 15],
  ["beauty", 15],
  ["activity", 12],
  ["class_workshop", 8],
];

/** Plausible size per category, used for `seatsOrCapacity`. */
const CAPACITY_RANGES: Record<MerchantCategory, readonly [number, number]> = {
  restaurant: [24, 180],
  spa_wellness: [8, 60],
  fitness: [20, 220],
  beauty: [3, 18],
  activity: [10, 120],
  class_workshop: [6, 40],
};

// ─── Options ───────────────────────────────────────────────────

export interface GenerateOptions {
  /** Any string. The same seed always produces the same batch. */
  seed: string;
  count: number;
  /**
   * Clock for every generated date. Fixed by default so that a regenerated
   * seed file has no diff other than the intended one.
   */
  referenceDate?: Date;
}

export const DEFAULT_SEED = "moa-2026";
export const DEFAULT_COUNT = 200;
export const DEFAULT_REFERENCE_DATE = new Date("2026-08-01T00:00:00.000Z");

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ───────────────────────────────────────────────────

/** Unicode combining marks, i.e. the accent part of a decomposed letter. */
const COMBINING_MARK = /\p{M}/u;
const COMBINING_MARK_GLOBAL = /\p{M}/gu;

/** Lowercase ASCII slug: "Zoë's Crêperie" → "zoe-s-creperie". */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    // Strip combining marks, so diacritics survive in the name but not the URL.
    .replace(COMBINING_MARK_GLOBAL, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * True when the string carries at least one diacritic.
 *
 * `\p{M}` matches a Unicode combining mark, which is what a decomposed
 * accented letter ends with: "ë" becomes "e" + U+0308 under NFD.
 */
export function hasDiacritics(value: string): boolean {
  return COMBINING_MARK.test(value.normalize("NFD"));
}

export function hasApostrophe(value: string): boolean {
  return /['’]/.test(value);
}

/** Contact addresses are reserved by RFC 6761 and enforced by a CHECK. */
function uniqueEmail(name: string, takenEmails: Set<string>): string {
  const base = slugify(name) || "merchant";
  let candidate = `${base}@example.invalid`;
  let suffix = 2;
  while (takenEmails.has(candidate)) {
    candidate = `${base}-${suffix}@example.invalid`;
    suffix += 1;
  }
  takenEmails.add(candidate);
  return candidate;
}

function websiteFor(email: string): string {
  const localPart = email.split("@")[0] ?? "merchant";
  return `https://www.${localPart}.example.invalid`;
}

function isoDay(date: Date): string {
  const midnight = new Date(date);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight.toISOString();
}

function buildName(rng: Rng, category: MerchantCategory): string {
  const nouns = NAME_NOUNS[category];
  const noun = rng.pick(nouns);

  return rng.weighted<() => string>([
    [() => `The ${rng.pick(NAME_ADJECTIVES)} ${noun}`, 40],
    [() => `${rng.pick(OWNER_NAMES)}'s ${noun}`, 25],
    [() => `${rng.pick(NAME_ADJECTIVES)} ${noun}`, 20],
    [() => `${rng.pick(ACCENTED_OWNER_NAMES)}'s ${noun}`, 15],
  ])();
}

/**
 * Rating and review count are drawn together: they are not independent in
 * real data, and a merchant with no rating has nothing to count either.
 */
function buildReputation(rng: Rng): { rating: number | null; reviewCount: number | null } {
  // Roughly one in twelve merchants has no reputation data at all.
  if (rng.chance(0.08)) {
    return { rating: null, reviewCount: null };
  }

  const rating = Math.round(rng.triangular(3.1, 4.5, 5.0) * 10) / 10;

  // Review counts are heavily skewed: many small merchants, few large ones.
  const magnitude = rng.weighted<readonly [number, number]>([
    [[1, 25], 18],
    [[26, 120], 34],
    [[121, 600], 33],
    [[601, 4000], 15],
  ]);
  const reviewCount = rng.int(magnitude[0], magnitude[1]);

  return { rating, reviewCount };
}

// ─── Generation ────────────────────────────────────────────────

function buildMerchant(
  rng: Rng,
  id: string,
  referenceDate: Date,
  takenEmails: Set<string>,
): Merchant {
  const category = rng.weighted(CATEGORY_WEIGHTS);
  const cityProfile = rng.weighted(
    CITY_PROFILES.map((profile) => [profile, profile.weight] as const),
  );

  const name = buildName(rng, category);
  const contactEmail = uniqueEmail(name, takenEmails);
  const { rating, reviewCount } = buildReputation(rng);

  const hasActiveOffer = rng.chance(0.18);
  // An offer that ended is only meaningful when none is running now.
  const lastOfferEndedAt =
    !hasActiveOffer && rng.chance(0.55)
      ? isoDay(new Date(referenceDate.getTime() - rng.int(15, 900) * DAY_MS))
      : null;

  const capacityRange = CAPACITY_RANGES[category];

  return {
    id,
    name,
    category,
    city: cityProfile.city,
    countryCode: cityProfile.countryCode,
    locale: cityProfile.locale,
    websiteUrl: rng.chance(0.78) ? websiteFor(contactEmail) : null,
    contactEmail,
    rating,
    reviewCount,
    yearsInBusiness: rng.chance(0.05) ? null : rng.int(0, 38),
    hasActiveOffer,
    lastOfferEndedAt,
    seatsOrCapacity: rng.chance(0.1)
      ? null
      : rng.int(capacityRange[0], capacityRange[1]),
  };
}

// ─── Edge cases ────────────────────────────────────────────────

export type EdgeCaseKey =
  | "no_website_no_rating"
  | "high_rating_few_reviews"
  | "non_default_locale"
  | "active_offer"
  | "diacritics_and_apostrophe";

export interface EdgeCase {
  key: EdgeCaseKey;
  /** Why the pipeline needs to meet this one. */
  description: string;
  matches: (merchant: Merchant) => boolean;
  force: (merchant: Merchant, rng: Rng, takenEmails: Set<string>) => Merchant;
}

/** Every case below has to appear at least this many times in a batch. */
export const MIN_PER_EDGE_CASE = 2;

export const EDGE_CASES: readonly EdgeCase[] = [
  {
    key: "no_website_no_rating",
    description: "Almost nothing to personalise from — the draft has to stay honest anyway.",
    matches: (merchant) =>
      merchant.websiteUrl === null && merchant.rating === null && merchant.reviewCount === null,
    force: (merchant) => ({
      ...merchant,
      websiteUrl: null,
      rating: null,
      reviewCount: null,
    }),
  },
  {
    key: "high_rating_few_reviews",
    description: "4.9 from 6 reviews: tempting for a model to round up into an invented claim.",
    matches: (merchant) =>
      merchant.rating !== null &&
      merchant.rating >= 4.8 &&
      merchant.reviewCount !== null &&
      merchant.reviewCount <= 10,
    force: (merchant) => ({ ...merchant, rating: 4.9, reviewCount: 6 }),
  },
  {
    key: "non_default_locale",
    description: `Locale other than ${DEFAULT_LOCALE}, which gate G09 checks the draft against.`,
    matches: (merchant) => merchant.locale !== DEFAULT_LOCALE,
    force: (merchant, rng) => {
      const profile = rng.pick(NON_DEFAULT_CITY_PROFILES);
      return {
        ...merchant,
        city: profile.city,
        countryCode: profile.countryCode,
        locale: profile.locale,
      };
    },
  },
  {
    key: "active_offer",
    description: "Already running an offer, so triage is expected to skip them.",
    matches: (merchant) => merchant.hasActiveOffer,
    force: (merchant) => ({ ...merchant, hasActiveOffer: true, lastOfferEndedAt: null }),
  },
  {
    key: "diacritics_and_apostrophe",
    description: "Name with a diacritic and an apostrophe — gate G04 must match it exactly.",
    matches: (merchant) => hasDiacritics(merchant.name) && hasApostrophe(merchant.name),
    force: (merchant, rng, takenEmails) => {
      const owner = rng.pick(ACCENTED_OWNER_NAMES);
      const name = `${owner}'s ${rng.pick(NAME_NOUNS[merchant.category])}`;
      const contactEmail = uniqueEmail(name, takenEmails);
      return {
        ...merchant,
        name,
        contactEmail,
        // Keep the website consistent with the new name, or absent as before.
        websiteUrl: merchant.websiteUrl === null ? null : websiteFor(contactEmail),
      };
    },
  },
];

/**
 * Force in any edge case the sampled population did not cover.
 *
 * Only merchants that currently match no case at all are eligible to be
 * patched. That keeps the cases from cannibalising each other: forcing "no
 * rating" onto the batch's only 4.9-from-6-reviews merchant would satisfy one
 * requirement by breaking another.
 */
export function ensureEdgeCases(
  merchants: readonly Merchant[],
  rng: Rng,
  takenEmails: Set<string>,
): Merchant[] {
  const result = [...merchants];

  for (const edgeCase of EDGE_CASES) {
    const covered = result.filter((merchant) => edgeCase.matches(merchant)).length;
    const missing = MIN_PER_EDGE_CASE - covered;
    if (missing <= 0) {
      continue;
    }

    const neutralIndices = result
      .map((merchant, index) => ({ merchant, index }))
      .filter(({ merchant }) => !EDGE_CASES.some((other) => other.matches(merchant)))
      .map(({ index }) => index);

    if (neutralIndices.length < missing) {
      throw new Error(
        `Cannot guarantee edge case "${edgeCase.key}": ${missing} more merchant(s) needed but ` +
          `only ${neutralIndices.length} of ${result.length} are free to patch. ` +
          `Generate a larger batch (at least ${EDGE_CASES.length * MIN_PER_EDGE_CASE * 2} merchants).`,
      );
    }

    for (const index of rng.shuffle(neutralIndices).slice(0, missing)) {
      result[index] = edgeCase.force(at(result, index), rng, takenEmails);
    }
  }

  return result;
}

/** Smallest batch in which every edge case can still be guaranteed. */
export const MIN_COUNT = EDGE_CASES.length * MIN_PER_EDGE_CASE * 2;

/**
 * Generate a batch of synthetic merchants.
 *
 * Identical `seed`, `count` and `referenceDate` always give an identical
 * batch, down to the ids.
 */
export function generateMerchants(options: GenerateOptions): Merchant[] {
  const { seed, count } = options;
  const referenceDate = options.referenceDate ?? DEFAULT_REFERENCE_DATE;

  if (!Number.isInteger(count) || count < MIN_COUNT) {
    throw new Error(
      `count must be an integer of at least ${MIN_COUNT} so that every edge case fits; got ${count}.`,
    );
  }

  const rng = new Rng(seed);
  // Ids carry a short digest of the seed, so batches from two different seeds
  // can be loaded side by side without colliding on the primary key.
  const seedTag = hashSeed(seed).toString(36).padStart(6, "0").slice(-6);

  const takenEmails = new Set<string>();
  const merchants: Merchant[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `mrc_${seedTag}_${String(index + 1).padStart(4, "0")}`;
    merchants.push(buildMerchant(rng, id, referenceDate, takenEmails));
  }

  return ensureEdgeCases(merchants, rng, takenEmails);
}

/** How many merchants in the batch cover each edge case. */
export function summariseEdgeCases(merchants: readonly Merchant[]): Record<EdgeCaseKey, number> {
  const summary = {} as Record<EdgeCaseKey, number>;
  for (const edgeCase of EDGE_CASES) {
    summary[edgeCase.key] = merchants.filter((merchant) => edgeCase.matches(merchant)).length;
  }
  return summary;
}

// ─── CLI ───────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_OUTPUT_PATH = path.join(
  REPO_ROOT,
  "fixtures",
  "merchants",
  "seed-200.json",
);

interface CliOptions {
  seed: string;
  count: number;
  outputPath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    seed: DEFAULT_SEED,
    count: DEFAULT_COUNT,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = at(argv, index);
    const value = argv[index + 1];

    switch (flag) {
      case "--seed":
      case "--count":
      case "--out": {
        if (value === undefined) {
          throw new Error(`${flag} needs a value.`);
        }
        index += 1;
        if (flag === "--seed") {
          options.seed = value;
        } else if (flag === "--count") {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isInteger(parsed)) {
            throw new Error(`--count must be an integer; got "${value}".`);
          }
          options.count = parsed;
        } else {
          options.outputPath = path.resolve(value);
        }
        break;
      }
      default:
        throw new Error(
          `Unknown argument "${flag}". Usage: node scripts/generate-merchants.ts ` +
            `[--seed <string>] [--count <n>] [--out <file>]`,
        );
    }
  }

  return options;
}

async function main(argv: readonly string[]): Promise<void> {
  const { seed, count, outputPath } = parseArgs(argv);
  const merchants = generateMerchants({ seed, count });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(merchants, null, 2)}\n`, "utf8");

  const summary = summariseEdgeCases(merchants);
  console.log(`Wrote ${merchants.length} merchants to ${outputPath}`);
  console.log(`Seed: ${seed}`);
  console.log("Edge case coverage:");
  for (const edgeCase of EDGE_CASES) {
    console.log(`  ${edgeCase.key.padEnd(26)} ${summary[edgeCase.key]}`);
  }
}

// Only run when invoked directly, so importing this module in a test is free
// of side effects.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
