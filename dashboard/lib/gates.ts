import type { GateId, GateOutcome, GateReport, GateSeverity } from "./contracts";

/**
 * Gate metadata and the small amount of logic that turns a `GateReport` into
 * something a strip of twelve segments can render.
 *
 * The contract defines `GateId` as a union of type-level strings. A union has
 * no order and no labels, and the strip needs both — so they live here, typed
 * against the contract so they cannot drift from it silently.
 */

/** Every gate, in evaluation order. G01 runs first, G12 last. */
export const GATE_IDS = [
  "G01_schema",
  "G02_length",
  "G03_placeholders",
  "G04_merchant_name",
  "G05_evidence_grounding",
  "G06_no_invented_numbers",
  "G07_banned_claims",
  "G08_pii",
  "G09_locale",
  "G10_single_cta",
  "G11_frequency_cap",
  "G12_compliance",
] as const satisfies readonly GateId[];

/*
 * Compile-time assertion that the list above is exhaustive. `satisfies` proves
 * every entry is a real `GateId`; this proves the reverse — that no `GateId`
 * was left out. Add a thirteenth gate to the contract and this line stops
 * compiling, which is the entire point of it.
 */
type UncoveredGate = Exclude<GateId, (typeof GATE_IDS)[number]>;
const _everyGateIsCovered: UncoveredGate extends never ? true : never = true;
void _everyGateIsCovered;

/**
 * Human-readable gate names. Typed as a total `Record`, so a new gate in the
 * contract is a compile error here rather than a blank label in the UI.
 */
export const GATE_LABELS: Record<GateId, string> = {
  G01_schema: "Schema",
  G02_length: "Length",
  G03_placeholders: "Placeholders",
  G04_merchant_name: "Merchant name",
  G05_evidence_grounding: "Evidence grounding",
  G06_no_invented_numbers: "No invented numbers",
  G07_banned_claims: "Banned claims",
  G08_pii: "PII",
  G09_locale: "Locale",
  G10_single_cta: "Single CTA",
  G11_frequency_cap: "Frequency cap",
  G12_compliance: "Compliance",
};

/**
 * Whether a gate blocks the send or only warns.
 *
 * Severity belongs to the gate, not to the occurrence: an ungrounded claim
 * stops the send every time it happens, and a second call to action is a
 * quality problem every time it happens. The contract carries `severity` on
 * each outcome so the backend can state it per result; this map is what the
 * dashboard's fixtures state it from.
 *
 * These follow the gate table in EVALS.md, which is the specification and the
 * same source the `gates` service implements from. They were wrong here until
 * the gates were built: written against mocks before there was an
 * implementation to check them against, this map had G02 and G09 warning and
 * G10 blocking — the exact reverse of the spec on all three. A draft running
 * long was shown as survivable and a second call to action as fatal, which is
 * backwards in the direction that matters: length is cosmetic, and a draft in
 * the wrong language is not.
 */
export const GATE_SEVERITY: Record<GateId, GateSeverity> = {
  G01_schema: "blocking",
  G02_length: "blocking",
  G03_placeholders: "blocking",
  G04_merchant_name: "blocking",
  G05_evidence_grounding: "blocking",
  G06_no_invented_numbers: "blocking",
  G07_banned_claims: "blocking",
  G08_pii: "blocking",
  G09_locale: "blocking",
  G10_single_cta: "warning",
  G11_frequency_cap: "blocking",
  G12_compliance: "blocking",
};

/** The short code a person reads off the strip: "G05". */
export function gateCode(gate: GateId): string {
  return gate.slice(0, 3);
}

/**
 * What a single segment shows.
 *
 * `pending` is a real state, not a placeholder for missing data: gates are
 * evaluated in order, and a draft caught mid-run genuinely has gates that have
 * not been reached yet. It is drawn as an outline, per DESIGN.md.
 */
export type GateSegmentState = "pass" | "fail" | "warn" | "pending";

export function gateSegmentState(outcome: GateOutcome | undefined): GateSegmentState {
  if (outcome === undefined) return "pending";
  if (outcome.passed) return "pass";
  // A failed gate is red when it blocks the send and amber when it only warns.
  // That distinction is the whole reason `GateSeverity` exists.
  return outcome.severity === "blocking" ? "fail" : "warn";
}

/** Indexes a report's outcomes by gate, for O(1) lookup while rendering. */
export function outcomesByGate(report: GateReport): Map<GateId, GateOutcome> {
  return new Map(report.outcomes.map((outcome) => [outcome.gate, outcome]));
}

/**
 * The first blocking gate that failed, or null. This is what the queue filters
 * on and what the row summarises — when a draft is blocked, the operator wants
 * to know which check stopped it before anything else.
 */
export function blockingGate(report: GateReport): GateId | null {
  for (const gate of GATE_IDS) {
    const outcome = report.outcomes.find((candidate) => candidate.gate === gate);
    if (outcome && !outcome.passed && outcome.severity === "blocking") return gate;
  }
  return null;
}

/** Gates that failed with warning severity. These do not stop a send. */
export function warningGates(report: GateReport): GateId[] {
  return GATE_IDS.filter((gate) => {
    const outcome = report.outcomes.find((candidate) => candidate.gate === gate);
    return outcome !== undefined && !outcome.passed && outcome.severity === "warning";
  });
}
