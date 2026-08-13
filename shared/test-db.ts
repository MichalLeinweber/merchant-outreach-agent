/**
 * Shared setup for the integration suite.
 *
 * Only the part every integration test needs: emptying the database between
 * tests. Anything that builds domain rows belongs to the service that owns
 * those tables, not here.
 *
 * Not a test file — vitest only collects `*.test.ts`, and this must not be
 * collected. It is also not importable from the unit suite: it reaches
 * `shared/db.ts`, which throws on import when the Encore runtime is absent.
 */

import { db } from "./db.js";

/**
 * Empty every table the outreach pipeline writes.
 *
 * Between tests rather than after them: a test that fails leaves its rows
 * behind, and being able to look at them is worth more than a tidy database.
 *
 * `DELETE`, not `TRUNCATE`. Encore grants the application user the rights it
 * needs to run the application, and truncating a table is not one of them —
 * that requires ownership. Deleting the merchants is enough anyway: every
 * other table hangs off them by `ON DELETE CASCADE`, down through drafts to
 * gate reports and through attempts to the outbox. `llm_calls` has no foreign
 * key, so it is cleared on its own.
 */
export async function resetOutreachTables(): Promise<void> {
  await db.exec`DELETE FROM merchants`;
  await db.exec`DELETE FROM llm_calls`;
}
