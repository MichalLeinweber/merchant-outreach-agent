import { Service } from "encore.dev/service";

/**
 * Deterministic quality gates G01-G12 and the gate runner.
 *
 * Owns: `gate_reports`.
 */
export default new Service("gates");
