/**
 * Record LLM fixtures.
 *
 *     ANTHROPIC_API_KEY=... LLM_MODE=record npm run record-fixtures
 *
 * Runs triage and draft against real models for a small set of merchants and
 * writes each response to `fixtures/llm/<hash>.json`. Once recorded, the whole
 * pipeline replays offline: a fresh clone with no API key runs end to end.
 *
 * Re-run this after editing a prompt. The fixture key is a hash of the prompt,
 * so an edited prompt has no fixture and the next fixture-mode run fails
 * loudly rather than replaying a stale answer.
 */

import { loadAgentsConfig } from "../services/agents/config.js";
import { UNLIMITED_COST_GUARD } from "../services/agents/cost.js";
import { runDraft } from "../services/agents/draft.js";
import { LlmClient, loadConfigFromEnv } from "../services/agents/llm.js";
import { loadPrompt } from "../services/agents/prompts.js";
import { runTriage } from "../services/agents/triage.js";
import type { EnrichedMerchant } from "../shared/contracts.js";
import type { AgentDeps } from "../services/agents/runner.js";

/**
 * Merchants to record against.
 *
 * A deliberately small, hand-written set covering the shapes that behave
 * differently: a strong candidate, one already running an offer, and one with
 * most fields missing. WS1 adds a generator; this stays as the minimum set
 * worth recording, because a fixture run should stay cheap enough to repeat.
 */
const SAMPLE_MERCHANTS: EnrichedMerchant[] = [
  {
    id: "sample-strong-candidate",
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
      { key: "high_rating_low_volume", value: "Rated 4.8 from only 62 reviews", sourceField: "rating" },
      { key: "deal_gap", value: "Has never run an offer", sourceField: "hasActiveOffer" },
    ],
  },
  {
    id: "sample-already-running-offer",
    name: "Vltava Wellness Studio",
    category: "spa_wellness",
    city: "Brno",
    countryCode: "CZ",
    locale: "cs-CZ",
    websiteUrl: null,
    contactEmail: "studio@example.invalid",
    rating: 4.2,
    reviewCount: 890,
    yearsInBusiness: 11,
    hasActiveOffer: true,
    lastOfferEndedAt: null,
    seatsOrCapacity: 12,
    signals: [
      { key: "capacity_headroom", value: "12 treatment slots per day", sourceField: "seatsOrCapacity" },
    ],
  },
  {
    id: "sample-sparse-data",
    name: "Ateliér Kruh",
    category: "class_workshop",
    city: "Ostrava",
    countryCode: "CZ",
    locale: "cs-CZ",
    websiteUrl: null,
    contactEmail: "kruh@example.invalid",
    rating: null,
    reviewCount: null,
    yearsInBusiness: null,
    hasActiveOffer: false,
    lastOfferEndedAt: null,
    seatsOrCapacity: null,
    signals: [{ key: "new_to_market", value: "No trading history on record", sourceField: "yearsInBusiness" }],
  },
];

const CAMPAIGN_ID = "fixture-recording";

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const llmConfig = loadConfigFromEnv();

  if (llmConfig.mode !== "record") {
    fail(
      `LLM_MODE is "${llmConfig.mode}"; this script only runs in record mode.\n` +
        `  ANTHROPIC_API_KEY=... LLM_MODE=record npm run record-fixtures`,
    );
  }

  await assertPromptsAreWritten(force);

  const deps: AgentDeps = {
    llm: new LlmClient(llmConfig),
    config: loadAgentsConfig(),
    // Recording is not a campaign, so there is no ceiling to enforce and
    // nothing to write to llm_calls.
    costGuard: UNLIMITED_COST_GUARD,
  };

  console.log(`Recording into ${llmConfig.fixtureDir}`);
  console.log(`${SAMPLE_MERCHANTS.length} merchant(s)\n`);

  let totalCostUsd = 0;
  let failures = 0;

  for (const merchant of SAMPLE_MERCHANTS) {
    console.log(`— ${merchant.name} (${merchant.id})`);

    try {
      const triage = await runTriage(merchant, CAMPAIGN_ID, deps);
      totalCostUsd += triage.result.usage.costUsd;
      console.log(
        `  triage: score ${triage.result.score}, confidence ${triage.result.confidence}` +
          `${triage.result.escalated ? ", escalated" : ""} ` +
          `($${triage.result.usage.costUsd.toFixed(6)}, ${triage.calls.length} call(s))`,
      );

      const draft = await runDraft(merchant, CAMPAIGN_ID, deps);
      totalCostUsd += draft.draft.usage.costUsd;
      console.log(
        `  draft:  ${draft.draft.evidence.length} evidence claim(s) ` +
          `($${draft.draft.usage.costUsd.toFixed(6)})`,
      );
    } catch (error) {
      failures += 1;
      // The response is written to disk before it is parsed, so a fixture for
      // a rejected response still exists — which is exactly what the tests
      // covering bad model output need.
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\nTotal recorded cost: $${totalCostUsd.toFixed(6)}`);

  if (failures > 0) {
    fail(`${failures} merchant(s) failed. Fixtures for their raw responses were still written.`);
  }
}

/**
 * Refuse to spend money recording answers to unwritten prompts.
 *
 * The prompt files ship as skeletons full of TODO markers. Recording against
 * those produces fixtures that look real, replay deterministically, and mean
 * nothing.
 */
async function assertPromptsAreWritten(force: boolean): Promise<void> {
  const unwritten: string[] = [];

  for (const name of ["triage", "draft"] as const) {
    const { system, user } = await loadPrompt(name);
    if (system.includes("TODO:") || user.includes("TODO:")) unwritten.push(name);
  }

  if (unwritten.length === 0) return;

  if (force) {
    console.warn(
      `Warning: ${unwritten.join(" and ")} prompt(s) still contain TODO markers. ` +
        `Recording anyway because --force was passed.\n`,
    );
    return;
  }

  fail(
    `${unwritten.join(" and ")} prompt(s) still contain TODO markers.\n` +
      `Write them in services/agents/prompts/ before recording — fixtures recorded\n` +
      `against a skeleton prompt replay deterministically and mean nothing.\n` +
      `Pass --force if you really want to record anyway.`,
  );
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

await main();
