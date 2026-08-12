import { Service } from "encore.dev/service";

/**
 * Human approval queue and the outreach state machine. Every state
 * transition goes through this service — there is no other way to move
 * an attempt forward.
 *
 * Owns: `outreach_attempts`.
 */
export default new Service("approval");
