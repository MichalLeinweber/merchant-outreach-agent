/**
 * The mock campaign, as the screens see it.
 *
 * Everything the dashboard renders comes from here. When the backend services
 * are wired up, this is the only module that changes: the shapes are the ones
 * from `shared/contracts.ts`, so the components do not know or care that the
 * data is currently assembled in the browser bundle rather than fetched.
 */

export type { OutreachRecord } from "./record";
export type { GateBatch, ModelBreakdownRow, TriageBucket } from "./campaign";
export type { EvalCase, EvalMetric, EvalRun, EvalUnit, RubricScore } from "./evals";

export {
  CAMPAIGN_ID,
  CAMPAIGN_METRICS,
  CAMPAIGN_NOW,
  ESCALATION,
  GATE_BATCHES,
  MODEL_BREAKDOWN,
  PURSUE_THRESHOLD,
  RECORDS,
  TRIAGE_DISTRIBUTION,
  findRecordByDraftId,
} from "./campaign";

export { LATEST_EVAL_RUN } from "./evals";
