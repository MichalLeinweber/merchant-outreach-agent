/**
 * The gates service, as seen from outside.
 *
 * Callers want `runGates` and the types around it. The individual gates are
 * exported too, because the eval suite scores them one at a time.
 */

export {
  DEFAULT_ALLOWED_LINK_HOSTS,
  DEFAULT_FREQUENCY_CAP_DAYS,
  G13_CLAIM_COUNT,
  GATE_LABELS,
  GATE_ORDER,
  GATE_SEVERITY,
  makeGateContext,
  type ExtendedGateId,
  type ExtendedGateOutcome,
  type ExtendedGateReport,
  type Gate,
  type GateContext,
  type PreviousApproach,
} from "./types.js";

export {
  blockingFailures,
  GATES,
  runGates,
  toContractReport,
  warningFailures,
  type RunGatesOptions,
} from "./runner.js";

export { g01Schema, g02Length, g03Placeholders } from "./structure.js";
export { g04MerchantName, g08Pii } from "./identity.js";
export { g05EvidenceGrounding, g06NoInventedNumbers } from "./grounding.js";
export { g07BannedClaims, g10SingleCta, g12Compliance } from "./content.js";
export { g09Locale } from "./language.js";
export { g11FrequencyCap } from "./frequency.js";
export { g13ClaimCount, REQUIRED_CLAIM_COUNT } from "./claims.js";

export { BODY_MAX_WORDS, BODY_MIN_WORDS, SUBJECT_MAX_LENGTH } from "./structure.js";
