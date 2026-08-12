/**
 * Finding numbers in prose and deciding whether the record supports them.
 *
 * This is the machinery behind G06, and the reason it is not a one-liner is
 * that the same quantity has many spellings. A rating of 4.8 can be written
 * "4.8" or "4,8"; a review count of 1234 can be "1,234", "1.234" or "1 234".
 * A gate that only recognised one of those would report a hallucination every
 * time the model wrote a number correctly in a European locale, and a gate
 * that cried wolf would be switched off within a week.
 *
 * The tolerance is entirely in *reading* the number. Once read, the value has
 * to be in the record — there is no tolerance at all on that side, and
 * nothing is derived. A body claiming "in business since 2023" is not
 * supported by `yearsInBusiness: 3` even though the arithmetic works, because
 * the arithmetic needs today's date: the same draft would pass this year and
 * fail the next. A gate whose verdict depends on when it ran is not a gate.
 */

import type { Merchant } from "../../shared/contracts.js";
import { MERCHANT_FIELDS } from "./record.js";

/** A number as it appears in the text, with its offsets. */
export interface NumberToken {
  text: string;
  start: number;
  end: number;
}

/**
 * Space characters that group digits. Written as escapes rather than typed
 * literally: a no-break space in source is invisible to a reviewer and to
 * most diffs, and this is a line where the difference between one space
 * character and another decides whether a number is read at all.
 */
const DIGIT_GROUP_SPACE = "[\\u00A0\\u202F ]";

/**
 * Digit runs, including their separators.
 *
 * The first alternative claims space-grouped thousands ("1 234 567") before
 * the second can stop at the first group. Only exact groups of three are
 * accepted there, so "2026 40" in "since 2026 40 seats" stays two tokens
 * rather than becoming one.
 */
const NUMBER_TOKEN_PATTERN = new RegExp(
  `\\d{1,3}(?:${DIGIT_GROUP_SPACE}\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)*`,
  "g",
);

const DIGIT_GROUP_SPACE_PATTERN = new RegExp(DIGIT_GROUP_SPACE, "g");

export function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];

  for (const match of text.matchAll(NUMBER_TOKEN_PATTERN)) {
    if (match.index === undefined) continue;
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
}

/**
 * Every value a written number could reasonably denote.
 *
 * Ambiguity is kept rather than resolved: "1.234" is 1234 to a German reader
 * and 1.234 to an English one, and this returns both. The token counts as
 * grounded if *any* reading is in the record, which is the right way round —
 * the alternative is accusing the model of inventing a number that it wrote
 * correctly for its locale.
 *
 * Shapes that match none of the rules — "1,2345", "12,34,56" — yield nothing
 * and are therefore ungrounded. That is deliberate: a number nobody can read
 * is not a number the record supports.
 */
export function numericInterpretations(token: string): number[] {
  const clean = token.replace(DIGIT_GROUP_SPACE_PATTERN, "");
  const readings = new Set<number>();

  const add = (value: number): void => {
    if (Number.isFinite(value)) readings.add(value);
  };

  // 62, 2026
  if (/^\d+$/.test(clean)) add(Number(clean));
  // 4.8, 4.80
  if (/^\d+\.\d+$/.test(clean)) add(Number(clean));
  // 4,8 — decimal comma. Three digits after it would be a thousands group.
  if (/^\d+,\d{1,2}$/.test(clean)) add(Number(clean.replace(",", ".")));
  // 1,234 — thousands, en style
  if (/^\d{1,3}(?:,\d{3})+$/.test(clean)) add(Number(clean.replace(/,/g, "")));
  // 1.234 — thousands, de/cs style
  if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) add(Number(clean.replace(/\./g, "")));
  // 1,234.56
  if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(clean)) add(Number(clean.replace(/,/g, "")));
  // 1.234,56
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(clean)) {
    add(Number(clean.replace(/\./g, "").replace(",", ".")));
  }

  return [...readings];
}

/**
 * Every number the source record can support.
 *
 * Numeric fields contribute their value. String fields contribute any number
 * written inside them, which is what lets a merchant called "Studio 66" be
 * named in the body, and what makes the parts of `lastOfferEndedAt` — its
 * year, month and day — quotable.
 *
 * Only `Merchant` fields are read. `EnrichedMerchant.signals` are derived
 * text, and grounding one generated string against another proves nothing.
 */
export function groundedNumbers(merchant: Merchant): Set<number> {
  const grounded = new Set<number>();

  for (const field of MERCHANT_FIELDS) {
    const value = merchant[field];

    if (typeof value === "number") {
      grounded.add(value);
      continue;
    }

    if (typeof value === "string") {
      for (const token of numberTokens(value)) {
        for (const reading of numericInterpretations(token.text)) {
          grounded.add(reading);
        }
      }
    }
  }

  return grounded;
}

/** Whether any reading of `token` is a number the record contains. */
export function isGrounded(token: string, grounded: ReadonlySet<number>): boolean {
  return numericInterpretations(token).some((reading) => grounded.has(reading));
}
