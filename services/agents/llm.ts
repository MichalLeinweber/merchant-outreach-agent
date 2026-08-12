/**
 * The one LLM client, with three modes.
 *
 *   live     real API call, real tokens, real cost
 *   record   real API call, and the response is written to fixtures/llm/
 *   fixture  read from fixtures/llm/, no network, fully deterministic
 *
 * A missing fixture in `fixture` mode is a hard error, never a silent
 * fallback to a live call or a stub. That is the whole design: when someone
 * edits a prompt, the fixture key changes, the run fails, and the message
 * says how to re-record. A fallback would turn that into an invisible
 * behaviour change.
 */

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import type { LlmCallMeta, LlmMode, ModelId, TokenUsage } from "../../shared/contracts.js";
import {
  CorruptFixtureError,
  LlmResponseError,
  MissingApiKeyError,
  MissingFixtureError,
} from "../../shared/errors.js";
import { costUsd } from "./pricing.js";

// ─── Public shapes ─────────────────────────────────────────────

/** Everything that can change the model's answer, and nothing else. */
export interface LlmRequest {
  model: ModelId;
  system: string;
  userPrompt: string;
  maxTokens: number;
}

export interface LlmResult {
  text: string;
  meta: LlmCallMeta;
}

export interface LlmClientConfig {
  mode: LlmMode;
  /** Directory holding the recorded responses. */
  fixtureDir: string;
  /** Required in `live` and `record` mode, ignored in `fixture` mode. */
  apiKey?: string | undefined;
}

/** Stored form of a recorded call. */
export interface LlmFixture {
  fixtureKey: string;
  model: ModelId;
  recordedAt: string;
  /** Kept so a fixture diff in a pull request is reviewable by a human. */
  request: { system: string; userPrompt: string; maxTokens: number };
  response: {
    text: string;
    usage: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">;
  };
}

// ─── Fixture key ───────────────────────────────────────────────

/**
 * Bumped only when the hashed shape changes, which invalidates every fixture
 * at once. Prompt edits do not need this — they change the hash by themselves.
 */
const FIXTURE_KEY_VERSION = 1;

/**
 * Stable hash of a request.
 *
 * The field order is written out literally rather than taken from
 * `Object.keys`, so the key cannot drift when someone reorders the interface.
 */
