import { Service } from "encore.dev/service";

/**
 * Outbox worker, mock delivery provider and idempotency handling.
 *
 * Owns: `outbox`.
 */
export default new Service("sender");
