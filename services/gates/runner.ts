/**
 * The gate runner.
 *
 * Runs every gate against a draft and assembles the report. Three decisions
 * worth stating, because each has an alternative that looks reasonable:
 *
 * **Every gate runs, always.** The runner does not stop at the first blocking
 * failure. Stopping would be faster and would produce a worse report: the
 * evals need per-gate pass rates over the whole corpus, and a reviewer looking
 * at a blocked draft wants to know everything wrong with it, not the first
 * thing. These are pure string functions over a few hundred words — there is
 * no cost worth optimising here.
 *
 * **`blocked` is derived, never passed in.** It is true when some gate that
 * failed was a blocking one, and it is computed in one place. A draft with a
 * blocking failure goes to `BLOCKED`, never to `PENDING_APPROVAL`; that rule
 * is only as good as the flag it reads, so the flag has exactly one source.
 *
 * **The clock is an argument.** `evaluatedAt` comes from the context the
 * gates were evaluated with, and the duration comes from an injectable
 * monotonic clock. The gates themselves are pure; the runner's one impurity
 * is measuring how long they took, and even that is replaceable in a test.
 */

import type { GateId, GateOutcome, GateReport, Merchant, OutreachDraft } from "../../shared/contracts.js";
import { g13ClaimCount } from "./claims.js";
import { g07BannedClaims, g10SingleCta, g12Compliance } from "./content.js";
import { g11FrequencyCap } from "./frequency.js";
import { g05EvidenceGrounding, g06NoInventedNumbers } from "./grounding.js";
import { g04MerchantName, g08Pii } from "./identity.js";
import { g09Locale } from "./language.js";
import { g01Schema, g02Length, g03Placeholders } from "./structure.js";
import {
  G13_CLAIM_COUNT,
  GATE_ORDER,
  type ExtendedGateId,
  type ExtendedGateOutcome,
  type ExtendedGateReport,
  type Gate,
  type GateContext,
} from "./types.js";

/**
 * Every gate, by id.
 *
 * A total `Record` rather than an array: adding a gate to `ExtendedGateId`
 * without implementing it is then a compile error rather than a gate that
 * silently never runs. Evaluation order comes from `GATE_ORDER`.
 */
export const GATES: Readonly<Record<ExtendedGateId, Gate>> = {
  G01_schema: g01Schema,
  G02_length: g02Length,
  G03_placeholders: g03Placeholders,
  G04_merchant_name: g04MerchantName,
  G05_evidence_grounding: g05EvidenceGrounding,
  G06_no_invented_numbers: g06NoInventedNumbers,
  G07_banned_claims: g07BannedClaims,
  G08_pii: g08Pii,
  G09_locale: g09Locale,
  G10_single_cta: g10SingleCta,
  G11_frequency_cap: g11FrequencyCap,
  G12_compliance: g12Compliance,
  G13_claim_count: g13ClaimCount,
};

export interface RunGatesOptions {
  /**
   * Monotonic milliseconds, for measuring the run. Injectable so a test can
   * assert on `durationMs` without asserting on how fast the machine is.
   */
  monotonicNowMs?: () => number;
}

export function runGates(
  draft: OutreachDraft,
  merchant: Merchant,
  context: GateContext,
  options: RunGatesOptions = {},
): ExtendedGateReport {
  const clock = options.monotonicNowMs ?? (() => performance.now());
  const startedAt = clock();

  const outcomes: ExtendedGateOutcome[] = GATE_ORDER.map((gate) =>
    GATES[gate](draft, merchant, context),
  );

  const durationMs = Math.max(0, Math.round(clock() - startedAt));

  return {
    draftId: draft.id,
    outcomes,
    blocked: outcomes.some((outcome) => !outcome.passed && outcome.severity === "blocking"),
    evaluatedAt: context.now,
    durationMs,
  };
}

/** The blocking gates that failed, in evaluation order. */
export function blockingFailures(report: ExtendedGateReport): ExtendedGateId[] {
  return report.outcomes
    .filter((outcome) => !outcome.passed && outcome.severity === "blocking")
    .map((outcome) => outcome.gate);
}

/** The warning gates that failed. These do not stop a send. */
export function warningFailures(report: ExtendedGateReport): ExtendedGateId[] {
  return report.outcomes
    .filter((outcome) => !outcome.passed && outcome.severity === "warning")
    .map((outcome) => outcome.gate);
}

/** G13 is this service's own; every other gate is in the frozen contract. */
function isContractGate(gate: ExtendedGateId): gate is GateId {
  return gate !== G13_CLAIM_COUNT;
}

/**
 * The report as the contract defines it, with this service's extra gate
 * dropped.
 *
 * Use it at the edges — persistence, the API, anything the dashboard reads —
 * so that `shared/contracts.ts` stays the whole truth about what crosses a
 * service boundary. `blocked` is carried over unchanged rather than
 * recomputed, because it is a fact about the run, and G13 cannot have
 * contributed to it: it only ever warns.
 */
export function toContractReport(report: ExtendedGateReport): GateReport {
  const outcomes: GateOutcome[] = report.outcomes
    .filter((outcome) => isContractGate(outcome.gate))
    .map((outcome) => ({ ...outcome, gate: outcome.gate as GateId }));

  return { ...report, outcomes };
}
