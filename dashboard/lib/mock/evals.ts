import type { ModelId } from "../contracts";

/**
 * Eval run shapes.
 *
 * These types are dashboard-local on purpose. `shared/contracts.ts` is frozen
 * and describes the outreach pipeline; the eval harness (WS6) is a separate
 * Python suite that does not exist yet, and inventing a contract for it here
 * would mean changing a file that must not change on a feature branch. When
 * WS6 lands with a real result format, this file is what gets replaced.
 */

export type EvalUnit = "percent" | "usd" | "score" | "ms" | "count";

export interface EvalMetric {
  key: string;
  label: string;
  /** What the metric measures, in one line. Shown under the label. */
  note: string;
  unit: EvalUnit;
  current: number;
  baseline: number;
  /** Whether a larger number is an improvement. Drives the colour of the delta. */
  higherIsBetter: boolean;
}

export interface RubricScore {
  key: string;
  label: string;
  note: string;
  /** Judge score, 1–5. */
  current: number;
  baseline: number;
  /**
   * How often the judge agreed with the human calibration set on this
   * dimension, 0–1. A high score from a judge that disagrees with people is
   * not evidence of anything.
   */
  humanAgreement: number;
}

export interface EvalCase {
  id: string;
  merchantName: string;
  status: "regressed" | "fixed";
  /** What the golden set expects. */
  expected: string;
  /** What this run produced. */
  actual: string;
}

export interface EvalRun {
  id: string;
  startedAt: string;
  durationMs: number;
  commit: string;
  draftModel: ModelId;
  judgeModel: ModelId;
  goldenSetSize: number;
  baselineId: string;
  baselineStartedAt: string;
  baselineCommit: string;
  metrics: EvalMetric[];
  rubric: RubricScore[];
  cases: EvalCase[];
}

export const LATEST_EVAL_RUN: EvalRun = {
  id: "eval_2026w33_004",
  startedAt: "2026-08-12T06:41:00.000Z",
  durationMs: 512_000,
  commit: "9f2c1ab",
  draftModel: "claude-sonnet-5",
  judgeModel: "claude-opus-5",
  goldenSetSize: 120,
  baselineId: "eval_2026w31_001",
  baselineStartedAt: "2026-07-29T06:38:00.000Z",
  baselineCommit: "4d80e73",

  metrics: [
    {
      key: "grounding_pass",
      label: "Evidence grounding pass rate",
      note: "G05 — every personalized claim traceable to a source field",
      unit: "percent",
      current: 0.958,
      baseline: 0.925,
      higherIsBetter: true,
    },
    {
      key: "gate_pass",
      label: "Overall gate pass rate",
      note: "All twelve gates across the golden set",
      unit: "percent",
      current: 0.941,
      baseline: 0.936,
      higherIsBetter: true,
    },
    {
      key: "blocked_rate",
      label: "Blocked draft rate",
      note: "Drafts stopped by a blocking gate",
      unit: "percent",
      current: 0.15,
      baseline: 0.183,
      higherIsBetter: false,
    },
    {
      key: "invented_numbers",
      label: "Invented number rate",
      note: "G06 — figures with no source in the record",
      unit: "percent",
      current: 0.033,
      baseline: 0.017,
      higherIsBetter: false,
    },
    {
      key: "escalation_rate",
      label: "Escalation rate",
      note: "Triage results re-run on a stronger model",
      unit: "percent",
      current: 0.075,
      baseline: 0.092,
      higherIsBetter: false,
    },
    {
      key: "cost_per_draft",
      label: "Cost per drafted merchant",
      note: "Triage and draft calls, summed",
      unit: "usd",
      current: 0.0119,
      baseline: 0.0134,
      higherIsBetter: false,
    },
    {
      key: "judge_overall",
      label: "Judge overall score",
      note: "Mean across all rubric dimensions, 1–5",
      unit: "score",
      current: 4.21,
      baseline: 4.08,
      higherIsBetter: true,
    },
    {
      key: "human_agreement",
      label: "Agreement with human calibration",
      note: "Judge and reviewer reaching the same verdict on 40 calibration drafts",
      unit: "percent",
      current: 0.875,
      baseline: 0.9,
      higherIsBetter: true,
    },
  ],

  rubric: [
    {
      key: "grounding",
      label: "Grounding",
      note: "Claims supported by the record, nothing added",
      current: 4.6,
      baseline: 4.3,
      humanAgreement: 0.93,
    },
    {
      key: "relevance",
      label: "Relevance",
      note: "The angle fits this merchant, not any merchant",
      current: 4.3,
      baseline: 4.2,
      humanAgreement: 0.88,
    },
    {
      key: "tone",
      label: "Tone",
      note: "Direct, no hard sell, no filler",
      current: 4.0,
      baseline: 4.1,
      humanAgreement: 0.78,
    },
    {
      key: "compliance",
      label: "Compliance",
      note: "No guarantees, no personal data, opt-out present",
      current: 4.5,
      baseline: 4.4,
      humanAgreement: 0.95,
    },
    {
      key: "cta",
      label: "Call to action",
      note: "Exactly one ask, and it is easy to answer",
      current: 3.7,
      baseline: 3.4,
      humanAgreement: 0.81,
    },
  ],

  cases: [
    {
      id: "gold_047",
      merchantName: "Verdant Float Spa",
      status: "regressed",
      expected: "No performance figures — the record carries no booking data.",
      actual: 'Generated "lift their weekday bookings by 38%". Caught by G06.',
    },
    {
      id: "gold_082",
      merchantName: "Harlow Steam Rooms",
      status: "regressed",
      expected: "One call to action.",
      actual: "Two: a reply request and a calendar link. Caught by G10.",
    },
    {
      id: "gold_113",
      merchantName: "Orchid Lash Bar",
      status: "regressed",
      expected: "Draft conforming to the output schema.",
      actual: "`subject` returned as an array of strings. Caught by G01.",
    },
    {
      id: "gold_019",
      merchantName: "Ardsley Bathhouse",
      status: "fixed",
      expected: "No ranking claims — ranking data is not collected.",
      actual: "Ranking claim no longer produced on this case.",
    },
    {
      id: "gold_055",
      merchantName: "Clay & Kiln Studio",
      status: "fixed",
      expected: "All placeholders rendered before the gates run.",
      actual: "Placeholder leak resolved by the prompt change in 9f2c1ab.",
    },
  ],
};
