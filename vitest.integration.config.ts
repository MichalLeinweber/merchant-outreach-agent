import { defineConfig } from "vitest/config";

/**
 * The integration suite: the tests that need Postgres.
 *
 * Kept in a separate config from `vitest.config.ts` because the two cannot be
 * run the same way. The unit suite runs anywhere, on `npm test`, and never
 * touches a database — importing `shared/db.ts` outside the Encore runtime
 * throws at module load, so the split is enforced by more than convention.
 * This suite only runs under `encore test`, which provisions the database and
 * applies the migrations first.
 */
export default defineConfig({
  test: {
    include: ["services/**/*.integration.test.ts"],
    environment: "node",
    // One database, shared by every file: running them in parallel would make
    // "how many rows are SENT" a question about scheduling.
    fileParallelism: false,
    // Provisioning and migrating the test database happens before the first
    // test, and the concurrency tests deliberately wait on row locks.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
