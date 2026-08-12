import { Service } from "encore.dev/service";

/**
 * LLM-backed agents: triage and draft, plus the shared model client,
 * escalation routing and cost accounting.
 *
 * Owns: `triage_results`, `drafts`, `llm_calls`.
 */
export default new Service("agents");
