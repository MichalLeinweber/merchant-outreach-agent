import { describe, expect, it } from "vitest";

import type { Merchant } from "../../shared/contracts.js";
import {
  BODY_MAX_WORDS,
  g01Schema,
  g02Length,
  g03Placeholders,
  SUBJECT_MAX_LENGTH,
} from "./index.js";
import {
  bodyWith,
  highlighted,
  PASSING_BODY,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G01 schema", () => {
  it("passes a draft that matches the contract", () => {
    const outcome = g01Schema(sampleDraft(), merchant, context);

    expect(outcome.passed).toBe(true);
    expect(outcome.severity).toBe("blocking");
    expect(outcome.detail).toBe("");
  });

  it("fails when an evidence ref names a field that is not on Merchant", () => {
    const draft = sampleDraft({
      evidence: [
        {
          claim: "a 4.8 rating",
          sourceField: "revenue" as unknown as keyof Merchant,
          sourceValue: "4.8",
        },
      ],
    });

    const outcome = g01Schema(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("evidence[0].sourceField");
    // Nothing to highlight: the draft's shape is what is wrong, not its prose.
    expect(outcome.spans).toBeUndefined();
  });

  it("fails when usage is missing, rather than trusting the type", () => {
    const draft = sampleDraft();
    delete (draft as unknown as Record<string, unknown>).usage;

    const outcome = g01Schema(draft, merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("`usage`");
  });
});

describe("G02 length", () => {
  it("passes a subject and body inside the limits", () => {
    expect(g02Length(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails an over-long subject and says by how much", () => {
    const subject = "x".repeat(SUBJECT_MAX_LENGTH + 1);
    const outcome = g02Length(sampleDraft({ subject }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain(`${SUBJECT_MAX_LENGTH + 1} characters`);
  });

  it("highlights only the overflow when the body runs long", () => {
    const padding = ` ${"padding".repeat(1).concat(" padding").repeat(60)}`;
    const body = PASSING_BODY + padding;
    const outcome = g02Length(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain(`the limit is ${BODY_MAX_WORDS}`);
    expect(outcome.spans).toHaveLength(1);

    const [span] = outcome.spans ?? [];
    // The highlight starts inside the padding, not at the top of the body.
    expect(span?.start).toBeGreaterThan(PASSING_BODY.length - padding.length);
    expect(span?.end).toBe(body.length);
  });

  it("fails and highlights the whole body when it is too short", () => {
    const body = "Too short to be a first-contact email.";
    const outcome = g02Length(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("the minimum is");
    expect(outcome.spans).toEqual([{ start: 0, end: body.length }]);
  });
});

describe("G03 placeholders", () => {
  it("passes a finished draft", () => {
    expect(g03Placeholders(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails an unfilled bracket placeholder and points at it", () => {
    const body = bodyWith([["Hi there,", "Hi [NAME],"]]);
    const outcome = g03Placeholders(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toEqual(["[NAME]"]);
  });

  it("catches a placeholder in the subject even though it cannot highlight it", () => {
    const outcome = g03Placeholders(
      sampleDraft({ subject: "An offer for {{merchantName}}" }),
      merchant,
      context,
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("subject");
    expect(outcome.spans).toBeUndefined();
  });
});
