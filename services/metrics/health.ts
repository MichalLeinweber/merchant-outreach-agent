import { api } from "encore.dev/api";
import { db } from "../../shared/db.js";

export interface HealthResponse {
  status: "ok";
  /** Round-trip to Postgres, so a green check means the database is really reachable. */
  databaseReachable: boolean;
  /** Which LLM mode the process is configured for: live, record or fixture. */
  llmMode: string;
}

/**
 * Application health check.
 *
 * Lives in `metrics` because that service already exists to answer questions
 * about the system as a whole rather than to own part of the pipeline.
 */
export const health = api(
  { expose: true, method: "GET", path: "/health" },
  async (): Promise<HealthResponse> => {
    const row = await db.queryRow<{ ok: number }>`SELECT 1 AS ok`;

    return {
      status: "ok",
      databaseReachable: row?.ok === 1,
      llmMode: process.env.LLM_MODE ?? "fixture",
    };
  },
);
