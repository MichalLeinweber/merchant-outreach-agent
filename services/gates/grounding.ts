/**
 * G05 and G06 — the two gates this project exists to demonstrate.
 *
 * Every other gate checks that a draft is well-formed, polite or the right
 * length. These two check that it is *true*, in the only sense a program can
 * check: every personalized claim points at text the model actually wrote,
 * and every number in that text is one the source record contains.
 *
 * The design principle both share is that the model has to show its working.
 * It is not enough for a draft to be plausible — a fluent invented detail is
 * exactly what a language model is best at producing, and it is
 * indistinguishable from a real one by eye. So the draft carries evidence,
 * and the evidence is checked mechanically against the record. What cannot be
 * shown is rejected rather than repaired: repairing it would hide how often
 * this happens, and that rate is the number the evals report.
 */

import type { Merchant, TextSpan } from "../../shared/contracts.js";
import { groundedNumbers, isGrounded, numberTokens, numericInterpretations } from "./numbers.js";
import { describeValue, type MerchantFieldValue } from "./record.js";
import { firstFreeSpan, listPhrase, quote, spansOf, unique } from "./text.js";
import { fail, pass, type Gate } from "./types.js";

// ─── G05 evidence grounding ────────────────────────────────────

type ValueCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `sourceValue` really is the value of that field on the record.
 *
 * Half of G05 is the substring check everybody thinks of; this is the other
 * half, and it is the half that catches the more dangerous failure. A claim
 * can be quoted from the body perfectly and still cite `rating: "5.0"` for a
 * merchant rated 4.8 — the evidence looks complete, the reviewer's eye slides
 * over it, and the draft ships with a number nobody checked.
 *
 * Numbers are compared as numbers, so "4.80" and "4.8" agree. Strings are
 * compared exactly, with no trimming or case folding: the model was given the
 * record and asked to copy a value out of it, and every relaxation here is a
 * place where "nearly right" starts counting as right.
 */
function checkSourceValue(
  field: string,
  actual: MerchantFieldValue,
  sourceValue: string,
): ValueCheck {
  if (actual === null) {
    return {
      ok: false,
      reason:
        `cites \`${field}\`, which is null on the record — ` +
        `there is nothing there to ground a claim in`,
    };
  }

  if (typeof actual === "number") {
    return numericInterpretations(sourceValue).includes(actual)
      ? { ok: true }
      : {
          ok: false,
          reason: `cites \`${field}\` as ${quote(sourceValue)}, the record says ${actual}`,
        };
  }

  if (typeof actual === "boolean") {
    return sourceValue.trim().toLowerCase() === String(actual)
      ? { ok: true }
      : {
          ok: false,
          reason: `cites \`${field}\` as ${quote(sourceValue)}, the record says ${actual}`,
        };
  }

  return sourceValue === actual
    ? { ok: true }
    : {
        ok: false,
        reason:
          `cites \`${field}\` as ${quote(sourceValue)}, ` +
          `the record says ${describeValue(actual)}`,
      };
}

/**
 * G05 — every claim is quoted from the body and sourced from the record.
 *
 * An empty `evidence` array passes. That is not a loophole: the draft prompt
 * tells the model that when a record has nothing solid to personalize with,
 * the correct output is a plain message that claims nothing. A draft making
 * no claims has none to get wrong. Whether it *should* have made claims is a
 * different question, and G13 is where it is asked.
 */
export const g05EvidenceGrounding: Gate = (draft, merchant) => {
  const problems: string[] = [];
  const failingSpans: TextSpan[] = [];
  // Claims located so far, so two refs quoting the same phrase take different
  // occurrences instead of both pointing at the first one.
  const located: TextSpan[] = [];

  draft.evidence.forEach((ref, index) => {
    const span = firstFreeSpan(draft.body, ref.claim, located);

    if (span === null) {
      const occurrences = spansOf(draft.body, ref.claim).length;
      problems.push(
        occurrences === 0
          ? `evidence[${index}] quotes ${quote(ref.claim)}, which does not appear in the body`
          : `evidence[${index}] quotes ${quote(ref.claim)}, which appears ${occurrences} ` +
            `time(s) in the body but is cited more often than that`,
      );
      return;
    }

    located.push(span);

    const check = checkSourceValue(
      ref.sourceField,
      merchant[ref.sourceField],
      ref.sourceValue,
    );

    if (!check.ok) {
      problems.push(`evidence[${index}] ${check.reason}`);
      failingSpans.push(span);
    }
  });

  if (problems.length === 0) return pass("G05_evidence_grounding");

  return fail(
    "G05_evidence_grounding",
    `${problems.length} evidence claim(s) are not grounded in the record: ` +
      `${problems.join("; ")}. The draft is rejected rather than repaired.`,
    failingSpans,
  );
};

// ─── G06 no invented numbers ───────────────────────────────────

/**
 * G06 — every number in the body appears in the source record.
 *
 * Broader than G05 by design. G05 only sees the claims the model chose to
 * declare as evidence; a number can appear anywhere in the prose without ever
 * being cited, and an uncited invented number is the easiest kind to ship. So
 * this gate ignores the evidence entirely and reads the body itself.
 *
 * Nothing is derived. A year computed from `yearsInBusiness` and today's date
 * is not grounded here even though a person could do the arithmetic, because
 * the answer would change with the calendar and the same draft would pass in
 * August and fail in January. Determinism is worth more than the handful of
 * legitimate sentences this rejects — and the draft prompt tells the model not
 * to write years it was not given, so a draft that trips this gate has
 * ignored an instruction either way.
 *
 * Numbers written as words ("three years") are out of scope: the check is on
 * digits, and a word-number carries none of the false precision that makes an
 * invented figure dangerous.
 */
export const g06NoInventedNumbers: Gate = (draft, merchant) => {
  const grounded = groundedNumbers(merchant);
  const ungrounded = numberTokens(draft.body).filter(
    (token) => !isGrounded(token.text, grounded),
  );

  if (ungrounded.length === 0) return pass("G06_no_invented_numbers");

  const shown = unique(ungrounded.map((token) => token.text)).map((text) => quote(text));
  const spans: TextSpan[] = ungrounded.map((token) => ({
    start: token.start,
    end: token.end,
  }));

  return fail(
    "G06_no_invented_numbers",
    `Body contains ${ungrounded.length} number(s) the source record does not ` +
      `support: ${listPhrase(shown)}. ` +
      `Grounded values for this merchant: ${describeGrounded(merchant)}.`,
    spans,
  );
};

/** The numbers a reviewer may legitimately see, for the failure message. */
function describeGrounded(merchant: Merchant): string {
  const values = [...groundedNumbers(merchant)].sort((a, b) => a - b);
  return values.length === 0 ? "none — the record holds no numbers" : values.join(", ");
}
