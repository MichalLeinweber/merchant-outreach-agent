import { describe, expect, it } from "vitest";

import { CostCapExceededError, MissingFixtureError } from "../../shared/errors.js";
import { createCostGuard, UNLIMITED_COST_GUARD } from "./cost.js";
import { LlmClient } from "./llm.js";
import { costUsd } from "./pricing.js";
import type { AgentDeps, LlmCallRecord } from "./runner.js";
import {
  DEFAULT_TEST_USAGE,
  makeFixtureDir,
  sampleMerchant,
  seedFixture,
  testConfig,
} from "./test-helpers.js";
import { buildTriageRequest, runTriage } from "./triage.js";

const CAMPAIGN = "campaign-001";

const CONFIDENT = {
  score: 82,
  confidence: 0.91,
  reason: "Highly rated with few reviews and no offer history.",
  recommendedAction: "pursue" as const,
};

const UNSURE = { ...CONFIDENT, confidence: 0.31, score: 55 };

const SECOND_OPINION = {
  score: 74,
  confidence: 0.88,
  reason: "Strong fit once the thin review count is discounted.",
  recommendedAction: "pursue" as const,
};

/** Collects what would have been written to `llm_calls`. */
function recordingDeps(fixtureDir: string, overrides: Partial<AgentDeps> = {}) {
  const recorded: LlmCallRecord[] = [];
  const deps: AgentDeps = {
    llm: new LlmClient({ mode: "fixture", fixtureDir }),
    config: testConfig(),
    costGuard: UNLIMITED_COST_GUARD,
    recordCall: async (record) => {
      recorded.push(record);
    },
    ...overrides,
  };
  return { deps, recorded };
}

describe("runTriage — happy path", () => {
  it("returns the cheap model's verdict without escalating", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = recordingDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      CONFIDENT,
    );

    const { result, calls } = await runTriage(merchant, CAMPAIGN, deps);

    expect(result.merchantId).toBe(merchant.id);
    expect(result.score).toBe(CONFIDENT.score);
    expect(result.confidence).toBe(CONFIDENT.confidence);
    expect(result.recommendedAction).toBe("pursue");
    expect(result.escalated).toBe(false);
    expect(result.model).toBe(deps.config.triageModel);
    expect(calls).toHaveLength(1);
  });

  it("records exactly one call, tagged as triage", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps, recorded } = recordingDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      CONFIDENT,
    );

    await runTriage(merchant, CAMPAIGN, deps);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ campaignId: CAMPAIGN, purpose: "triage" });
  });

  it("reports the cost of the one call it made", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = recordingDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      CONFIDENT,
    );

    const { result } = await runTriage(merchant, CAMPAIGN, deps);

    expect(result.usage.costUsd).toBe(
      costUsd(deps.config.triageModel, DEFAULT_TEST_USAGE),
    );
  });

  it("fails loudly when the fixture is missing rather than calling out", async () => {
    const fixtureDir = await makeFixtureDir();
    const { deps } = recordingDeps(fixtureDir);

    await expect(runTriage(sampleMerchant(), CAMPAIGN, deps)).rejects.toBeInstanceOf(
      MissingFixtureError,
    );
  });
});

