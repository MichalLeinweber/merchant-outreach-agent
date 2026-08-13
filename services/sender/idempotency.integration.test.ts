/**
 * The five idempotency tests.
 *
 * `docs/idempotency.md` ends with a list of five things that must be true, and
 * the sentence that matters: without these tests the document is a claim
 * rather than a demonstration. Each `describe` below is one item from that
 * list, in order.
 *
 * They run against real Postgres, because every one of them is about
 * something only the database can do — a partial unique index, `SKIP LOCKED`,
 * a transaction. Run them with:
 *
 *     npm run test:integration      # encore test --config vitest.integration.config.ts
 *
 * `npm test` deliberately does not include this file. The unit suite runs
 * without infrastructure, and a test that silently skips when the database is
 * missing would be worse than no test: the suite would stay green while
 * proving nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../shared/db.js";
import { resetOutreachTables } from "../../shared/test-db.js";
import { approve } from "../approval/approval.js";
import {
  countRows,
  expireClaim,
  readAttempt,
  readOutboxRows,
  seedAttempt,
} from "../approval/test-db.js";
import { deliverClaimedRow } from "./delivery.js";
import { MockDeliveryProvider } from "./provider.js";
import { claimNextOutboxRow, recordTickResult, runOutboxWorkerOnce } from "./worker.js";

/** Retries must not actually wait; the backoff itself is covered in retry.test.ts. */
const NO_WAITING = { retry: { sleep: async () => {} } };

beforeEach(async () => {
  await resetOutreachTables();
});

// ─── 1 ─────────────────────────────────────────────────────────

describe("1. approve called twice concurrently", () => {
  it("produces one attempt and one outbox row", async () => {
    const seeded = await seedAttempt();

    // Fired together, not awaited in turn: sequential calls would test
    // nothing, because the race is the point.
    const [first, second] = await Promise.all([
      approve({ id: seeded.attemptId, approvedBy: "michal" }),
      approve({ id: seeded.attemptId, approvedBy: "lukas" }),
    ]);

    expect(await countRows("outreach_attempts")).toBe(1);
    expect(await countRows("outbox")).toBe(1);

    // Both callers get the same attempt back; exactly one of them changed it.
    expect(first.attempt.id).toBe(seeded.attemptId);
    expect(second.attempt.id).toBe(seeded.attemptId);
    expect([first.alreadyApplied, second.alreadyApplied].filter(Boolean)).toHaveLength(1);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("QUEUED");
    // One approver won, and the audit trail records that one rather than a
    // blend of the two.
    expect(["michal", "lukas"]).toContain(attempt.approved_by);

    const [outbox] = await readOutboxRows();
    expect(outbox?.idempotency_key).toBe(seeded.dedupKey);
  });

  it("refuses to approve an attempt that is not pending", async () => {
    const seeded = await seedAttempt({ state: "BLOCKED" });

    // The conflict half of "zero rows changed": a duplicate click is success,
    // a blocked attempt is an error, and the two must not look the same.
    await expect(approve({ id: seeded.attemptId, approvedBy: "michal" })).rejects.toThrow(
      /is BLOCKED and cannot be approved/,
    );
    expect(await countRows("outbox")).toBe(0);
  });
});

// ─── 2 ─────────────────────────────────────────────────────────

describe("2. two workers against one outbox", () => {
  it("processes every row exactly once", async () => {
    const seeded = [];
    for (let i = 0; i < 6; i += 1) {
      const attempt = await seedAttempt({ body: `Body variant ${i}. ${loremBody()}` });
      await approve({ id: attempt.attemptId, approvedBy: "michal" });
      seeded.push(attempt);
    }

    const provider = new MockDeliveryProvider();
    const deps = { provider, ...NO_WAITING };

    const drain = async () => {
      const results = [];
      for (;;) {
        const result = await runOutboxWorkerOnce(deps);
        if (result.status === "idle") return results;
        results.push(result);
      }
    };

    // Two workers, same outbox, at the same time.
    const [left, right] = await Promise.all([drain(), drain()]);

    // No row was handled twice: six rows, six results between the two
    // workers, six distinct messages at the provider. `SKIP LOCKED` is what
    // makes that true — with a plain `FOR UPDATE` the second worker would
    // block and then claim the row the first one already had.
    const handled = [...left, ...right];
    const sent = handled.filter((result) => result.status === "sent");
    expect(handled).toHaveLength(6);
    expect(sent).toHaveLength(6);
    expect(new Set(sent.map((result) => result.rowId)).size).toBe(6);
    expect(provider.deliveredCount()).toBe(6);

    const rows = await readOutboxRows();
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.processed_at).not.toBeNull();
      // Claimed once each: a second claim would mean two workers had it.
      expect(row.attempt_count).toBe(1);
    }

    for (const attempt of seeded) {
      expect((await readAttempt(attempt.attemptId)).state).toBe("SENT");
    }
  });
});

