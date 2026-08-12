import { describe, expect, it } from "vitest";

import { EvidenceNotGroundedError, LlmResponseError } from "../../shared/errors.js";
import { UNLIMITED_COST_GUARD } from "./cost.js";
import { buildDraftRequest, runDraft, type DraftDeps } from "./draft.js";
import { LlmClient } from "./llm.js";
import type { LlmCallRecord } from "./runner.js";
import { makeFixtureDir, sampleMerchant, seedFixture, testConfig } from "./test-helpers.js";

const CAMPAIGN = "campaign-001";

const BODY =
  "Hello Lumen Coffee House,\n\n" +
  "A 4.8 rating from 62 reviews says your regulars already love you. " +
  "We would like to help more people in Prague find you.\n\n" +
  "Would you be open to a short call next week?";

const GROUNDED = {
  subject: "Reaching more people in Prague",
  body: BODY,
  evidence: [
    {
      claim: "A 4.8 rating from 62 reviews",
      sourceField: "rating",
      sourceValue: "4.8",
    },
  ],
};

function draftDeps(fixtureDir: string) {
  const recorded: LlmCallRecord[] = [];
  const deps: DraftDeps = {
    llm: new LlmClient({ mode: "fixture", fixtureDir }),
    config: testConfig(),
    costGuard: UNLIMITED_COST_GUARD,
    recordCall: async (record) => {
      recorded.push(record);
    },
    newId: () => "draft-fixed-id",
    now: () => new Date("2026-08-12T10:00:00.000Z"),
  };
  return { deps, recorded };
}

describe("runDraft — grounded evidence", () => {
  it("returns a draft when every claim appears verbatim in the body", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildDraftRequest(merchant, CAMPAIGN, deps.config),
      GROUNDED,
    );

    const { draft, calls } = await runDraft(merchant, CAMPAIGN, deps);

    expect(draft.id).toBe("draft-fixed-id");
    expect(draft.merchantId).toBe(merchant.id);
    expect(draft.campaignId).toBe(CAMPAIGN);
    expect(draft.locale).toBe(merchant.locale);
    expect(draft.subject).toBe(GROUNDED.subject);
    expect(draft.body).toBe(BODY);
    expect(draft.model).toBe(deps.config.draftModel);
    expect(draft.createdAt).toBe("2026-08-12T10:00:00.000Z");
    expect(calls).toHaveLength(1);
  });

  it("keeps the evidence intact, claim and source together", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildDraftRequest(merchant, CAMPAIGN, deps.config),
      GROUNDED,
    );

    const { draft } = await runDraft(merchant, CAMPAIGN, deps);

    expect(draft.evidence).toEqual(GROUNDED.evidence);
    for (const ref of draft.evidence) {
      expect(draft.body).toContain(ref.claim);
    }
  });
});

describe("runDraft — ungrounded evidence", () => {
  /** A claim that reads as if it were supported but appears nowhere in the body. */
  const INVENTED = {
    ...GROUNDED,
    evidence: [
      ...GROUNDED.evidence,
      {
        claim: "your award-winning espresso",
        sourceField: "name",
        sourceValue: "Lumen Coffee House",
      },
    ],
  };

  it("rejects the draft instead of repairing it", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildDraftRequest(merchant, CAMPAIGN, deps.config),
      INVENTED,
    );

    const error = await runDraft(merchant, CAMPAIGN, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvidenceNotGroundedError);
    expect((error as EvidenceNotGroundedError).ungroundedClaims).toEqual([
      "your award-winning espresso",
    ]);
    expect((error as EvidenceNotGroundedError).merchantId).toBe(merchant.id);
  });

  it("still records the call, because it still cost money", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps, recorded } = draftDeps(fixtureDir);

    await seedFixture(
      fixtureDir,
      await buildDraftRequest(merchant, CAMPAIGN, deps.config),
      INVENTED,
    );

    await expect(runDraft(merchant, CAMPAIGN, deps)).rejects.toBeInstanceOf(
      EvidenceNotGroundedError,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.purpose).toBe("draft");
  });

  it("rejects a claim that differs only in punctuation", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(fixtureDir, await buildDraftRequest(merchant, CAMPAIGN, deps.config), {
      ...GROUNDED,
      // The body says "A 4.8 rating from 62 reviews" — no comma.
      evidence: [{ ...GROUNDED.evidence[0]!, claim: "A 4.8 rating, from 62 reviews" }],
    });

    // Near enough is not grounded. Every relaxation here is somewhere a
    // hallucination could hide.
    await expect(runDraft(merchant, CAMPAIGN, deps)).rejects.toBeInstanceOf(
      EvidenceNotGroundedError,
    );
  });

  it("rejects a source field that is not a Merchant key", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(fixtureDir, await buildDraftRequest(merchant, CAMPAIGN, deps.config), {
      ...GROUNDED,
      evidence: [{ ...GROUNDED.evidence[0]!, sourceField: "reputation" }],
    });

    await expect(runDraft(merchant, CAMPAIGN, deps)).rejects.toBeInstanceOf(
      LlmResponseError,
    );
  });

  it("accepts a draft that makes no personalized claims at all", async () => {
    const fixtureDir = await makeFixtureDir();
    const merchant = sampleMerchant();
    const { deps } = draftDeps(fixtureDir);

    await seedFixture(fixtureDir, await buildDraftRequest(merchant, CAMPAIGN, deps.config), {
      subject: "A quick question",
      body: "Hello,\n\nWould you be open to a short call next week?",
      evidence: [],
    });

    // Writing something generic is the correct answer when there is nothing
    // solid to personalize with. Inventing a detail is not.
    const { draft } = await runDraft(merchant, CAMPAIGN, deps);

    expect(draft.evidence).toEqual([]);
  });
});
