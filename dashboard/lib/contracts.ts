/**
 * The dashboard's window onto the frozen backend contract.
 *
 * `shared/contracts.ts` lives outside this Next.js project and does not change
 * on a feature branch. It is re-exported here with `import type` only, so the
 * reference is erased at compile time and nothing outside `dashboard/` is ever
 * bundled. Every component in this app types against these names, which means
 * a contract change shows up as a compile error here rather than as a screen
 * that quietly renders the wrong thing.
 */

export type {
  CampaignMetrics,
  EnrichedMerchant,
  EvidenceRef,
  GateId,
  GateOutcome,
  GateReport,
  GateSeverity,
  LlmCallMeta,
  LlmMode,
  Merchant,
  MerchantCategory,
  MerchantSignal,
  ModelId,
  OutreachAttempt,
  OutreachDraft,
  OutreachState,
  TextSpan,
  TokenUsage,
  TriageResult,
} from "../../shared/contracts";
