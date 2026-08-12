/**
 * Shared domain contracts.
 *
 * FROZEN. This file is the reason several workstreams can run in parallel
 * without conflicting. Do not change it as part of a feature branch — if a
 * change is genuinely required, open a dedicated pull request and tell the
 * other workstream before merging it.
 */

// ─── Domain ────────────────────────────────────────────────────

export type MerchantCategory =
  | "restaurant" | "spa_wellness" | "fitness"
  | "beauty" | "activity" | "class_workshop";

export interface Merchant {
  id: string;
  name: string;
  category: MerchantCategory;
  city: string;
  countryCode: string;          // ISO 3166-1 alpha-2
  locale: string;               // BCP 47, e.g. "en-GB"
  websiteUrl: string | null;
  contactEmail: string;         // synthetic, always @example.invalid
  rating: number | null;        // 0–5
  reviewCount: number | null;
  yearsInBusiness: number | null;
  hasActiveOffer: boolean;
  lastOfferEndedAt: string | null;   // ISO-8601
  seatsOrCapacity: number | null;
}

export interface EnrichedMerchant extends Merchant {
  signals: MerchantSignal[];
}

export interface MerchantSignal {
  key: "deal_gap" | "high_rating_low_volume" | "seasonal_window"
     | "capacity_headroom" | "new_to_market";
  value: string;                 // human-readable, quotable in a draft
  sourceField: keyof Merchant;   // grounding: which field this came from
}

// ─── Triage ────────────────────────────────────────────────────

export interface TriageResult {
  merchantId: string;
  score: number;                 // 0–100
  confidence: number;            // 0–1
  reason: string;                // <= 240 chars
  recommendedAction: "pursue" | "skip" | "needs_human";
  model: ModelId;
  escalated: boolean;
  usage: TokenUsage;
}

// ─── Draft ─────────────────────────────────────────────────────

export interface OutreachDraft {
  id: string;
  merchantId: string;
  campaignId: string;
  locale: string;
  subject: string;
  body: string;
  evidence: EvidenceRef[];
  model: ModelId;
  usage: TokenUsage;
  createdAt: string;
}

/** Every personalized claim must point at a real source field. */
export interface EvidenceRef {
  claim: string;                 // exact substring of body
  sourceField: keyof Merchant;
  sourceValue: string;
}

// ─── Gates ─────────────────────────────────────────────────────

export type GateId =
  | "G01_schema" | "G02_length" | "G03_placeholders" | "G04_merchant_name"
  | "G05_evidence_grounding" | "G06_no_invented_numbers" | "G07_banned_claims"
  | "G08_pii" | "G09_locale" | "G10_single_cta" | "G11_frequency_cap"
  | "G12_compliance";

export type GateSeverity = "blocking" | "warning";

export interface GateOutcome {
  gate: GateId;
  severity: GateSeverity;
  passed: boolean;
  detail: string;                // why it failed, empty when passed
  spans?: TextSpan[];            // offsets into body, for UI highlighting
}

export interface TextSpan { start: number; end: number }

export interface GateReport {
  draftId: string;
  outcomes: GateOutcome[];
  blocked: boolean;              // true if any blocking gate failed
  evaluatedAt: string;
  durationMs: number;
}

// ─── Lifecycle ─────────────────────────────────────────────────

export type OutreachState =
  | "INGESTED" | "TRIAGED" | "DRAFTED" | "GATED" | "BLOCKED"
  | "PENDING_APPROVAL" | "REJECTED" | "APPROVED"
  | "QUEUED" | "SENT" | "FAILED";

export interface OutreachAttempt {
  id: string;
  merchantId: string;
  campaignId: string;
  draftId: string;
  state: OutreachState;
  dedupKey: string;              // sha256(merchantId|campaignId|contentHash)
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  providerMessageId: string | null;
  failureReason: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── LLM plumbing ──────────────────────────────────────────────

export type ModelId =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-5"
  | "claude-opus-5";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export type LlmMode = "live" | "fixture" | "record";

export interface LlmCallMeta {
  model: ModelId;
  mode: LlmMode;
  fixtureKey: string;            // stable hash of prompt for fixture lookup
  latencyMs: number;
  usage: TokenUsage;
}

// ─── Metrics ───────────────────────────────────────────────────

export interface CampaignMetrics {
  campaignId: string;
  merchantsIngested: number;
  triagePursue: number;
  triageSkip: number;
  triageNeedsHuman: number;
  draftsCreated: number;
  draftsBlocked: number;
  approved: number;
  rejected: number;
  sent: number;
  gatePassRate: Record<GateId, number>;
  totalCostUsd: number;
  costPerSentUsd: number;
  modelMix: Record<ModelId, number>;
  medianTimeToApproveMs: number | null;
}