// ─── 3 ─────────────────────────────────────────────────────────

describe("3. worker killed after sending, then restarted", () => {
  it("delivers one message across two requests and ends SENT", async () => {
    const seeded = await seedAttempt();
    await approve({ id: seeded.attemptId, approvedBy: "michal" });

    const provider = new MockDeliveryProvider();
    const deps = { provider, ...NO_WAITING };

    // The crash: claim, deliver, and die before recording anything.
    const claimed = await claimNextOutboxRow();
    expect(claimed).not.toBeNull();
    const delivered = await deliverClaimedRow(claimed!, deps);
    expect(delivered.status).toBe("sent");
    expect(provider.deliveredCount()).toBe(1);

    // Nothing was written, so the attempt is still queued and the row is
    // still claimed. Only the clock releases it.
    expect((await readAttempt(seeded.attemptId)).state).toBe("QUEUED");
    expect(await runOutboxWorkerOnce(deps)).toEqual({ status: "idle" });

    await expireClaim(claimed!.id, 6);

    const second = await runOutboxWorkerOnce(deps);

    // The provider was asked twice and sent once: the claim timeout brought
    // the row back, and the idempotency key made the redelivery a lookup.
    // Neither alone is enough — without the timeout the message is stuck
    // forever, without the key it goes out twice.
    expect(second).toMatchObject({ status: "sent", deduplicated: true });
    expect(provider.currentStats().requests).toBe(2);
    expect(provider.deliveredCount()).toBe(1);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("SENT");
    expect(attempt.provider_message_id).toBe(provider.messages()[0]?.messageId);

    const [row] = await readOutboxRows();
    expect(row?.processed_at).not.toBeNull();
    expect(row?.attempt_count).toBe(2);
  });
});

// ─── 4 ─────────────────────────────────────────────────────────

