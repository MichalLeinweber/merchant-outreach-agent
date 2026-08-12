import type {
  EvidenceRef,
  GateId,
  GateOutcome,
  GateReport,
  Merchant,
  ModelId,
  TextSpan,
  TokenUsage,
} from "../contracts";
import { GATE_IDS, GATE_SEVERITY } from "../gates";

/**
 * Building blocks for the mock campaign.
 *
 * The point of this file is that the fixtures cannot be subtly wrong. A draft
 * whose `EvidenceRef.claim` is not an exact substring of its `body` violates
 * the contract and would make the evidence highlighting silently show nothing —
 * so the body and its evidence are built from the same strings in one pass,
 * and a span that cannot be located throws instead of being dropped.
 */

/** Fixed clock for the whole fixture set. See `formatAge` for why. */
export const CAMPAIGN_NOW = "2026-08-12T09:20:00.000Z";
export const CAMPAIGN_ID = "cmp_2026w33_uk_ie_reactivation";

// ── Cost ──────────────────────────────────────────────────────────

/**
 * Model pricing, in US dollars per million tokens.
 *
 * Mirrors `services/agents/pricing.ts`, which is the authority. It is copied
 * rather than imported because that module sits outside this Next.js project
 * and resolves its own imports with a `.js` extension under a different module
 * resolution mode. These numbers only ever feed fixtures; once the dashboard
 * reads from the metrics API, the cost arrives already summed.
 */
const MODEL_PRICING: Record<ModelId, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

const CACHE_READ_MULTIPLIER = 0.1;

/** Builds a `TokenUsage` with its cost derived from the token counts. */
export function usage(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): TokenUsage {
  const price = MODEL_PRICING[model];
  const dollars =
    (inputTokens * price.inputPerMTok +
      cachedInputTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      outputTokens * price.outputPerMTok) /
    1_000_000;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costUsd: Math.round(dollars * 1_000_000) / 1_000_000,
  };
}

// ── Draft bodies ──────────────────────────────────────────────────

/**
 * A grounded claim: a run of body text together with the merchant field it was
 * drawn from.
 */
export interface Claim {
  claim: string;
  sourceField: keyof Merchant;
  sourceValue: string;
}

/** Shorthand for a grounded claim inside a body spec. */
export function c(
  claim: string,
  sourceField: keyof Merchant,
  sourceValue: string,
): Claim {
  return { claim, sourceField, sourceValue };
}

export type BodyPart = string | Claim;

/**
 * Assembles a body and its evidence refs from one list of parts.
 *
 * Every `Claim` contributes its text to the body and a matching `EvidenceRef`
 * to the evidence array, so "the claim is an exact substring of the body" holds
 * by construction rather than by proofreading. Ungrounded prose is a plain
 * string and produces no ref — which is precisely what gate G05 looks for.
 */
export function composeBody(parts: readonly BodyPart[]): {
  body: string;
  evidence: EvidenceRef[];
} {
  let body = "";
  const evidence: EvidenceRef[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      body += part;
      continue;
    }
    body += part.claim;
    evidence.push({
      claim: part.claim,
      sourceField: part.sourceField,
      sourceValue: part.sourceValue,
    });
  }

  assertClaimsAreUnambiguous(body, evidence);
  return { body, evidence };
}

/**
 * Rejects a body in which a claim's text also occurs somewhere it was not
 * registered.
 *
 * The backend sends claims as strings, not offsets, so the interface locates
 * them by searching the body. If the same phrase appears both as a claim and as
 * unregistered prose, the search finds the wrong one and the highlight lands in
 * the wrong place — a bug that looks like a styling glitch and is really a data
 * problem. Catching it while the fixture is built is cheaper than recognising
 * it on screen.
 */
function assertClaimsAreUnambiguous(body: string, evidence: readonly EvidenceRef[]): void {
  const registered = new Map<string, number>();
  for (const ref of evidence) {
    registered.set(ref.claim, (registered.get(ref.claim) ?? 0) + 1);
  }

  for (const [claim, count] of registered) {
    let occurrences = 0;
    let from = 0;
    for (;;) {
      const index = body.indexOf(claim, from);
      if (index === -1) break;
      occurrences += 1;
      from = index + 1;
    }

    if (occurrences > count) {
      throw new Error(
        `Mock fixture error: ${JSON.stringify(claim)} occurs ${occurrences} times in the body ` +
          `but is registered as evidence ${count} time(s), so highlighting it is ambiguous. ` +
          `Reword the draft in lib/mock/ so the phrase appears once per evidence ref.`,
      );
    }
  }
}

/**
 * Offsets of an exact phrase within a body, for a failing gate's `spans`.
 *
 * Throws when the phrase is absent. A fixture that points a gate at text which
 * is not there is a broken fixture, and the loud version of that is a build
 * that stops rather than a highlight that never appears.
 */
export function spanOf(body: string, phrase: string): TextSpan {
  const start = body.indexOf(phrase);
  if (start === -1) {
    throw new Error(
      `Mock fixture error: the phrase ${JSON.stringify(phrase)} does not occur in the draft body, ` +
        `so no gate span can point at it. Fix the fixture in lib/mock/.`,
    );
  }
  return { start, end: start + phrase.length };
}

// ── Gate reports ──────────────────────────────────────────────────

/** What a gate says when it fails. Severity comes from the gate itself. */
export interface GateFailure {
  detail: string;
  spans?: TextSpan[];
}

/**
 * Builds a full twelve-gate report. Gates default to passing; anything in
 * `failures` fails, and anything in `pending` produced no outcome at all
 * because evaluation has not reached it yet.
 */
export function buildGateReport(args: {
  draftId: string;
  evaluatedAt: string;
  durationMs: number;
  failures?: Partial<Record<GateId, GateFailure>>;
  pending?: readonly GateId[];
}): GateReport {
  const { draftId, evaluatedAt, durationMs, failures = {}, pending = [] } = args;

  const outcomes: GateOutcome[] = [];
  for (const gate of GATE_IDS) {
    if (pending.includes(gate)) continue;

    const failure = failures[gate];
    const severity = GATE_SEVERITY[gate];

    outcomes.push(
      failure
        ? {
            gate,
            severity,
            passed: false,
            detail: failure.detail,
            ...(failure.spans ? { spans: failure.spans } : {}),
          }
        : { gate, severity, passed: true, detail: "" },
    );
  }

  return {
    draftId,
    outcomes,
    blocked: outcomes.some(
      (outcome) => !outcome.passed && outcome.severity === "blocking",
    ),
    evaluatedAt,
    durationMs,
  };
}

// ── Identifiers ───────────────────────────────────────────────────

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A stand-in for `sha256(merchantId|campaignId|contentHash)`, shaped like the
 * real thing: 64 hex characters, deterministic for the same input. It is not
 * cryptographic and does not need to be — the dedup key on this screen is read,
 * compared and copied, never verified.
 */
export function syntheticDigest(input: string): string {
  let digest = "";
  for (let round = 0; round < 8; round += 1) {
    digest += fnv1a(`${round} ${input}`).toString(16).padStart(8, "0");
  }
  return digest;
}

/** Deterministic dedup key for an attempt, per the contract's definition. */
export function dedupKey(merchantId: string, campaignId: string, body: string): string {
  return syntheticDigest(`${merchantId}|${campaignId}|${syntheticDigest(body)}`);
}

/** Shifts an ISO timestamp by a number of minutes. */
export function shiftMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
