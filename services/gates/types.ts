/**
 * Gate types, metadata and the extension point for gates that live outside
 * the frozen contract.
 *
 * `shared/contracts.ts` defines `GateId` as a closed union of twelve gates and
 * does not change on a feature branch. G13 is a thirteenth check this
 * workstream adds, so it is declared here as a widening of the contract type
 * rather than an edit to it. Everything that has to cross a service boundary
 * can be narrowed back to the contract shape with `toContractReport`.
 */

import type {
  GateId,
  GateOutcome,
  GateReport,
  GateSeverity,
  Merchant,
  OutreachDraft,
  TextSpan,
} from "../../shared/contracts.js";

// ─── The extension ─────────────────────────────────────────────

/**
 * Number of personalized claims. The draft prompt mandates exactly three;
 * until now nothing checked that it happened.
 *
 * A warning rather than a blocking gate, because an empty `evidence` array is
 * a legitimate answer: when a merchant record has nothing solid to quote, the
 * prompt tells the model to write a plain message and claim nothing. Blocking
 * on the count would punish exactly the case the pipeline gets right.
 */
export const G13_CLAIM_COUNT = "G13_claim_count";

export type ExtendedGateId = GateId | typeof G13_CLAIM_COUNT;

/** `GateOutcome`, widened to allow a gate that is not in the contract. */
export interface ExtendedGateOutcome extends Omit<GateOutcome, "gate"> {
  gate: ExtendedGateId;
}

/** `GateReport`, carrying the widened outcomes. */
export interface ExtendedGateReport extends Omit<GateReport, "outcomes"> {
  outcomes: ExtendedGateOutcome[];
}

// ─── What a gate is given ──────────────────────────────────────

/** A previous approach to this merchant, from any campaign. */
export interface PreviousApproach {
  campaignId: string;
  /** ISO-8601 instant the message was sent. */
  sentAt: string;
}

/**
 * Everything a gate needs that is neither the draft nor the merchant record.
 *
 * `now` is passed in rather than read from the clock. Gates are pure
 * functions: the same three arguments must always produce the same outcome,
 * or a draft that passes today fails in five months for no reason anybody can
 * reconstruct. The frequency cap is the gate that would otherwise drift.
 */
export interface GateContext {
  /** ISO-8601 instant the gates are being evaluated at. */
  now: string;
  /** How many days must pass before the same merchant may be approached again. */
  frequencyCapDays: number;
  /** The most recent send to this merchant, or null if there has been none. */
  previousApproach: PreviousApproach | null;
  /**
   * Hosts the campaign may legitimately link to or send from. Anything else
   * in the body is contact data the source record does not contain.
   */
  allowedLinkHosts: readonly string[];
}

export const DEFAULT_FREQUENCY_CAP_DAYS = 30;

/**
 * The marketplace's own hosts. Synthetic, like everything else in this repo.
 *
 * Deliberately narrow. `example.invalid` is the suffix every address in this
 * dataset ends with, so listing it here would — via the subdomain rule in G08
 * — make every invented mailbox and every invented link legitimate. The
 * merchant's own address and website are permitted by name from the record;
 * this list is only for the campaign's own host.
 */
export const DEFAULT_ALLOWED_LINK_HOSTS: readonly string[] = ["partners.example.invalid"];

/** A context with the documented defaults. Pure — `now` is still the caller's. */
export function makeGateContext(
  now: string,
  overrides: Partial<Omit<GateContext, "now">> = {},
): GateContext {
  return {
    now,
    frequencyCapDays: DEFAULT_FREQUENCY_CAP_DAYS,
    previousApproach: null,
    allowedLinkHosts: DEFAULT_ALLOWED_LINK_HOSTS,
    ...overrides,
  };
}

/**
 * A gate.
 *
 * The merchant is typed as `Merchant`, not `EnrichedMerchant`, on purpose.
 * `EnrichedMerchant.signals` are derived text — a gate that grounded a claim
 * against a signal would be checking the model's output against another
 * generated string. Narrowing the parameter makes that mistake unavailable
 * rather than merely discouraged; an enriched merchant can still be passed in,
 * because it is a `Merchant`.
 */
export type Gate = (
  draft: OutreachDraft,
  merchant: Merchant,
  context: GateContext,
) => ExtendedGateOutcome;

// ─── Metadata ──────────────────────────────────────────────────

/** Every gate, in evaluation order. */
export const GATE_ORDER = [
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
  G13_CLAIM_COUNT,
] as const satisfies readonly ExtendedGateId[];

/*
 * Compile-time proof that the list above covers every contract gate. `satisfies`
 * proves each entry is a real gate id; this proves the reverse. A gate added to
 * the contract stops this file compiling instead of silently never running.
 */
type UncoveredGate = Exclude<ExtendedGateId, (typeof GATE_ORDER)[number]>;
const _everyGateIsCovered: UncoveredGate extends never ? true : never = true;
void _everyGateIsCovered;

/**
 * Whether a gate stops the send or only annotates it.
 *
 * These follow the table in EVALS.md, which is the specification. G10 is the
 * only contract gate that warns: a second call to action is a quality problem,
 * not a compliance one.
 */
export const GATE_SEVERITY: Record<ExtendedGateId, GateSeverity> = {
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
  G13_claim_count: "warning",
};

export const GATE_LABELS: Record<ExtendedGateId, string> = {
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
  G13_claim_count: "Claim count",
};

// ─── Building outcomes ─────────────────────────────────────────

/** A passing outcome. `detail` is empty when a gate passes, per the contract. */
export function pass(gate: ExtendedGateId): ExtendedGateOutcome {
  return { gate, severity: GATE_SEVERITY[gate], passed: true, detail: "" };
}

/**
 * A failing outcome.
 *
 * `spans` is omitted rather than set to `[]` when there is nothing to point
 * at, so "no offsets" and "offsets not applicable" do not look the same to the
 * interface. G01 and G11 genuinely have nothing to highlight.
 */
export function fail(
  gate: ExtendedGateId,
  detail: string,
  spans: TextSpan[] = [],
): ExtendedGateOutcome {
  const outcome: ExtendedGateOutcome = {
    gate,
    severity: GATE_SEVERITY[gate],
    passed: false,
    detail,
  };
  if (spans.length > 0) outcome.spans = spans;
  return outcome;
}
