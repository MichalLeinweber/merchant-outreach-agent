import type { CampaignMetrics, GateId, GateOutcome, ModelId } from "../contracts";
import { GATE_IDS, GATE_SEVERITY } from "../gates";
import { CAMPAIGN_ID, CAMPAIGN_NOW, usage } from "./build";
import { GENERATED_RECORDS } from "./generated";
import type { OutreachRecord } from "./record";
import { HAND_WRITTEN_RECORDS } from "./records";

/**
 * The campaign, assembled.
 *
 * Every number on the metrics screen is computed from the records below rather
 * than written down next to them. That is not tidiness for its own sake: the
 * contract says token usage propagates from each call into `CampaignMetrics`,
 * so cost is a sum, not an estimate. A fixture that states a total separately
 * from its parts can disagree with itself, and this one cannot.
 */

export { CAMPAIGN_ID, CAMPAIGN_NOW };

/** Newest first — the order an operator works the queue in. */
export const RECORDS: OutreachRecord[] = [...HAND_WRITTEN_RECORDS, ...GENERATED_RECORDS].sort(
  (a, b) => Date.parse(b.draft.createdAt) - Date.parse(a.draft.createdAt),
);

/**
 * Merchants that were ingested and triaged but never drafted, because triage
 * scored them below the pursue threshold.
 *
 * They are not in `RECORDS` — there is nothing to approve, so they never reach
 * the queue — but they did cost money and they are part of the campaign's
 * denominator, so the metrics screen has to account for them.
 */
export const PURSUE_THRESHOLD = 55;
const SKIPPED_COUNT = 63;

/** Deterministic spread of skipped scores, all below the pursue threshold. */
const SKIPPED_SCORES: number[] = Array.from(
  { length: SKIPPED_COUNT },
  (_, index) => 8 + ((index * 17) % 47),
);

/** One aggregate usage row for all the skipped triage calls. */
const SKIPPED_TRIAGE_USAGE = usage(
  "claude-haiku-4-5-20251001",
  1170 * SKIPPED_COUNT,
  150 * SKIPPED_COUNT,
  940 * SKIPPED_COUNT,
);

// ── Lookups ───────────────────────────────────────────────────────

export function findRecordByDraftId(draftId: string): OutreachRecord | undefined {
  return RECORDS.find((record) => record.draft.id === draftId);
}

// ── Cost ──────────────────────────────────────────────────────────

