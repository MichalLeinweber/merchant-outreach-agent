/**
 * The approval endpoints against a real database.
 *
 * The five tests in `sender/idempotency.integration.test.ts` cover the
 * concurrency guarantees. These cover the two decisions that only exist here:
 * a rejection, and an edit — which is the one path that changes content, and
 * therefore the one that has to recompute the dedup key and run the gates
 * again.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../shared/db.js";
import { resetOutreachTables } from "../../shared/test-db.js";
import { PASSING_BODY } from "../gates/test-helpers.js";
import { editAndApprove, reject } from "./approval.js";
import { computeDedupKey } from "./dedup.js";
import { countRows, readAttempt, readOutboxRows, seedAttempt } from "./test-db.js";

beforeEach(async () => {
  await resetOutreachTables();
});

/** The same body with the greeting changed: no numbers touched, no claim broken. */
const EDITED_BODY = PASSING_BODY.replace("Hi there,", "Hello,");

describe("editAndApprove", () => {
  it("recomputes the dedup key from the edited text and queues under it", async () => {
    const seeded = await seedAttempt();

    const response = await editAndApprove({
      id: seeded.attemptId,
      approvedBy: "michal",
      subject: "Filling weekday tables at Lumen Coffee House",
      body: EDITED_BODY,
    });

    expect(response.alreadyApplied).toBe(false);
    expect(response.blockedGates).toEqual([]);

    const expectedKey = computeDedupKey(
      seeded.merchantId,
      seeded.campaignId,
      "Filling weekday tables at Lumen Coffee House",
      EDITED_BODY,
    );

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("QUEUED");
    // Not the key the attempt was seeded with. Keeping the old one would let
    // the provider deduplicate the edit against the message it replaced.
    expect(attempt.dedup_key).not.toBe(seeded.dedupKey);
    expect(attempt.dedup_key).toBe(expectedKey);

    const [outbox] = await readOutboxRows();
    expect(outbox?.idempotency_key).toBe(expectedKey);

    // The edited text is what will be delivered, and what is stored.
    const payload = await db.queryRow<{ body: string }>`
      SELECT payload->>'body' AS body FROM outbox WHERE attempt_id = ${seeded.attemptId}
    `;
    expect(payload?.body).toBe(EDITED_BODY);

    const draft = await db.queryRow<{ body: string }>`
      SELECT body FROM drafts WHERE id = ${seeded.draftId}
    `;
    expect(draft?.body).toBe(EDITED_BODY);
  });

  it("blocks an edit that fails a blocking gate, and queues nothing", async () => {
    const seeded = await seedAttempt();

    const response = await editAndApprove({
      id: seeded.attemptId,
      approvedBy: "michal",
      subject: "Filling weekday tables at Lumen Coffee House",
      // An invented number the merchant record does not support. A human
      // typed it, which is exactly why the gates run again.
      body: EDITED_BODY.replace("Best regards,", "We already work with 1200 venues in Leeds.\n\nBest regards,"),
    });

    expect(response.attempt.state).toBe("BLOCKED");
    expect(response.blockedGates).toContain("G06_no_invented_numbers");
    expect(await countRows("outbox")).toBe(0);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("BLOCKED");
    expect(attempt.approved_by).toBeNull();

    // The edit and the verdict on it are both committed: the reviewer has to
    // be able to see the text that was caught and why.
    const report = await db.queryRow<{ blocked: boolean; kind: string }>`
      SELECT blocked, jsonb_typeof(outcomes) AS kind
      FROM gate_reports WHERE draft_id = ${seeded.draftId}
    `;
    expect(report?.blocked).toBe(true);
    expect(report?.kind).toBe("array");
  });

  it("refuses to edit an attempt that has already been queued", async () => {
    const seeded = await seedAttempt();
    await editAndApprove({
      id: seeded.attemptId,
      approvedBy: "michal",
      subject: "Filling weekday tables at Lumen Coffee House",
      body: EDITED_BODY,
    });

    const second = await editAndApprove({
      id: seeded.attemptId,
      approvedBy: "lukas",
      subject: "A different subject entirely",
      body: EDITED_BODY,
    });

    // The decision stands and the second call changes nothing — it does not
    // edit the text of a message that is already on its way out.
    expect(second.alreadyApplied).toBe(true);
    expect(second.attempt.state).toBe("QUEUED");
    expect(await countRows("outbox")).toBe(1);
  });
});

describe("reject", () => {
  it("records the reason and never queues anything", async () => {
    const seeded = await seedAttempt();

    const response = await reject({
      id: seeded.attemptId,
      rejectedBy: "michal",
      reason: "Tone is wrong for a first approach.",
    });

    expect(response.alreadyApplied).toBe(false);

    const attempt = await readAttempt(seeded.attemptId);
    expect(attempt.state).toBe("REJECTED");
    expect(attempt.failure_reason).toContain("Tone is wrong");
    expect(attempt.failure_reason).toContain("michal");
    expect(await countRows("outbox")).toBe(0);
  });

  it("treats a second rejection as the same decision", async () => {
    const seeded = await seedAttempt();
    const first = await reject({ id: seeded.attemptId, rejectedBy: "michal", reason: "Not now." });
    const second = await reject({ id: seeded.attemptId, rejectedBy: "michal", reason: "Not now." });

    expect(first.alreadyApplied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
  });

  it("refuses to reject an attempt that is already queued", async () => {
    const seeded = await seedAttempt();
    await editAndApprove({
      id: seeded.attemptId,
      approvedBy: "michal",
      subject: "Filling weekday tables at Lumen Coffee House",
      body: EDITED_BODY,
    });

    // By now the outbox row exists and a worker may be mid-delivery. There is
    // no un-approving; REJECTED is not reachable from QUEUED.
    await expect(
      reject({ id: seeded.attemptId, rejectedBy: "michal", reason: "Changed my mind." }),
    ).rejects.toThrow(/is QUEUED and cannot be rejected/);
  });
});
