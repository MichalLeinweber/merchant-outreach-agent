import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissingApiKeyError, MissingFixtureError } from "../../shared/errors.js";
import {
  LlmClient,
  computeFixtureKey,
  loadConfigFromEnv,
  type LlmFixture,
  type LlmRequest,
  type MessagesApi,
} from "./llm.js";
import { costUsd } from "./pricing.js";

const REQUEST: LlmRequest = {
  model: "claude-haiku-4-5-20251001",
  system: "You triage merchants.",
  userPrompt: "Merchant: Cafe Lumen, Prague, rating 4.8.",
  maxTokens: 512,
};

async function tempFixtureDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "outreach-fixtures-"));
}

/** Stands in for the Anthropic SDK so no test ever touches the network. */
function stubMessages(text: string): MessagesApi {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (): Promise<any> => ({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: REQUEST.model,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text, citations: null }],
      usage: {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      },
    }),
  };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("computeFixtureKey", () => {
  it("is stable across calls with the same request", () => {
    expect(computeFixtureKey(REQUEST)).toBe(computeFixtureKey(REQUEST));
  });

  it("does not depend on the order the object literal was written in", () => {
    const reordered: LlmRequest = {
      maxTokens: REQUEST.maxTokens,
      userPrompt: REQUEST.userPrompt,
      system: REQUEST.system,
      model: REQUEST.model,
    };

    expect(computeFixtureKey(reordered)).toBe(computeFixtureKey(REQUEST));
  });

  it.each([
    ["prompt", { userPrompt: "Merchant: Cafe Lumen, Prague, rating 4.9." }],
    ["system prompt", { system: "You triage merchants carefully." }],
    ["model", { model: "claude-sonnet-5" as const }],
    ["max tokens", { maxTokens: 513 }],
  ])("changes when the %s changes", (_label, patch) => {
    expect(computeFixtureKey({ ...REQUEST, ...patch })).not.toBe(computeFixtureKey(REQUEST));
  });

  it("produces a hex sha256", () => {
    expect(computeFixtureKey(REQUEST)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadConfigFromEnv", () => {
  it("defaults to fixture mode so a fresh clone runs without a key", () => {
    expect(loadConfigFromEnv({}).mode).toBe("fixture");
  });

  it("rejects an unknown mode instead of guessing", () => {
    expect(() => loadConfigFromEnv({ LLM_MODE: "offline" })).toThrow(/not a valid mode/);
  });

  it.each(["live", "record"])("refuses %s mode without an API key", (mode) => {
    expect(() => loadConfigFromEnv({ LLM_MODE: mode })).toThrow(MissingApiKeyError);
  });

  it("treats a blank API key as absent", () => {
    expect(() => loadConfigFromEnv({ LLM_MODE: "live", ANTHROPIC_API_KEY: "   " })).toThrow(
      MissingApiKeyError,
    );
  });
});

describe("fixture mode", () => {
  it("fails hard when the fixture is missing, and says how to record it", async () => {
    const client = new LlmClient({ mode: "fixture", fixtureDir: await tempFixtureDir() });

    const error = await client.call(REQUEST).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingFixtureError);
    expect((error as MissingFixtureError).message).toContain("LLM_MODE=record");
    expect((error as MissingFixtureError).fixtureKey).toBe(computeFixtureKey(REQUEST));
  });

  it("does not fall back to a live call when the fixture is missing", async () => {
    let apiWasCalled = false;
    const client = new LlmClient(
      { mode: "fixture", fixtureDir: await tempFixtureDir() },
      {
        messages: {
          create: async () => {
            apiWasCalled = true;
            throw new Error("unreachable");
          },
        },
      },
    );

    await expect(client.call(REQUEST)).rejects.toBeInstanceOf(MissingFixtureError);
    expect(apiWasCalled).toBe(false);
  });

  it("rejects a fixture that is not valid JSON", async () => {
    const fixtureDir = await tempFixtureDir();
    await writeFile(path.join(fixtureDir, `${computeFixtureKey(REQUEST)}.json`), "{ oops");

    const client = new LlmClient({ mode: "fixture", fixtureDir });

    await expect(client.call(REQUEST)).rejects.toThrow(/not valid JSON/);
  });

  it("replays deterministically, with cost derived from the stored usage", async () => {
    const fixtureDir = await tempFixtureDir();
    const fixture: LlmFixture = {
      fixtureKey: computeFixtureKey(REQUEST),
      model: REQUEST.model,
      recordedAt: "2026-08-12T00:00:00.000Z",
      request: {
        system: REQUEST.system,
        userPrompt: REQUEST.userPrompt,
        maxTokens: REQUEST.maxTokens,
      },
      response: {
        text: "score: 81",
        usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 500 },
      },
    };
    await writeFile(
      path.join(fixtureDir, `${fixture.fixtureKey}.json`),
      JSON.stringify(fixture),
    );

    const client = new LlmClient({ mode: "fixture", fixtureDir });
    const first = await client.call(REQUEST);
    const second = await client.call(REQUEST);

    expect(first).toEqual(second);
    expect(first.text).toBe("score: 81");
    expect(first.meta.mode).toBe("fixture");
    expect(first.meta.latencyMs).toBe(0);
    expect(first.meta.usage.costUsd).toBe(
      costUsd(REQUEST.model, fixture.response.usage),
    );
  });
});

describe("record mode", () => {
  it("calls the API and writes a fixture that fixture mode can replay", async () => {
    const fixtureDir = await tempFixtureDir();
    const deps = { messages: stubMessages("recorded answer"), now: () => 1_000 };

    const recorder = new LlmClient(
      { mode: "record", fixtureDir, apiKey: "test-key" },
      deps,
    );
    const recorded = await recorder.call(REQUEST);

    expect(recorded.meta.mode).toBe("record");
    expect(recorded.text).toBe("recorded answer");

    const onDisk = JSON.parse(
      await readFile(path.join(fixtureDir, `${recorded.meta.fixtureKey}.json`), "utf8"),
    ) as LlmFixture;
    // The prompt is stored so a fixture change is reviewable in a diff.
    expect(onDisk.request.userPrompt).toBe(REQUEST.userPrompt);

    const replayer = new LlmClient({ mode: "fixture", fixtureDir });
    const replayed = await replayer.call(REQUEST);

    expect(replayed.text).toBe(recorded.text);
    expect(replayed.meta.usage.costUsd).toBe(recorded.meta.usage.costUsd);
  });
});

describe("live mode", () => {
  it("reports cached input tokens separately from fresh ones", async () => {
    const client = new LlmClient(
      { mode: "live", fixtureDir: "/unused", apiKey: "test-key" },
      { messages: stubMessages("live answer"), now: () => 0 },
    );

    const { meta } = await client.call(REQUEST);

    expect(meta.usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 200,
      cachedInputTokens: 500,
    });
  });

  it("does not write a fixture", async () => {
    const fixtureDir = await tempFixtureDir();
    const client = new LlmClient(
      { mode: "live", fixtureDir, apiKey: "test-key" },
      { messages: stubMessages("live answer"), now: () => 0 },
    );

    const { meta } = await client.call(REQUEST);

    await expect(
      readFile(path.join(fixtureDir, `${meta.fixtureKey}.json`), "utf8"),
    ).rejects.toThrow();
  });
});
