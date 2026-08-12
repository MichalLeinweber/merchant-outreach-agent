/**
 * G01, G02, G03 — the draft is a well-formed object, the right size, and
 * finished.
 *
 * These are hygiene. They catch a broken pipeline rather than a lying model,
 * and they run first so that the gates which say something interesting are
 * never reasoning about a malformed draft.
 */

import type { ModelId, OutreachDraft, TextSpan } from "../../shared/contracts.js";
import { MERCHANT_FIELD_SET } from "./record.js";
import {
  allRegexSpans,
  countWords,
  listPhrase,
  quote,
  textOfSpans,
  unique,
} from "./text.js";
import { fail, pass, type Gate } from "./types.js";

// ─── G01 schema ────────────────────────────────────────────────

const MODEL_IDS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-5",
] as const satisfies readonly ModelId[];

type _AllModelsListed =
  Exclude<ModelId, (typeof MODEL_IDS)[number]> extends never
    ? true
    : ["missing from MODEL_IDS:", Exclude<ModelId, (typeof MODEL_IDS)[number]>];
const _modelsAreExhaustive: _AllModelsListed = true;
void _modelsAreExhaustive;

const MODEL_ID_SET: ReadonlySet<string> = new Set(MODEL_IDS);

const REQUIRED_TEXT_FIELDS = [
  "id",
  "merchantId",
  "campaignId",
  "locale",
  "subject",
  "body",
  "createdAt",
] as const satisfies readonly (keyof OutreachDraft)[];

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "costUsd",
] as const satisfies readonly (keyof OutreachDraft["usage"])[];

/**
 * Re-checks the shape of a draft that is already typed as one.
 *
 * The type says `OutreachDraft`, so why look? Because the type is a claim
 * about where the value came from, not a fact about the value. A draft
 * reaching the gates has passed through a JSON parse, a database row, or a
 * fixture — three places where a cast is the only thing between a wrong shape
 * and this function. G01 is what makes "the structured output parsed" a
 * checked statement rather than an assumed one, and its failure is the reason
 * the report can distinguish "the model wrote nonsense" from "the model wrote
 * something we could not even read".
 */
function shapeProblems(draft: OutreachDraft): string[] {
  const problems: string[] = [];
  const raw = draft as unknown as Record<string, unknown>;

  for (const field of REQUIRED_TEXT_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string") {
      problems.push(`\`${field}\` is ${describeType(value)}, expected a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`\`${field}\` is empty`);
    }
  }

  if (typeof raw.createdAt === "string" && Number.isNaN(Date.parse(raw.createdAt))) {
    problems.push(`\`createdAt\` is not a parseable instant: ${quote(raw.createdAt)}`);
  }

  if (typeof raw.model !== "string" || !MODEL_ID_SET.has(raw.model)) {
    problems.push(`\`model\` is not a known model id: ${describeType(raw.model)}`);
  }

  problems.push(...usageProblems(raw.usage));
  problems.push(...evidenceProblems(raw.evidence));

  return problems;
}

function usageProblems(usage: unknown): string[] {
  if (typeof usage !== "object" || usage === null) {
    return [`\`usage\` is ${describeType(usage)}, expected an object`];
  }

  const raw = usage as Record<string, unknown>;
  const problems: string[] = [];

  for (const field of USAGE_FIELDS) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`\`usage.${field}\` is ${describeType(value)}, expected a number`);
      continue;
    }
    if (value < 0) {
      problems.push(`\`usage.${field}\` is negative (${value})`);
    }
  }

  return problems;
}

function evidenceProblems(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) {
    return [`\`evidence\` is ${describeType(evidence)}, expected an array`];
  }

  const problems: string[] = [];

  evidence.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`\`evidence[${index}]\` is ${describeType(entry)}, expected an object`);
      return;
    }

    const raw = entry as Record<string, unknown>;

    if (typeof raw.claim !== "string" || raw.claim.length === 0) {
      problems.push(`\`evidence[${index}].claim\` is not a non-empty string`);
    }
    // `sourceField` being a `Merchant` key is what stops the model naming a
    // source that does not exist. It is a type in the contract and a runtime
    // check here, because only one of those survives a JSON parse.
    if (typeof raw.sourceField !== "string" || !MERCHANT_FIELD_SET.has(raw.sourceField)) {
      problems.push(
        `\`evidence[${index}].sourceField\` is not a Merchant field: ` +
          `${describeType(raw.sourceField)}`,
      );
    }
    if (typeof raw.sourceValue !== "string") {
      problems.push(`\`evidence[${index}].sourceValue\` is not a string`);
    }
  });

  return problems;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return quote(value);
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/**
 * G01 — the draft parses into an `OutreachDraft`.
 *
 * No spans: if the shape is wrong there is no body to point into, and
 * inventing offsets for text that may not be a string is how a reporting bug
 * becomes a crash.
 */
