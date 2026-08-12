/**
 * G07, G10 and G12 — what the draft promises, what it asks for, and how it
 * sounds.
 *
 * G07 and G12 both work from word lists and are easy to confuse, so the split
 * is worth stating: **G07 is about claims** the message makes — guarantees,
 * superlatives, promises about price or performance — and **G12 is about
 * register** — urgency, scarcity, spam vocabulary, shouting. A guarantee is
 * wrong because it commits the marketplace to something it cannot deliver; a
 * countdown is wrong because it makes a first-contact email read like junk.
 * Different failures, different fixes, so different gates.
 */

import type { TextSpan } from "../../shared/contracts.js";
import { allRegexSpans, listPhrase, quote, regexSpans, textOfSpans, unique } from "./text.js";
import { fail, pass, type Gate } from "./types.js";

// ─── G07 banned claims ─────────────────────────────────────────

/**
 * Claims the marketplace does not make.
 *
 * "best" carries an exception for the sign-off, because "Best regards" is not
 * a superlative claim about the merchant and a gate that fails every polite
 * email would be turned off inside a day.
 */
const BANNED_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bguarantee(?:d|s|ing)?\b/i,
  /\bbest\b(?!\s+(?:regards|wishes))/i,
  /#\s?1\b/,
  /\bnumber one\b/i,
  /\bunbeatable\b/i,
  /\bworld[-\s]class\b/i,
  /\bmost popular\b/i,
  /\bthe (?:top|leading) \w+/i,
  /\bdouble your \w+/i,
  /\brisk[-\s]free\b/i,
  /\bno risk\b/i,
  /\bcheapest\b/i,
  /\blowest price\b/i,
  /\bwill increase your \w+/i,
];

export const g07BannedClaims: Gate = (draft) => {
  const bodySpans = allRegexSpans(draft.body, BANNED_CLAIM_PATTERNS);
  const bodyHits = unique(textOfSpans(draft.body, bodySpans));
  const subjectHits = unique(
    textOfSpans(draft.subject, allRegexSpans(draft.subject, BANNED_CLAIM_PATTERNS)),
  );

  if (bodyHits.length === 0 && subjectHits.length === 0) return pass("G07_banned_claims");

  const where: string[] = [];
  if (subjectHits.length > 0) {
    where.push(`subject: ${listPhrase(subjectHits.map((hit) => quote(hit)))}`);
  }
  if (bodyHits.length > 0) {
    where.push(`body: ${listPhrase(bodyHits.map((hit) => quote(hit)))}`);
  }

  return fail(
    "G07_banned_claims",
    `Draft makes a claim the marketplace does not make (${where.join("; ")}). ` +
      `Outreach describes reach, not outcomes.`,
    bodySpans,
  );
};

// ─── G10 single call to action ─────────────────────────────────

/**
 * Kinds of ask, one pattern each.
 *
 * The gate counts *kinds*, not matches, and a link is not one of them. A
 * message that says "register your interest using the link below" makes one
 * ask through one mechanism; counting the link separately would fail the
 * correct shape of email. What the gate is looking for is a message asking
 * the reader to do two different things — reply *and* book a slot — which is
 * the ambiguity that costs a reply.
 */
const CTA_PATTERNS: Record<string, RegExp> = {
  reply: /\breply\b|\bwrite back\b|\bget back to me\b/i,
  meeting:
    /\bbook a (?:slot|call|time|meeting)\b|\bschedule a (?:call|meeting|chat)\b|\barrange a (?:call|meeting|chat)\b|\bset up a (?:call|meeting|chat)\b|\bin my (?:diary|calendar)\b/i,
  register:
    /\bregister (?:your )?interest\b|\bregister here\b|\bsign up\b|\bcreate an account\b/i,
  visit: /\bclick here\b|\bvisit (?:our|the) (?:site|website|page)\b/i,
  question: /\bwould you like\b|\blet me know\b|\bare you interested\b|\bwould\b[^.?!]{0,60}\bbe worth\b/i,
};

/**
 * G10 — exactly one call to action.
 *
 * A warning, not a blocker, per the gate table: two asks make a message worse
 * without making it untrue, and blocking a send over it would put a
 * cosmetic defect on the same footing as an invented number.
 */
