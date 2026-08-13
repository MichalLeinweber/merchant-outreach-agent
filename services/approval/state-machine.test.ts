import { describe, expect, it } from "vitest";

import type { OutreachAttempt, OutreachState } from "../../shared/contracts.js";
import { InvalidStateTransitionError } from "../../shared/errors.js";
import {
  ALLOWED_TRANSITIONS,
  MissingTransitionFieldError,
  TERMINAL_STATES,
  allowedTargets,
  applyTransition,
  canTransition,
  isTerminal,
} from "./state-machine.js";

const ALL_STATES = Object.keys(ALLOWED_TRANSITIONS) as OutreachState[];

describe("the transition table", () => {
  it("covers every state in the contract", () => {
    // The table is a total Record over `OutreachState`, so this is really a
    // compile-time guarantee; the test states it for a reader who has not
    // read the type.
    expect(ALL_STATES).toHaveLength(11);
  });

  it("only ever points at states that exist", () => {
    for (const from of ALL_STATES) {
      for (const to of allowedTargets(from)) {
        expect(ALL_STATES).toContain(to);
      }
    }
  });

  it("has no state that transitions to itself", () => {
    // A self-transition would make "did anything change?" unanswerable.
    for (const state of ALL_STATES) {
      expect(allowedTargets(state)).not.toContain(state);
    }
  });

  it("lists no state twice as a target of the same source", () => {
    for (const state of ALL_STATES) {
      const targets = allowedTargets(state);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

describe("the happy path", () => {
  it("runs from ingest to a queued send", () => {
    const steps: [OutreachState, OutreachState][] = [
      ["INGESTED", "TRIAGED"],
      ["TRIAGED", "DRAFTED"],
      ["DRAFTED", "GATED"],
      ["GATED", "PENDING_APPROVAL"],
      ["PENDING_APPROVAL", "APPROVED"],
      ["APPROVED", "QUEUED"],
      ["QUEUED", "SENT"],
    ];

    for (const [from, to] of steps) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("lets a gated draft go either to the queue or to blocked", () => {
    expect(canTransition("GATED", "PENDING_APPROVAL")).toBe(true);
    expect(canTransition("GATED", "BLOCKED")).toBe(true);
  });
});

describe("what the table forbids", () => {
  it("does not let anything skip the human", () => {
    // The claim the whole repository makes: nothing is sent that a person did
    // not approve. It is enforced here, not by convention.
    expect(canTransition("PENDING_APPROVAL", "SENT")).toBe(false);
    expect(canTransition("PENDING_APPROVAL", "QUEUED")).toBe(false);
    expect(canTransition("GATED", "APPROVED")).toBe(false);
    expect(canTransition("DRAFTED", "SENT")).toBe(false);
  });

  it("does not let a blocked draft walk back into the queue", () => {
    // Fixing a blocked draft means new content, which means a new dedupKey,
    // which means a new attempt row — not this one changing its mind.
    expect(allowedTargets("BLOCKED")).toEqual([]);
  });

  it("does not let an approved message be rejected after the fact", () => {
    // By then the outbox row exists and a worker may be mid-delivery.
    expect(canTransition("APPROVED", "REJECTED")).toBe(false);
    expect(canTransition("QUEUED", "REJECTED")).toBe(false);
  });

  it("lets nothing leave SENT", () => {
    for (const state of ALL_STATES) {
      expect(canTransition("SENT", state)).toBe(false);
    }
  });

  it("reaches SENT from QUEUED and from nowhere else", () => {
    const sources = ALL_STATES.filter((state) => canTransition(state, "SENT"));

    // Every send therefore passes through the outbox, carrying the same
    // idempotency key through the same claim.
    expect(sources).toEqual(["QUEUED"]);
  });
});

describe("retries", () => {
  it("lets a failed delivery be queued again", () => {
    expect(canTransition("QUEUED", "FAILED")).toBe(true);
    expect(canTransition("FAILED", "QUEUED")).toBe(true);
  });

  it("does not let a failed delivery jump straight to sent", () => {
    expect(canTransition("FAILED", "SENT")).toBe(false);
  });
});

describe("terminal states", () => {
  it("are exactly the three the spec names", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["BLOCKED", "REJECTED", "SENT"]);
  });

  it("agree with isTerminal", () => {
    for (const state of ALL_STATES) {
      expect(isTerminal(state)).toBe(TERMINAL_STATES.includes(state));
    }
  });
});

describe("applyTransition", () => {
  const AT = new Date("2026-08-12T09:00:00.000Z");

  function attempt(overrides: Partial<OutreachAttempt> = {}): OutreachAttempt {
    return {
      id: "att_0001",
      merchantId: "mch_0001",
      campaignId: "cmp_0001",
      draftId: "drf_0001",
      state: "PENDING_APPROVAL",
      dedupKey: "dedup_a1b2c3",
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      providerMessageId: null,
      failureReason: null,
      attemptCount: 0,
      createdAt: "2026-08-12T08:00:00.000Z",
      updatedAt: "2026-08-12T08:00:00.000Z",
      ...overrides,
    };
  }

  /** An attempt that has been approved and queued, ready to be delivered. */
  function queued(overrides: Partial<OutreachAttempt> = {}): OutreachAttempt {
    return attempt({
      state: "QUEUED",
      approvedBy: "michal",
      approvedAt: "2026-08-12T08:30:00.000Z",
      attemptCount: 1,
      ...overrides,
    });
  }

  it("returns the attempt in the new state, stamped from the context", () => {
    const next = applyTransition(attempt({ state: "GATED" }), "PENDING_APPROVAL", { at: AT });

    expect(next.state).toBe("PENDING_APPROVAL");
    expect(next.updatedAt).toBe(AT.toISOString());
  });

  it("throws for a move the table does not allow", () => {
    // Not "returns the attempt unchanged": a silently ignored transition is a
    // send that quietly did not happen.
    expect(() => applyTransition(attempt(), "SENT", { at: AT })).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("rejects every transition out of SENT", () => {
    const sent = queued({ state: "SENT", providerMessageId: "msg_000001" });

    for (const state of ALL_STATES) {
      expect(() => applyTransition(sent, state, { at: AT })).toThrow(InvalidStateTransitionError);
    }
  });

  it("requires an approver, and records when the approval happened", () => {
    expect(() => applyTransition(attempt(), "APPROVED", { at: AT })).toThrow(
      MissingTransitionFieldError,
    );

    const approved = applyTransition(attempt(), "APPROVED", { at: AT, approvedBy: "michal" });
    expect(approved.approvedBy).toBe("michal");
    expect(approved.approvedAt).toBe(AT.toISOString());
  });

  it("requires a receipt before an attempt may be SENT", () => {
    // The database says the same thing through attempts_sent_requires_receipt;
    // failing here names the field instead of the constraint.
    expect(() => applyTransition(queued(), "SENT", { at: AT })).toThrow(
      MissingTransitionFieldError,
    );

    const sent = applyTransition(queued(), "SENT", { at: AT, providerMessageId: "msg_000001" });
    expect(sent.providerMessageId).toBe("msg_000001");
    expect(sent.sentAt).toBe(AT.toISOString());
  });

  it("requires a reason for a failure and for a rejection", () => {
    expect(() => applyTransition(queued(), "FAILED", { at: AT })).toThrow(
      MissingTransitionFieldError,
    );
    expect(() => applyTransition(attempt(), "REJECTED", { at: AT })).toThrow(
      MissingTransitionFieldError,
    );

    const failed = applyTransition(queued(), "FAILED", { at: AT, failureReason: "timed out" });
    expect(failed.failureReason).toBe("timed out");
  });

  it("refuses to queue or send an attempt that carries no approver", () => {
    // Unreachable through the table, but not through a hand-written row.
    const orphan = attempt({ state: "APPROVED", approvedBy: null, approvedAt: null });

    expect(() => applyTransition(orphan, "QUEUED", { at: AT })).toThrow(
      MissingTransitionFieldError,
    );
  });

  it("keeps the approver when a failed attempt is queued again", () => {
    const failed = queued({ state: "FAILED", failureReason: "provider timed out" });

    const requeued = applyTransition(failed, "QUEUED", { at: AT });

    // The audit trail survives the retry: the message being retried is still
    // the message that person approved.
    expect(requeued.approvedBy).toBe("michal");
    expect(requeued.approvedAt).toBe("2026-08-12T08:30:00.000Z");
  });

  it("counts delivery attempts, not state changes", () => {
    const approved = attempt({
      state: "APPROVED",
      approvedBy: "michal",
      approvedAt: "2026-08-12T08:30:00.000Z",
    });

    expect(applyTransition(approved, "QUEUED", { at: AT }).attemptCount).toBe(1);
    // A retry is a second delivery attempt.
    expect(
      applyTransition(queued({ state: "FAILED", failureReason: "x" }), "QUEUED", { at: AT })
        .attemptCount,
    ).toBe(2);
    // Sending is not.
    expect(
      applyTransition(queued(), "SENT", { at: AT, providerMessageId: "msg_000001" }).attemptCount,
    ).toBe(1);
  });

  it("does not mutate the attempt it was given", () => {
    const before = attempt();
    const snapshot = { ...before };

    applyTransition(before, "APPROVED", { at: AT, approvedBy: "michal" });

    expect(before).toEqual(snapshot);
  });
});
