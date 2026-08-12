/**
 * Shared test setup.
 *
 * The tests run the agents in `fixture` mode against fixtures they write
 * themselves, rather than against a stubbed SDK. That means each test
 * exercises the real prompt files, the real request construction and the real
 * fixture-key hashing — so a change to any of them shows up as a missing
 * fixture instead of passing silently.
 *
 * Not a test file itself: no assertions, and vitest only collects `*.test.ts`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { EnrichedMerchant, TokenUsage } from "../../shared/contracts.js";
import { loadAgentsConfig, type AgentsConfig } from "./config.js";
import { computeFixtureKey, type LlmFixture, type LlmRequest } from "./llm.js";

export async function makeFixtureDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "outreach-agent-fixtures-"));
}

export const DEFAULT_TEST_USAGE: Pick<
  TokenUsage,
  "inputTokens" | "outputTokens" | "cachedInputTokens"
> = {
  inputTokens: 1_200,
  outputTokens: 150,
  cachedInputTokens: 0,
};

/**
 * Write the fixture that `request` will look for, containing `payload`.
 *
 * The key is computed from the request the agent actually builds, so if the
 * prompt files or the request shape change, these fixtures follow along
 * instead of going stale.
 */
export async function seedFixture(
  fixtureDir: string,
  request: LlmRequest,
  payload: unknown,
  usage = DEFAULT_TEST_USAGE,
): Promise<string> {
  const fixtureKey = computeFixtureKey(request);

  const fixture: LlmFixture = {
    fixtureKey,
    model: request.model,
    recordedAt: "2026-08-12T00:00:00.000Z",
    request: {
      system: request.system,
      userPrompt: request.userPrompt,
      maxTokens: request.maxTokens,
    },
    response: { text: JSON.stringify(payload), usage },
  };

  await writeFile(
    path.join(fixtureDir, `${fixtureKey}.json`),
    `${JSON.stringify(fixture, null, 2)}\n`,
    "utf8",
  );

  return fixtureKey;
}

/** Config with the documented defaults, independent of the ambient environment. */
export function testConfig(overrides: Partial<AgentsConfig> = {}): AgentsConfig {
  return { ...loadAgentsConfig({}), ...overrides };
}

export function sampleMerchant(
  overrides: Partial<EnrichedMerchant> = {},
): EnrichedMerchant {
  return {
    id: "merchant-001",
    name: "Lumen Coffee House",
    category: "restaurant",
    city: "Prague",
    countryCode: "CZ",
    locale: "cs-CZ",
    websiteUrl: "https://lumen.example.invalid",
    contactEmail: "hello@example.invalid",
    rating: 4.8,
    reviewCount: 62,
    yearsInBusiness: 3,
    hasActiveOffer: false,
    lastOfferEndedAt: null,
    seatsOrCapacity: 40,
    signals: [
      {
        key: "high_rating_low_volume",
        value: "Rated 4.8 from only 62 reviews",
        sourceField: "rating",
      },
    ],
    ...overrides,
  };
}