export const g01Schema: Gate = (draft) => {
  const problems = shapeProblems(draft);
  if (problems.length === 0) return pass("G01_schema");

  return fail(
    "G01_schema",
    `Draft does not match the OutreachDraft contract: ${problems.join("; ")}.`,
  );
};

// ─── G02 length ────────────────────────────────────────────────

export const SUBJECT_MAX_LENGTH = 60;
export const BODY_MIN_WORDS = 60;
export const BODY_MAX_WORDS = 180;

/** Offset of the nth word (0-based) in `text`, or -1 if there is no such word. */
function offsetOfWord(text: string, index: number): number {
  const pattern = /\S+/g;
  let seen = 0;

  for (const match of text.matchAll(pattern)) {
    if (seen === index && match.index !== undefined) return match.index;
    seen += 1;
  }

  return -1;
}

/**
 * G02 — subject at most 60 characters, body between 60 and 180 words.
 *
 * The upper bound is the interesting one. A first-contact email that runs
 * long is not a compliance problem, but it is the most reliable signal that
 * the model padded rather than personalised — and padding is where invented
 * detail tends to appear.
 */
export const g02Length: Gate = (draft) => {
  const problems: string[] = [];
  const spans: TextSpan[] = [];

  if (draft.subject.length > SUBJECT_MAX_LENGTH) {
    problems.push(
      `subject is ${draft.subject.length} characters, the limit is ${SUBJECT_MAX_LENGTH}`,
    );
  }

  const words = countWords(draft.body);

  if (words < BODY_MIN_WORDS) {
    problems.push(`body is ${words} words, the minimum is ${BODY_MIN_WORDS}`);
    // The whole body is the problem, so highlight all of it.
    if (draft.body.length > 0) spans.push({ start: 0, end: draft.body.length });
  } else if (words > BODY_MAX_WORDS) {
    problems.push(`body is ${words} words, the limit is ${BODY_MAX_WORDS}`);
    // Highlight the overflow only: the reviewer needs to see what to cut.
    const start = offsetOfWord(draft.body, BODY_MAX_WORDS);
    if (start !== -1) spans.push({ start, end: draft.body.length });
  }

  if (problems.length === 0) return pass("G02_length");

  return fail("G02_length", `Draft is outside its size limits: ${problems.join("; ")}.`, spans);
};

// ─── G03 placeholders ──────────────────────────────────────────

/**
 * Unfilled template markers.
 *
 * Bracketed tokens are restricted to short, template-looking contents so that
 * ordinary parenthetical prose in square brackets is not flagged; `{{` is a
 * template delimiter in any of the engines this pipeline could grow, and the
 * capitalised `XX` form covers both `XXX` and `XX%`.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[[A-Za-z0-9_. -]{1,40}\]/,
  /\{\{[^}]*\}?\}?/,
  /\{[A-Za-z0-9_. -]{1,40}\}/,
  /\bTODO\b/i,
  /\blorem\b/i,
  /\bX{2,}\b/,
];

/**
 * G03 — nothing left to fill in.
 *
 * Both subject and body are scanned; only the body produces spans, because
 * `TextSpan` is defined as an offset into the body and a subject offset
 * rendered against the body would highlight the wrong words.
 */
export const g03Placeholders: Gate = (draft) => {
  const bodySpans = allRegexSpans(draft.body, PLACEHOLDER_PATTERNS);
  const bodyHits = unique(textOfSpans(draft.body, bodySpans));
  const subjectHits = unique(
    textOfSpans(draft.subject, allRegexSpans(draft.subject, PLACEHOLDER_PATTERNS)),
  );

  if (bodyHits.length === 0 && subjectHits.length === 0) return pass("G03_placeholders");

  const where: string[] = [];
  if (subjectHits.length > 0) {
    where.push(`subject contains ${listPhrase(subjectHits.map((hit) => quote(hit)))}`);
  }
  if (bodyHits.length > 0) {
    where.push(`body contains ${listPhrase(bodyHits.map((hit) => quote(hit)))}`);
  }

  return fail(
    "G03_placeholders",
    `Draft still contains template placeholders: ${where.join("; ")}. ` +
      `The draft was never finished, so it cannot be reviewed.`,
    bodySpans,
  );
};