export const g10SingleCta: Gate = (draft) => {
  const matched: { kind: string; spans: TextSpan[] }[] = [];

  for (const [kind, pattern] of Object.entries(CTA_PATTERNS)) {
    const spans = regexSpans(draft.body, pattern);
    if (spans.length > 0) matched.push({ kind, spans });
  }

  if (matched.length === 1) return pass("G10_single_cta");

  if (matched.length === 0) {
    return fail(
      "G10_single_cta",
      `Body asks the reader to do nothing. A first-contact email needs one ` +
        `call to action, or there is no reason for it to have been sent.`,
    );
  }

  const spans = matched
    .flatMap((entry) => entry.spans)
    .sort((a, b) => a.start - b.start);

  return fail(
    "G10_single_cta",
    `Body contains ${matched.length} different calls to action ` +
      `(${listPhrase(matched.map((entry) => entry.kind))}): ` +
      `${listPhrase(unique(textOfSpans(draft.body, spans)).map((hit) => quote(hit)))}. ` +
      `Outreach carries exactly one, so the reply is unambiguous.`,
    spans,
  );
};

// ─── G12 compliance ────────────────────────────────────────────

const URGENCY_PATTERNS: readonly RegExp[] = [
  /\bact now\b/i,
  /\blimited time\b/i,
  /\bhurry\b/i,
  /\blast chance\b/i,
  /\bdon'?t miss\b/i,
  /\btoday only\b/i,
  /\bexpires? (?:soon|today)\b/i,
  /\bwhile (?:stocks|places) last\b/i,
  /\b(?:spots|places|slots) remaining\b/i,
  /\bonly \d+ (?:spots|places|slots) left\b/i,
  /\burgent\b/i,
];

const SPAM_VOCABULARY_PATTERNS: readonly RegExp[] = [
  /\bfree money\b/i,
  /\bno obligation\b/i,
  /\bbuy now\b/i,
  /\b100% free\b/i,
  /\bcongratulations\b/i,
  /\byou'?ve won\b/i,
  /\bcash bonus\b/i,
];

/** Three or more consecutive words in capitals — shouting, not emphasis. */
const SHOUTING_PATTERN = /\b[A-Z]{2,}\b(?:[\s,]+\b[A-Z]{2,}\b){2,}/;

/** More than one exclamation mark in a first-contact email. */
const EXCLAMATION_PATTERN = /!/;
const MAX_EXCLAMATIONS = 1;

/**
 * G12 — the message reads like professional correspondence.
 *
 * Blocking, because the register of a first-contact email is a compliance
 * matter and not a matter of taste: urgency and scarcity are regulated in
 * several of the markets this campaign runs in, and a message that reads as
 * bulk mail damages the sender domain for every merchant after it.
 */
export const g12Compliance: Gate = (draft) => {
  const problems: string[] = [];
  const spans: TextSpan[] = [];

  const urgency = allRegexSpans(draft.body, URGENCY_PATTERNS);
  if (urgency.length > 0) {
    problems.push(
      `urgency or scarcity language ` +
        `(${listPhrase(unique(textOfSpans(draft.body, urgency)).map((hit) => quote(hit)))})`,
    );
    spans.push(...urgency);
  }

  const spam = allRegexSpans(draft.body, SPAM_VOCABULARY_PATTERNS);
  if (spam.length > 0) {
    problems.push(
      `vocabulary associated with bulk mail ` +
        `(${listPhrase(unique(textOfSpans(draft.body, spam)).map((hit) => quote(hit)))})`,
    );
    spans.push(...spam);
  }

  const shouting = regexSpans(draft.body, SHOUTING_PATTERN);
  if (shouting.length > 0) {
    problems.push(
      `text in capitals ` +
        `(${listPhrase(unique(textOfSpans(draft.body, shouting)).map((hit) => quote(hit)))})`,
    );
    spans.push(...shouting);
  }

  const exclamations = regexSpans(draft.body, EXCLAMATION_PATTERN);
  if (exclamations.length > MAX_EXCLAMATIONS) {
    problems.push(`${exclamations.length} exclamation marks`);
    spans.push(...exclamations);
  }

  if (problems.length === 0) return pass("G12_compliance");

  return fail(
    "G12_compliance",
    `Body does not read as professional correspondence: ${problems.join("; ")}. ` +
      `A first-contact email that reads as bulk mail costs the sender domain, not just this send.`,
    spans.sort((a, b) => a.start - b.start),
  );
};
