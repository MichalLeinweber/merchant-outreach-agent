/**
 * Fixtures for the gate tests.
 *
 * The centrepiece is `PASSING_BODY`: a draft that passes all thirteen gates.
 * Every negative test starts from it and breaks exactly one thing, so a
 * failing assertion names the defect that was introduced rather than some
 * unrelated property of a hand-written body. It is worth keeping that way —
 * the moment two tests need two different "good" drafts, the gates have
 * started disagreeing with each other.
 *
 * Not a test file: no assertions, and vitest only collects `*.test.ts`.
 */

import type {
  EvidenceRef,
  Merchant,
  OutreachDraft,
} from "../../shared/contracts.js";
import { makeGateContext, type GateContext } from "./types.js";

/** Fixed instant. Nothing in the gates may depend on the real clock. */
export const NOW = "2026-08-12T09:00:00.000Z";

export function sampleMerchant(overrides: Partial<Merchant> = {}): Merchant {
  return {
    id: "merchant-001",
    name: "Lumen Coffee House",
    category: "restaurant",
    city: "Leeds",
    countryCode: "GB",
    locale: "en-GB",
    websiteUrl: "https://lumen.example.invalid",
    contactEmail: "hello@example.invalid",
    rating: 4.8,
    reviewCount: 62,
    yearsInBusiness: 3,
    hasActiveOffer: false,
    lastOfferEndedAt: null,
    seatsOrCapacity: 40,
    ...overrides,
  };
}

export const PASSING_SUBJECT = "Filling weekday tables at Lumen Coffee House";

export const PASSING_BODY = [
  "Hi there,",
  "",
  "Lumen Coffee House holds a 4.8 rating from 62 reviews, which is a strong " +
    "signal from a small but genuine audience in Leeds. With 40 covers, a " +
    "weekday offer is usually the easiest way to fill the quiet sessions " +
    "without touching your weekend pricing. Partners of that size tend to " +
    "clear their slowest afternoons first, which keeps the rate intact on the " +
    "sessions that already sell out and gives you a clean read on how much of " +
    "the demand is new rather than moved from another day. If that shape of " +
    "offer is useful, you can register your interest using the link below and " +
    "someone from the team will follow up with the detail.",
  "",
  "Best regards,",
  "The partnerships team",
].join("\n");

/** The three claims `PASSING_BODY` makes, each quoted from it verbatim. */
export const PASSING_EVIDENCE: EvidenceRef[] = [
  { claim: "a 4.8 rating", sourceField: "rating", sourceValue: "4.8" },
  { claim: "62 reviews", sourceField: "reviewCount", sourceValue: "62" },
  { claim: "40 covers", sourceField: "seatsOrCapacity", sourceValue: "40" },
];

export function sampleDraft(overrides: Partial<OutreachDraft> = {}): OutreachDraft {
  return {
    id: "draft-001",
    merchantId: "merchant-001",
    campaignId: "cmp_2026w33_uk",
    locale: "en-GB",
    subject: PASSING_SUBJECT,
    body: PASSING_BODY,
    evidence: PASSING_EVIDENCE,
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 1_200,
      outputTokens: 150,
      cachedInputTokens: 0,
      costUsd: 0.0041,
    },
    createdAt: NOW,
    ...overrides,
  };
}

export function sampleContext(overrides: Partial<Omit<GateContext, "now">> = {}): GateContext {
  return makeGateContext(NOW, overrides);
}

/** The text a set of spans covers — what a UI would highlight. */
export function highlighted(body: string, spans: { start: number; end: number }[] = []): string[] {
  return spans.map((span) => body.slice(span.start, span.end));
}

/** A body with one substring swapped, keeping everything else passing. */
export function bodyWith(replacements: [find: string, replace: string][]): string {
  return replacements.reduce(
    (body, [find, replace]) => body.replace(find, replace),
    PASSING_BODY,
  );
}