describe("4. provider times out, then succeeds", () => {
  it("writes SENT once with the receipt from the first acceptance", async () => {
    const seeded = await seedAttempt();
    await approve({ id: seeded.attemptId, approvedBy: "michal" });

    const provider = new MockDeliveryProvider();
    provider.scheduleOutcomes("timeout_but_accepted");

    const result = await runOutboxWorkerOnce({ provider, ...NO_WAITING });

    expect(result).toMatchObject({ status: "sent", deduplicated: true });
    expect(provider.deliveredCount()).toBe(1);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("SENT");
    // The receipt from the call that was actually accepted, not a new one.
    expect(attempt.provider_message_id).toBe(provider.messages()[0]?.messageId);

    const sentRows = await db.queryRow<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM outreach_attempts
       WHERE merchant_id = ${seeded.merchantId} AND campaign_id = ${seeded.campaignId}
         AND state = 'SENT'
    `;
    expect(sentRows?.count).toBe(1);
  });

  it("records FAILED and leaves the row for a later claim when delivery gives up", async () => {
    const seeded = await seedAttempt();
    await approve({ id: seeded.attemptId, approvedBy: "michal" });

    const provider = new MockDeliveryProvider({ failureRate: 1 });
    const result = await runOutboxWorkerOnce({ provider, ...NO_WAITING });

    expect(result.status).toBe("failed");
    expect(provider.deliveredCount()).toBe(0);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("FAILED");
    expect(attempt.failure_reason).toContain("simulated failure");

    const [row] = await readOutboxRows();
    // Not processed, and still claimed: the row comes back when the claim
    // expires, which throttles a permanently failing message instead of
    // spinning on it.
    expect(row?.processed_at).toBeNull();
    expect(row?.claimed_at).not.toBeNull();
    expect(row?.last_error).toContain("simulated failure");
  });

  it("sends a FAILED attempt on the retry, the long way round", async () => {
    const seeded = await seedAttempt();
    await approve({ id: seeded.attemptId, approvedBy: "michal" });

    const provider = new MockDeliveryProvider();
    provider.scheduleOutcomes("fail", "fail", "fail", "fail", "fail");
    expect((await runOutboxWorkerOnce({ provider, ...NO_WAITING })).status).toBe("failed");
    expect((await readAttempt(seeded.attemptId)).state).toBe("FAILED");

    const [failedRow] = await readOutboxRows();
    await expireClaim(failedRow!.id, 6);

    const second = await runOutboxWorkerOnce({ provider, ...NO_WAITING });

    // The attempt was FAILED, and FAILED -> SENT is not an edge in the table.
    // The retry goes FAILED -> QUEUED -> SENT inside one transaction, which
    // is also what makes the second delivery attempt visible in the count.
    expect(second.status).toBe("sent");
    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("SENT");
    expect(attempt.attempt_count).toBe(2);
    expect(attempt.failure_reason).toBeNull();
  });
});

// ─── 5 ─────────────────────────────────────────────────────────

describe("5. a second SENT row for the same merchant and campaign", () => {
  it("is rejected by the partial unique index, not by application code", async () => {
    const first = await seedAttempt();
    await approve({ id: first.attemptId, approvedBy: "michal" });
    await runOutboxWorkerOnce({ provider: new MockDeliveryProvider(), ...NO_WAITING });
    expect((await readAttempt(first.attemptId)).state).toBe("SENT");

    // A second attempt at the same merchant in the same campaign. Different
    // text, so `uq_attempt_dedup` has no opinion about it.
    const second = await seedAttempt({
      merchantId: first.merchantId,
      campaignId: first.campaignId,
      subject: "A second, entirely different subject line",
      body: loremBody(),
    });

    // Straight to SQL, bypassing every line of application code: no state
    // machine, no service, no review. This is the proof that "a message
    // cannot be sent twice" is a property of the schema rather than of our
    // discipline.
    await expect(
      db.exec`
        UPDATE outreach_attempts
           SET state = 'SENT', sent_at = NOW(), provider_message_id = 'msg_forged',
               approved_by = 'nobody', approved_at = NOW()
         WHERE id = ${second.attemptId}
      `,
    ).rejects.toThrow(/uq_attempt_sent/);

    expect((await readAttempt(second.attemptId)).state).toBe("PENDING_APPROVAL");
  });

  it("stops the worker too, rather than letting it swallow the violation", async () => {
    const first = await seedAttempt();
    await approve({ id: first.attemptId, approvedBy: "michal" });
    await runOutboxWorkerOnce({ provider: new MockDeliveryProvider(), ...NO_WAITING });

    // A second attempt, queued the normal way, whose delivery would produce a
    // second SENT row for the pair.
    const second = await seedAttempt({
      merchantId: first.merchantId,
      campaignId: first.campaignId,
      subject: "A second, entirely different subject line",
      body: loremBody(),
    });
    await approve({ id: second.attemptId, approvedBy: "michal" });

    const provider = new MockDeliveryProvider();
    const claimed = await claimNextOutboxRow();
    const delivered = await deliverClaimedRow(claimed!, { provider, ...NO_WAITING });

    // The index fires inside the transaction, so the error surfaces instead
    // of being caught: the outbox row stays unprocessed and a human has to
    // look at it. Swallowing it here is what would turn the one thing the
    // database can prove into something application code decides.
    await expect(recordTickResult(claimed!, delivered)).rejects.toThrow(/uq_attempt_sent/);

    expect((await readAttempt(second.attemptId)).state).toBe("QUEUED");
    const rows = await readOutboxRows();
    expect(rows.find((row) => row.attempt_id === second.attemptId)?.processed_at).toBeNull();
  });
});

/** Filler long enough to satisfy the length gate, for tests that need new content. */
function loremBody(): string {
  return [
    "Hi there,",
    "",
    "We work with independent venues in your city and help them fill the quiet " +
      "sessions of the week without discounting the ones that already sell out. " +
      "If that is useful, register your interest using the link below and someone " +
      "from the team will follow up with the detail.",
    "",
    "Best regards,",
    "The partnerships team",
  ].join("\n");
}
