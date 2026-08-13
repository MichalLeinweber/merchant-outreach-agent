/**
 * Ingest against a real database.
 *
 * This file exists because of one defect that no unit test could have caught.
 * `enrichments.signals` is `JSONB` with a `CHECK (jsonb_typeof(signals) =
 * 'array')`, and the insert bound the signals with `${JSON.stringify(...)}::jsonb`.
 * The Encore driver binds a JS string as a jsonb value in its own right, so
 * that stored the JSON *text* as a jsonb string rather than parsing it into an
 * array — and the constraint rejected the whole batch.
 *
 * The unit suite typechecks that SQL and never runs it, which is exactly the
 * gap `CLAUDE.md` warns about: a green `verify` means the code compiles, not
 * that an endpoint which talks to Postgres works.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { Merchant } from "../../shared/contracts.js";
import { db } from "../../shared/db.js";
import { resetOutreachTables } from "../../shared/test-db.js";
import { sampleMerchant } from "../gates/test-helpers.js";
import { deriveSignals } from "./enrich.js";
import { getMerchant, ingestMerchants } from "./ingest.js";

beforeEach(async () => {
  await resetOutreachTables();
});

function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return sampleMerchant({ id: "mch_integration_001", ...overrides });
}

describe("ingesting a batch", () => {
  it("stores the derived signals as a JSON array", async () => {
    const one = merchant();

    const response = await ingestMerchants({ merchants: [one] });

    expect(response.inserted).toBe(1);
    expect(response.signalsWritten).toBe(
      deriveSignals(one, { now: new Date(response.enrichedAt) }).length,
    );

    // The column the constraint is about. A jsonb string would satisfy the
    // type and fail `enrichments_signals_is_array`; this is the assertion
    // that tells the two apart.
    const stored = await db.queryRow<{ kind: string; count: number }>`
      SELECT jsonb_typeof(signals) AS kind, jsonb_array_length(signals) AS count
      FROM enrichments WHERE merchant_id = ${one.id}
    `;
    expect(stored?.kind).toBe("array");
    expect(stored?.count).toBe(response.signalsWritten);
  });

  it("reads the merchant back with its signals", async () => {
    const one = merchant();
    await ingestMerchants({ merchants: [one] });

    const read = await getMerchant({ id: one.id });

    expect(read.name).toBe(one.name);
    // Round-tripped through JSONB and back into the contract's shape: every
    // signal still points at a real Merchant field.
    expect(read.signals.length).toBeGreaterThan(0);
    for (const signal of read.signals) {
      expect(Object.keys(one)).toContain(signal.sourceField);
    }
  });

  it("re-ingests the same merchant without duplicating anything", async () => {
    const one = merchant();
    await ingestMerchants({ merchants: [one] });
    const second = await ingestMerchants({ merchants: [{ ...one, city: "Sheffield" }] });

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await db.queryRow<{ merchants: number; enrichments: number }>`
      SELECT (SELECT COUNT(*)::int FROM merchants) AS merchants,
             (SELECT COUNT(*)::int FROM enrichments) AS enrichments
    `;
    expect(rows).toEqual({ merchants: 1, enrichments: 1 });
  });

  it("writes nothing when one merchant in the batch is invalid", async () => {
    await expect(
      ingestMerchants({
        merchants: [merchant(), merchant({ id: "mch_integration_002", contactEmail: "real@gmail.com" })],
      }),
    ).rejects.toThrow(/contactEmail/);

    const count = await db.queryRow<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM merchants
    `;
    expect(count?.count).toBe(0);
  });
});