describe("runTriage — escalation", () => {
  /** Seeds both passes: unsure on the cheap model, confident on the strong one. */
  async function seedEscalation(fixtureDir: string, deps: AgentDeps) {
    const merchant = sampleMerchant();
    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      UNSURE,
    );
    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.escalationModel),
      SECOND_OPINION,
    );
    return merchant;
  }

  it("re-asks the stronger model when confidence is below the threshold", async () => {
    const fixtureDir = await makeFixtureDir();
    const { deps } = recordingDeps(fixtureDir);
    const merchant = await seedEscalation(fixtureDir, deps);

    const { result, calls } = await runTriage(merchant, CAMPAIGN, deps);

    expect(UNSURE.confidence).toBeLessThan(deps.config.triageEscalationThreshold);
    expect(result.escalated).toBe(true);
    expect(result.model).toBe(deps.config.escalationModel);
    expect(result.score).toBe(SECOND_OPINION.score);
    expect(result.reason).toBe(SECOND_OPINION.reason);
    expect(calls).toHaveLength(2);
  });

  it("records both calls, distinguishing the escalation", async () => {
    const fixtureDir = await makeFixtureDir();
    const { deps, recorded } = recordingDeps(fixtureDir);
    const merchant = await seedEscalation(fixtureDir, deps);

    await runTriage(merchant, CAMPAIGN, deps);

    expect(recorded.map((r) => r.purpose)).toEqual(["triage", "triage_escalation"]);
    expect(recorded.map((r) => r.meta.model)).toEqual([
      deps.config.triageModel,
      deps.config.escalationModel,
    ]);
  });

  it("charges for the discarded cheap attempt as well as the escalation", async () => {
    const fixtureDir = await makeFixtureDir();
    const { deps } = recordingDeps(fixtureDir);
    const merchant = await seedEscalation(fixtureDir, deps);

    const { result } = await runTriage(merchant, CAMPAIGN, deps);

    const expected =
      costUsd(deps.config.triageModel, DEFAULT_TEST_USAGE) +
      costUsd(deps.config.escalationModel, DEFAULT_TEST_USAGE);

    // Escalation is not free, and reporting only the second call would say it was.
    expect(result.usage.costUsd).toBeCloseTo(expected, 6);
    expect(result.usage.inputTokens).toBe(DEFAULT_TEST_USAGE.inputTokens * 2);
    expect(result.usage.outputTokens).toBe(DEFAULT_TEST_USAGE.outputTokens * 2);
  });

  it("does not escalate when confidence sits exactly on the threshold", async () => {
    const fixtureDir = await makeFixtureDir();
    const { deps } = recordingDeps(fixtureDir);
    const merchant = sampleMerchant();

    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      { ...CONFIDENT, confidence: deps.config.triageEscalationThreshold },
    );

    const { result } = await runTriage(merchant, CAMPAIGN, deps);

    expect(result.escalated).toBe(false);
  });
});

describe("runTriage — cost cap", () => {
  it("stops before the call when the campaign is already at its ceiling", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps, recorded } = recordingDeps(fixtureDir, {
      costGuard: createCostGuard(CAMPAIGN, 5.0, async () => 5.0),
    });

    // The fixture exists, so nothing but the cap can stop this run.
    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      CONFIDENT,
    );

    const error = await runTriage(merchant, CAMPAIGN, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CostCapExceededError);
    expect((error as CostCapExceededError).campaignId).toBe(CAMPAIGN);
    // Nothing was spent, so nothing was recorded.
    expect(recorded).toHaveLength(0);
  });

  it("stops between the two passes of an escalation", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();

    // Under the cap for the first call, at the cap for the second.
    let spent = 4.0;
    const { deps, recorded } = recordingDeps(fixtureDir, {
      costGuard: createCostGuard(CAMPAIGN, 5.0, async () => spent),
    });

    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.triageModel),
      UNSURE,
    );
    await seedFixture(
      fixtureDir,
      await buildTriageRequest(merchant, deps.config, deps.config.escalationModel),
      SECOND_OPINION,
    );

    deps.recordCall = async (record) => {
      recorded.push(record);
      spent = 5.0; // the first call pushed the campaign to its ceiling
    };

    await expect(runTriage(merchant, CAMPAIGN, deps)).rejects.toBeInstanceOf(
      CostCapExceededError,
    );

    // The first call happened and is on the books; the escalation never ran.
    expect(recorded.map((r) => r.purpose)).toEqual(["triage"]);
  });

  it("names the campaign, the spend and the cap in the error", async () => {
    const { deps } = recordingDeps(await makeFixtureDir(), {
      costGuard: createCostGuard(CAMPAIGN, 2.5, async () => 2.75),
    });

    const error = (await runTriage(sampleMerchant(), CAMPAIGN, deps).catch(
      (e: unknown) => e,
    )) as CostCapExceededError;

    expect(error.message).toContain(CAMPAIGN);
    expect(error.message).toContain("2.75");
    expect(error.message).toContain("2.50");
    expect(error.message).toContain("keep their current state");
  });
});