export interface ModelBreakdownRow {
  model: ModelId;
  /** Number of LLM calls attributed to this model. */
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function emptyRow(model: ModelId): ModelBreakdownRow {
  return { model, calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

/** Cost and volume per model, summed from every call in the campaign. */
export const MODEL_BREAKDOWN: ModelBreakdownRow[] = (() => {
  const rows = new Map<ModelId, ModelBreakdownRow>([
    ["claude-haiku-4-5-20251001", emptyRow("claude-haiku-4-5-20251001")],
    ["claude-sonnet-5", emptyRow("claude-sonnet-5")],
    ["claude-opus-5", emptyRow("claude-opus-5")],
  ]);

  const add = (model: ModelId, u: (typeof SKIPPED_TRIAGE_USAGE), calls: number): void => {
    const row = rows.get(model);
    if (!row) return;
    row.calls += calls;
    row.costUsd = Math.round((row.costUsd + u.costUsd) * 1_000_000) / 1_000_000;
    row.inputTokens += u.inputTokens;
    row.outputTokens += u.outputTokens;
    row.cachedInputTokens += u.cachedInputTokens;
  };

  for (const record of RECORDS) {
    add(record.triage.model, record.triage.usage, 1);
    add(record.draft.model, record.draft.usage, 1);
  }
  add("claude-haiku-4-5-20251001", SKIPPED_TRIAGE_USAGE, SKIPPED_COUNT);

  return [...rows.values()];
})();

const TOTAL_COST_USD =
  Math.round(MODEL_BREAKDOWN.reduce((sum, row) => sum + row.costUsd, 0) * 1_000_000) / 1_000_000;

// ── Escalation ────────────────────────────────────────────────────

export const ESCALATION = (() => {
  const triaged = RECORDS.length + SKIPPED_COUNT;
  const escalated = RECORDS.filter((record) => record.triage.escalated).length;
  return { triaged, escalated, rate: escalated / triaged };
})();

// ── Time to approve ───────────────────────────────────────────────

const TIME_TO_APPROVE_MS: number[] = RECORDS.flatMap((record) => {
  const { approvedAt, createdAt } = record.attempt;
  if (approvedAt === null) return [];
  return [Date.parse(approvedAt) - Date.parse(createdAt)];
}).sort((a, b) => a - b);

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

// ── Gate pass rates ───────────────────────────────────────────────

interface GateTally {
  evaluated: number;
  passed: number;
}

function tallyGates(records: readonly OutreachRecord[]): Map<GateId, GateTally> {
  const tallies = new Map<GateId, GateTally>(
    GATE_IDS.map((gate) => [gate, { evaluated: 0, passed: 0 }]),
  );

  for (const record of records) {
    for (const outcome of record.gates.outcomes) {
      const tally = tallies.get(outcome.gate);
      if (!tally) continue;
      tally.evaluated += 1;
      if (outcome.passed) tally.passed += 1;
    }
  }

  return tallies;
}

const GATE_TALLIES = tallyGates(RECORDS);

const GATE_PASS_RATE: Record<GateId, number> = Object.fromEntries(
  GATE_IDS.map((gate) => {
    const tally = GATE_TALLIES.get(gate);
    // A gate nothing has reached yet has no rate. Reporting it as 0% would
    // read as "everything failed", which is the opposite of the truth.
    const rate = !tally || tally.evaluated === 0 ? 1 : tally.passed / tally.evaluated;
    return [gate, rate];
  }),
) as Record<GateId, number>;

// ── Campaign metrics ──────────────────────────────────────────────

const SENT_COUNT = RECORDS.filter((record) => record.attempt.state === "SENT").length;

export const CAMPAIGN_METRICS: CampaignMetrics = {
  campaignId: CAMPAIGN_ID,
  merchantsIngested: RECORDS.length + SKIPPED_COUNT,
  triagePursue: RECORDS.filter((r) => r.triage.recommendedAction === "pursue").length,
  triageSkip: SKIPPED_COUNT,
  triageNeedsHuman: RECORDS.filter((r) => r.triage.recommendedAction === "needs_human").length,
  draftsCreated: RECORDS.length,
  draftsBlocked: RECORDS.filter((r) => r.gates.blocked).length,
  approved: RECORDS.filter(
    (r) => r.attempt.approvedAt !== null && r.attempt.state !== "REJECTED",
  ).length,
  rejected: RECORDS.filter((r) => r.attempt.state === "REJECTED").length,
  sent: SENT_COUNT,
  gatePassRate: GATE_PASS_RATE,
  totalCostUsd: TOTAL_COST_USD,
  costPerSentUsd: SENT_COUNT === 0 ? 0 : TOTAL_COST_USD / SENT_COUNT,
  modelMix: {
    "claude-haiku-4-5-20251001":
      MODEL_BREAKDOWN.find((r) => r.model === "claude-haiku-4-5-20251001")?.calls ?? 0,
    "claude-sonnet-5": MODEL_BREAKDOWN.find((r) => r.model === "claude-sonnet-5")?.calls ?? 0,
    "claude-opus-5": MODEL_BREAKDOWN.find((r) => r.model === "claude-opus-5")?.calls ?? 0,
  },
  medianTimeToApproveMs: median(TIME_TO_APPROVE_MS),
};

// ── Triage score distribution ─────────────────────────────────────

export interface TriageBucket {
  /** Inclusive lower bound of the ten-point bucket. */
  from: number;
  drafted: number;
  skipped: number;
}

export const TRIAGE_DISTRIBUTION: TriageBucket[] = (() => {
  const buckets: TriageBucket[] = Array.from({ length: 10 }, (_, index) => ({
    from: index * 10,
    drafted: 0,
    skipped: 0,
  }));

  const place = (score: number, key: "drafted" | "skipped"): void => {
    const bucket = buckets[Math.min(Math.floor(score / 10), 9)];
    if (bucket) bucket[key] += 1;
  };

  for (const record of RECORDS) place(record.triage.score, "drafted");
  for (const score of SKIPPED_SCORES) place(score, "skipped");

  return buckets;
})();

// ── Gate heatmap ──────────────────────────────────────────────────

/**
 * One row of the heatmap: a batch of drafts, aggregated per gate.
 *
 * The row is rendered by the same `GateStrip` the queue and the draft detail
 * use. A batch cell passes only when every draft in it passed, and its
 * intensity carries how much of the batch failed — so a wall of solid green
 * with one dark red cell reads correctly at a glance, which is the only thing
 * a heatmap is for.
 */
export interface GateBatch {
  label: string;
  size: number;
  outcomes: GateOutcome[];
  intensity: Partial<Record<GateId, number>>;
}

const BATCH_SIZE = 8;

export const GATE_BATCHES: GateBatch[] = (() => {
  const batches: GateBatch[] = [];
  // Oldest first, so the heatmap reads top-to-bottom in the order the campaign
  // actually ran.
  const chronological = [...RECORDS].sort(
    (a, b) => Date.parse(a.draft.createdAt) - Date.parse(b.draft.createdAt),
  );

  for (let start = 0; start < chronological.length; start += BATCH_SIZE) {
    const slice = chronological.slice(start, start + BATCH_SIZE);
    const tallies = tallyGates(slice);

    const outcomes: GateOutcome[] = [];
    const intensity: Partial<Record<GateId, number>> = {};

    for (const gate of GATE_IDS) {
      const tally = tallies.get(gate);
      if (!tally || tally.evaluated === 0) continue; // not reached in this batch

      const failed = tally.evaluated - tally.passed;
      if (failed === 0) {
        outcomes.push({ gate, severity: GATE_SEVERITY[gate], passed: true, detail: "" });
        intensity[gate] = 1;
        continue;
      }

      outcomes.push({
        gate,
        severity: GATE_SEVERITY[gate],
        passed: false,
        detail: `${failed} of ${tally.evaluated} drafts failed this gate in the batch.`,
      });
      // Floored so a single failure in a large batch is still visible.
      intensity[gate] = 0.35 + 0.65 * (failed / tally.evaluated);
    }

    batches.push({
      label: `Batch ${String(batches.length + 1).padStart(2, "0")}`,
      size: slice.length,
      outcomes,
      intensity,
    });
  }

  return batches;
})();
