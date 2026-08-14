/**
 * The bridge the Python eval suite talks to.
 *
 * WS6 is a Python suite; the pipeline it measures is TypeScript. There were
 * two ways to join them, and only one of them is honest: re-implement the
 * gates in Python, or run the real ones. A re-implementation drifts — and the
 * day it drifts is the day the evals stop measuring the system and start
 * measuring the copy, silently, while still reporting a pass rate. So this
 * process runs `services/gates` and `services/agents` exactly as production
 * does, and speaks JSON over stdin/stdout.
 *
 * One JSON object in, one JSON object out, then exit. No server, no port, no
 * state between calls: the Python side batches its cases and pays the Node
 * start-up once per test session.
 *
 * Commands:
 *
 *   {"command":"meta"}
 *     Everything the Python side would otherwise hard-code — gate order and
 *     severity, the length limits, model pricing, and the passing draft from
 *     the gate service's own fixtures. Duplicating any of it in Python would
 *     be a second source of truth for a number that already has one.
 *
 *   {"command":"gates","cases":[{"id":…,"draft":…,"merchant":…,"context":…}]}
 *     Runs every gate over every case and returns the reports.
 *
 *   {"command":"triage","merchants":[…],"campaignId":…,"now":…,"maxCostUsd":…}
 *     Enriches each merchant and runs the triage agent through the real LLM
 *     client. The mode comes from LLM_MODE (default `fixture`), so CI replays
 *     recorded responses and never calls a model. A merchant whose fixture is
 *     missing comes back as {"ok":false,…} rather than taking the batch down:
 *     the suite reports which merchants have no fixture and skips the metric,
 *     which is a louder failure than a stack trace naming only the first one.
 *
 *   {"command":"drafts","merchants":[…],"campaignId":…,"now":…,"maxCostUsd":…}
 *     The same for the draft agent. Ids and timestamps are injected rather
 *     than generated, so recording the same merchant twice produces the same
 *     draft object and a fixture diff shows a change in the model's output
 *     rather than a new UUID.
 *
 * Run it as:
 *   node --import ./evals/harness/ts-resolve.mjs evals/harness/bridge.ts
 */

import { loadAgentsConfig } from "../../services/agents/config.js";
import { createCostGuard, UNLIMITED_COST_GUARD } from "../../services/agents/cost.js";
import { runDraft, type DraftDeps } from "../../services/agents/draft.js";
import { LlmClient, loadConfigFromEnv } from "../../services/agents/llm.js";
import { MODEL_PRICING } from "../../services/agents/pricing.js";
import type { AgentDeps } from "../../services/agents/runner.js";
import { runTriage } from "../../services/agents/triage.js";
import { REQUIRED_CLAIM_COUNT } from "../../services/gates/claims.js";
import { runGates } from "../../services/gates/runner.js";
import {
  BODY_MAX_WORDS,
  BODY_MIN_WORDS,
  SUBJECT_MAX_LENGTH,
} from "../../services/gates/structure.js";
import {
  sampleContext,
  sampleDraft,
  sampleMerchant,
  NOW,
} from "../../services/gates/test-helpers.js";
import {
  DEFAULT_ALLOWED_LINK_HOSTS,
  DEFAULT_FREQUENCY_CAP_DAYS,
  GATE_LABELS,
  GATE_ORDER,
  GATE_SEVERITY,
  type GateContext,
} from "../../services/gates/types.js";
import { deriveSignals } from "../../services/ingest/enrich.js";
import type { EnrichedMerchant, Merchant, OutreachDraft } from "../../shared/contracts.js";

// ─── Request shapes ────────────────────────────────────────────

interface GateCase {
  id: string;
  draft: OutreachDraft;
  merchant: Merchant;
  context: GateContext;
}

interface Request {
  command: "meta" | "gates" | "triage" | "drafts";
  cases?: GateCase[];
  merchants?: Merchant[];
  campaignId?: string;
  now?: string;
  /** Hard ceiling on model spend for a live run. Ignored in fixture mode. */
  maxCostUsd?: number;
}

// ─── Commands ──────────────────────────────────────────────────

/**
 * Constants and fixtures, so the Python side never restates one.
 *
 * The sample draft is the gate service's own `PASSING_BODY`: the one body in
 * the repository that is known to pass all thirteen gates. Every negative
 * case in `test_gates.py` is that draft with exactly one thing broken, which
 * is what makes a failing assertion name the defect rather than some
 * unrelated property of a body written for the occasion.
 */
function meta(): unknown {
  return {
    gateOrder: GATE_ORDER,
    gateSeverity: GATE_SEVERITY,
    gateLabels: GATE_LABELS,
    limits: {
      subjectMaxLength: SUBJECT_MAX_LENGTH,
      bodyMinWords: BODY_MIN_WORDS,
      bodyMaxWords: BODY_MAX_WORDS,
      requiredClaimCount: REQUIRED_CLAIM_COUNT,
      frequencyCapDays: DEFAULT_FREQUENCY_CAP_DAYS,
      allowedLinkHosts: DEFAULT_ALLOWED_LINK_HOSTS,
    },
    pricing: MODEL_PRICING,
    sample: {
      now: NOW,
      merchant: sampleMerchant(),
      draft: sampleDraft(),
      context: sampleContext(),
    },
  };
}

