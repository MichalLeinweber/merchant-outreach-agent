import type {
  EnrichedMerchant,
  GateId,
  GateReport,
  ModelId,
  OutreachAttempt,
  OutreachDraft,
  OutreachState,
  TokenUsage,
  TriageResult,
} from "../contracts";
import type { BodyPart, GateFailure } from "./build";
import {
  CAMPAIGN_ID,
  CAMPAIGN_NOW,
  buildGateReport,
  composeBody,
  dedupKey,
  shiftMinutes,
} from "./build";

/**
 * One merchant's journey through the pipeline, as the dashboard needs it.
 *
 * The contract splits this across five types because they are produced by five
 * services at five different times. Every screen here shows them together, so
 * they are joined once, in one place, rather than in each component.
 */
export interface OutreachRecord {
  merchant: EnrichedMerchant;
  triage: TriageResult;
  draft: OutreachDraft;
  gates: GateReport;
  attempt: OutreachAttempt;
}

export interface RecordSpec {
  /** Short slug; the merchant, draft and attempt ids are derived from it. */
  slug: string;
  merchant: Omit<EnrichedMerchant, "id">;
  triage: Omit<TriageResult, "merchantId">;
  draft: {
    subject: string;
    parts: readonly BodyPart[];
    model: ModelId;
    usage: TokenUsage;
    /** How long ago the draft was written, in minutes before `CAMPAIGN_NOW`. */
    ageMinutes: number;
  };
  gates: {
    durationMs: number;
    /**
     * Failing gates. Each entry receives the assembled body so it can point its
     * spans at real offsets rather than hard-coded numbers that rot the moment
     * the copy is edited.
     */
    failures?: Partial<Record<GateId, (body: string) => GateFailure>>;
    /** Gates evaluation has not reached yet. */
    pending?: readonly GateId[];
  };
  attempt: {
    state: OutreachState;
    approvedBy?: string;
    /** Minutes after the draft was created. */
    approvedAfterMinutes?: number;
    sentAfterMinutes?: number;
    providerMessageId?: string;
    failureReason?: string;
    attemptCount?: number;
  };
}

export function buildRecord(spec: RecordSpec): OutreachRecord {
  const merchantId = `mrc_${spec.slug}`;
  const draftId = `drf_${spec.slug}`;

  const { body, evidence } = composeBody(spec.draft.parts);

  const createdAt = shiftMinutes(CAMPAIGN_NOW, -spec.draft.ageMinutes);

  const failures: Partial<Record<GateId, GateFailure>> = {};
  for (const [gate, describe] of Object.entries(spec.gates.failures ?? {})) {
    failures[gate as GateId] = describe(body);
  }

  const gates = buildGateReport({
    draftId,
    // Gates run within seconds of the draft being written.
    evaluatedAt: shiftMinutes(createdAt, 1),
    durationMs: spec.gates.durationMs,
    failures,
    ...(spec.gates.pending ? { pending: spec.gates.pending } : {}),
  });

  const approvedAt =
    spec.attempt.approvedAfterMinutes === undefined
      ? null
      : shiftMinutes(createdAt, spec.attempt.approvedAfterMinutes);

  const sentAt =
    spec.attempt.sentAfterMinutes === undefined
      ? null
      : shiftMinutes(createdAt, spec.attempt.sentAfterMinutes);

  const attempt: OutreachAttempt = {
    id: `att_${spec.slug}`,
    merchantId,
    campaignId: CAMPAIGN_ID,
    draftId,
    state: spec.attempt.state,
    dedupKey: dedupKey(merchantId, CAMPAIGN_ID, body),
    approvedBy: spec.attempt.approvedBy ?? null,
    approvedAt,
    sentAt,
    providerMessageId: spec.attempt.providerMessageId ?? null,
    failureReason: spec.attempt.failureReason ?? null,
    attemptCount: spec.attempt.attemptCount ?? 1,
    createdAt,
    updatedAt: sentAt ?? approvedAt ?? gates.evaluatedAt,
  };

  const draft: OutreachDraft = {
    id: draftId,
    merchantId,
    campaignId: CAMPAIGN_ID,
    locale: spec.merchant.locale,
    subject: spec.draft.subject,
    body,
    evidence,
    model: spec.draft.model,
    usage: spec.draft.usage,
    createdAt,
  };

  return {
    merchant: { id: merchantId, ...spec.merchant },
    triage: { merchantId, ...spec.triage },
    draft,
    gates,
    attempt,
  };
}
