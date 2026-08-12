/**
 * Load a generated merchant file into a running application.
 *
 *   npm run seed                      # generate, then load into localhost:4000
 *   node scripts/seed-merchants.ts --url http://127.0.0.1:4000
 *
 * It talks to the ingest endpoint over HTTP rather than writing to Postgres
 * directly. That is deliberate: seeding then goes through the same
 * validation, the same transaction and the same enrichment as any other
 * caller, so a seeded database cannot contain anything the API would have
 * rejected.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Merchant } from "../shared/contracts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_FILE = path.join(REPO_ROOT, "fixtures", "merchants", "seed-200.json");
const DEFAULT_BASE_URL = "http://127.0.0.1:4000";

/**
 * Kept below MAX_BATCH_SIZE in services/ingest/validation.ts. Not imported
 * from there on purpose — this script runs on plain Node, outside the Encore
 * application, and importing service code would drag the runtime in with it.
 */
const CHUNK_SIZE = 200;

interface SeedResponse {
  received: number;
  inserted: number;
  updated: number;
  signalsWritten: number;
}

interface CliOptions {
  filePath: string;
  baseUrl: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    filePath: DEFAULT_FILE,
    baseUrl: process.env.INGEST_BASE_URL ?? DEFAULT_BASE_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag !== "--file" && flag !== "--url") {
      throw new Error(
        `Unknown argument "${String(flag)}". Usage: node scripts/seed-merchants.ts ` +
          `[--file <json>] [--url <base-url>]`,
      );
    }
    if (value === undefined) {
      throw new Error(`${flag} needs a value.`);
    }
    index += 1;

    if (flag === "--file") {
      options.filePath = path.resolve(value);
    } else {
      options.baseUrl = value.replace(/\/+$/, "");
    }
  }

  return options;
}

async function readMerchants(filePath: string): Promise<Merchant[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No merchant file at ${filePath}. Generate one first:  npm run generate:merchants`,
      );
    }
    throw cause;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${filePath} does not hold a non-empty array of merchants.`);
  }
  return parsed as Merchant[];
}

async function postChunk(baseUrl: string, chunk: readonly Merchant[]): Promise<SeedResponse> {
  const url = `${baseUrl}/ingest/merchants`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchants: chunk }),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach ${url}. Is the application running?  encore run\n` +
        `Original error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    // The endpoint reports every problem in the batch; pass it through whole
    // rather than summarising it away.
    throw new Error(`POST ${url} failed with ${response.status}:\n${body}`);
  }

  return JSON.parse(body) as SeedResponse;
}

async function main(argv: readonly string[]): Promise<void> {
  const { filePath, baseUrl } = parseArgs(argv);
  const merchants = await readMerchants(filePath);

  console.log(`Seeding ${merchants.length} merchants from ${filePath} into ${baseUrl}`);

  const totals: SeedResponse = { received: 0, inserted: 0, updated: 0, signalsWritten: 0 };

  for (let start = 0; start < merchants.length; start += CHUNK_SIZE) {
    const chunk = merchants.slice(start, start + CHUNK_SIZE);
    const result = await postChunk(baseUrl, chunk);

    totals.received += result.received;
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.signalsWritten += result.signalsWritten;
  }

  console.log(
    `Done: ${totals.received} received, ${totals.inserted} inserted, ` +
      `${totals.updated} updated, ${totals.signalsWritten} signals stored.`,
  );
}

await main(process.argv.slice(2));
