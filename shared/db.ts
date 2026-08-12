import { SQLDatabase } from "encore.dev/storage/sqldb";

/**
 * The single `outreach` database.
 *
 * One database, but table ownership is strict: each service reads and writes
 * only the tables listed in its `encore.service.ts` docblock, and reaches
 * anything else through the owning service's API. The database does not
 * enforce that boundary — the services do.
 *
 * Encore provisions, migrates and monitors this from the declaration below.
 * There is no connection string to configure and no migration runner to wire
 * up; that is the whole point of declaring infrastructure in code.
 */
export const db = new SQLDatabase("outreach", {
  migrations: "./migrations",
});