export function computeFixtureKey(request: LlmRequest): string {
  const canonical = JSON.stringify({
    v: FIXTURE_KEY_VERSION,
    model: request.model,
    system: request.system,
    userPrompt: request.userPrompt,
    maxTokens: request.maxTokens,
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── Configuration ─────────────────────────────────────────────

const VALID_MODES: readonly LlmMode[] = ["live", "record", "fixture"];

/** Repository root, derived from this file so the cwd does not matter. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_FIXTURE_DIR = path.join(REPO_ROOT, "fixtures", "llm");

/**
 * Read the client configuration from the environment.
 *
 * Defaults to `fixture` so that a fresh clone with no API key runs the whole
 * pipeline end to end. Opting into a live call has to be deliberate.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClientConfig {
  const raw = env.LLM_MODE ?? "fixture";

  if (!VALID_MODES.includes(raw as LlmMode)) {
    throw new Error(
      `LLM_MODE="${raw}" is not a valid mode. Use one of: ${VALID_MODES.join(", ")}.`,
    );
  }
  const mode = raw as LlmMode;

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  if (mode !== "fixture" && !apiKey) {
    throw new MissingApiKeyError(mode);
  }

  return {
    mode,
    fixtureDir: env.LLM_FIXTURE_DIR ?? DEFAULT_FIXTURE_DIR,
    apiKey,
  };
}

// ─── Client ────────────────────────────────────────────────────

/**
 * Minimal slice of the Anthropic SDK that this client uses. Declaring it
 * explicitly keeps the unit tests free of both the network and the SDK.
 */
export interface MessagesApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface LlmClientDeps {
  messages?: MessagesApi;
  /** Injectable so recorded latency does not make tests flaky. */
  now?: () => number;
}

export class LlmClient {
  private readonly config: LlmClientConfig;
  private readonly now: () => number;
  private messages: MessagesApi | undefined;

  constructor(config: LlmClientConfig, deps: LlmClientDeps = {}) {
    this.config = config;
    this.now = deps.now ?? (() => Date.now());
    this.messages = deps.messages;
  }

  /** Convenience constructor for production code paths. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
    return new LlmClient(loadConfigFromEnv(env));
  }

  async call(request: LlmRequest): Promise<LlmResult> {
    const fixtureKey = computeFixtureKey(request);

    if (this.config.mode === "fixture") {
      return this.replayFixture(request, fixtureKey);
    }

    const result = await this.callApi(request, fixtureKey);

    if (this.config.mode === "record") {
      await this.writeFixture(request, fixtureKey, result);
    }

    return result;
  }

  // ── fixture mode ──

  private fixturePath(fixtureKey: string): string {
    return path.join(this.config.fixtureDir, `${fixtureKey}.json`);
  }

  private async replayFixture(request: LlmRequest, fixtureKey: string): Promise<LlmResult> {
    const filePath = this.fixturePath(fixtureKey);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        // The one error that must never be swallowed.
        throw new MissingFixtureError(fixtureKey, request.model, filePath);
      }
      throw cause;
    }

    let fixture: LlmFixture;
    try {
      fixture = JSON.parse(raw) as LlmFixture;
    } catch (cause) {
      throw new CorruptFixtureError(filePath, "not valid JSON", { cause });
    }

    const usage = fixture.response?.usage;
    if (typeof fixture.response?.text !== "string" || !usage) {
      throw new CorruptFixtureError(
        filePath,
        "expected response.text (string) and response.usage",
      );
    }

    return {
      text: fixture.response.text,
      meta: {
        model: request.model,
        mode: "fixture",
        fixtureKey,
        // Replay has no real latency; reporting zero keeps runs comparable.
        latencyMs: 0,
        usage: { ...usage, costUsd: costUsd(request.model, usage) },
      },
    };
  }

  private async writeFixture(
    request: LlmRequest,
    fixtureKey: string,
    result: LlmResult,
  ): Promise<void> {
    const fixture: LlmFixture = {
      fixtureKey,
      model: request.model,
      recordedAt: new Date(this.now()).toISOString(),
      request: {
        system: request.system,
        userPrompt: request.userPrompt,
        maxTokens: request.maxTokens,
      },
      response: {
        text: result.text,
        usage: {
          inputTokens: result.meta.usage.inputTokens,
          outputTokens: result.meta.usage.outputTokens,
          cachedInputTokens: result.meta.usage.cachedInputTokens,
        },
      },
    };

    await mkdir(this.config.fixtureDir, { recursive: true });
    await writeFile(
      this.fixturePath(fixtureKey),
      `${JSON.stringify(fixture, null, 2)}\n`,
      "utf8",
    );
  }

  // ── live / record mode ──

  private getMessages(): MessagesApi {
    if (!this.messages) {
      if (!this.config.apiKey) {
        throw new MissingApiKeyError(this.config.mode);
      }
      this.messages = new Anthropic({ apiKey: this.config.apiKey }).messages;
    }
    return this.messages;
  }

  private async callApi(request: LlmRequest, fixtureKey: string): Promise<LlmResult> {
    const startedAt = this.now();

    const response = await this.getMessages().create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.userPrompt }],
    });

    const latencyMs = this.now() - startedAt;

    // Safety classifiers can decline a request; that arrives as a normal 200
    // with an empty content array, so check before reading the content.
    if (response.stop_reason === "refusal") {
      throw new LlmResponseError(request.model, "the request was refused by the model");
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmResponseError(
        request.model,
        `output hit max_tokens (${request.maxTokens}); the response is truncated`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (text.length === 0) {
      throw new LlmResponseError(request.model, "the response contained no text block");
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };

    return {
      text,
      meta: {
        model: request.model,
        mode: this.config.mode,
        fixtureKey,
        latencyMs,
        usage: { ...usage, costUsd: costUsd(request.model, usage) },
      },
    };
  }
}