function gates(cases: GateCase[]): unknown {
  return {
    results: cases.map((entry) => ({
      id: entry.id,
      report: runGates(entry.draft, entry.merchant, entry.context),
    })),
  };
}

/**
 * Everything both agents need, plus a running total of what they have spent.
 *
 * Spend is summed here rather than read from a database: the eval harness has
 * no campaign row to read. The cap still applies before every call, so a live
 * run stops at the ceiling instead of discovering it on the invoice.
 */
function agentRun(request: Request): {
  deps: AgentDeps;
  spent: () => number;
  charge: (usd: number) => void;
} {
  const campaignId = request.campaignId ?? "eval";
  let spentUsd = 0;

  const costGuard =
    request.maxCostUsd === undefined
      ? UNLIMITED_COST_GUARD
      : createCostGuard(campaignId, request.maxCostUsd, async () => spentUsd);

  return {
    deps: { llm: new LlmClient(loadConfigFromEnv()), config: loadAgentsConfig(), costGuard },
    spent: () => spentUsd,
    charge: (usd: number) => {
      spentUsd += usd;
    },
  };
}

/** The merchant as the agents see it: the record plus its derived signals. */
function enrich(merchant: Merchant, now: Date | undefined): EnrichedMerchant {
  return { ...merchant, signals: deriveSignals(merchant, now === undefined ? {} : { now }) };
}

async function triage(request: Request): Promise<unknown> {
  const campaignId = request.campaignId ?? "eval";
  const now = request.now === undefined ? undefined : new Date(request.now);
  const { deps, spent, charge } = agentRun(request);

  const results = [];

  for (const merchant of request.merchants ?? []) {
    try {
      const outcome = await runTriage(enrich(merchant, now), campaignId, deps);
      charge(outcome.result.usage.costUsd);
      results.push({
        merchantId: merchant.id,
        ok: true,
        result: outcome.result,
        calls: outcome.calls,
      });
    } catch (error) {
      results.push({ merchantId: merchant.id, ok: false, error: describeError(error) });
    }
  }

  return { results, spentUsd: spent() };
}

async function drafts(request: Request): Promise<unknown> {
  const campaignId = request.campaignId ?? "eval";
  const now = request.now === undefined ? undefined : new Date(request.now);
  const { deps, spent, charge } = agentRun(request);

  const results = [];

  for (const merchant of request.merchants ?? []) {
    // Deterministic identity. `runDraft` would otherwise stamp a UUID and the
    // wall clock onto the draft, and re-recording the same merchant would
    // produce a diff in which the only change is the id.
    const draftDeps: DraftDeps = {
      ...deps,
      newId: () => `draft_${merchant.id}`,
      now: () => new Date(request.now ?? "1970-01-01T00:00:00.000Z"),
    };

    try {
      const outcome = await runDraft(enrich(merchant, now), campaignId, draftDeps);
      charge(outcome.draft.usage.costUsd);
      results.push({
        merchantId: merchant.id,
        ok: true,
        draft: outcome.draft,
        calls: outcome.calls,
      });
    } catch (error) {
      // A draft whose evidence is not grounded throws here rather than
      // becoming an object anyone can act on. That is a result worth
      // reporting, not a crash: the recorded fixture still exists, and the
      // rejection is exactly what the pipeline is supposed to do.
      results.push({ merchantId: merchant.id, ok: false, error: describeError(error) });
    }
  }

  return { results, spentUsd: spent() };
}

/** An error as data, keeping the typed `code` the domain errors carry. */
function describeError(error: unknown): { name: string; code: string; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      code: typeof code === "string" ? code : "UNKNOWN",
      message: error.message,
    };
  }
  return { name: "Unknown", code: "UNKNOWN", message: String(error) };
}

// ─── Entry point ───────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const request = JSON.parse(raw) as Request;

  switch (request.command) {
    case "meta":
      process.stdout.write(JSON.stringify(meta()));
      return;
    case "gates":
      process.stdout.write(JSON.stringify(gates(request.cases ?? [])));
      return;
    case "triage":
      process.stdout.write(JSON.stringify(await triage(request)));
      return;
    case "drafts":
      process.stdout.write(JSON.stringify(await drafts(request)));
      return;
    default:
      throw new Error(
        `Unknown bridge command ${JSON.stringify(request.command)}. ` +
          `Expected one of: meta, gates, triage, drafts.`,
      );
  }
}

main().catch((error: unknown) => {
  // stderr, not stdout: stdout carries the JSON the Python side parses, and a
  // stack trace mixed into it turns a clear failure into a parse error.
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
