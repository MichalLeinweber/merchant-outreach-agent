/**
 * G09 — the draft is written in the language the merchant expects.
 *
 * Two checks with very different confidence, kept separate on purpose.
 *
 * The first is exact: `draft.locale` must equal `merchant.locale`. It is a
 * comparison of two recorded values and it is never wrong.
 *
 * The second is a heuristic: the prose itself is scored against small sets of
 * function words and must look like the language the locale names. It exists
 * because the first check cannot see the body at all — a draft correctly
 * labelled `de-DE` and written in English passes it without complaint. The
 * heuristic catches that, which is the failure that actually reaches a
 * merchant, and it is tuned to catch only that: a wholesale mismatch, not a
 * borrowed phrase or an awkward sentence. Anything subtler is a job for the
 * judge in the eval suite, which has a model to think with and no power to
 * block a send.
 */

import type { TextSpan } from "../../shared/contracts.js";
import { allRegexSpans, countWords, quote, regexSpans, textOfSpans, unique } from "./text.js";
import { fail, pass, type Gate } from "./types.js";

/**
 * Function words per language. Short, common and grammatical rather than
 * topical — content words would score whatever the email happens to be about.
 * Only the languages in the merchant dataset are listed; an unknown language
 * skips the prose check rather than guessing.
 */
const FUNCTION_WORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "your", "you", "with", "that", "for", "this", "are", "have", "from", "would"],
  de: ["der", "die", "das", "und", "ist", "für", "mit", "ihre", "nicht", "haben", "eine", "auch"],
  fr: ["le", "la", "les", "des", "une", "est", "pour", "avec", "vous", "votre", "dans", "que"],
  es: ["el", "la", "los", "las", "una", "para", "con", "que", "por", "más", "está", "su"],
  nl: ["het", "een", "van", "voor", "met", "uw", "niet", "zijn", "wij", "dat", "maar", "ook"],
  pl: ["nie", "jest", "dla", "się", "które", "oraz", "przez", "jako", "tego", "aby", "już", "państwa"],
  cs: ["je", "pro", "se", "které", "jako", "vaše", "více", "nebo", "ale", "když", "této", "podle"],
};

/**
 * Spellings this project treats as out of place in en-GB and en-IE.
 *
 * House style, not a claim about correctness — "-ize" is defensible British
 * usage and Oxford prefers it. The marketplace writes "-ise" to its UK and
 * Irish partners, and a draft that switches to American spelling mid-campaign
 * is the visible edge of a model that has drifted to a different register.
 */
const AMERICAN_SPELLINGS: readonly RegExp[] = [
  /\bcolors?\b/i,
  /\bfavorites?\b/i,
  /\bcenters?\b/i,
  /\btheaters?\b/i,
  /\bneighborhoods?\b/i,
  /\bcanceled\b/i,
  /\bcatalogs?\b/i,
  /\banalyz(e|es|ed|ing)\b/i,
  /\btravelers?\b/i,
];

/**
 * The "-ize" family, which needs a filter rather than a pattern.
 *
 * "organize" is an American spelling in this project's house style; "size",
 * "seize" and "downsize" merely end the same way. A naive `\w+ize` rule fails
 * every draft that mentions the size of a venue — which is most of them,
 * since `seatsOrCapacity` is one of the few things there is to say. The
 * minimum stem length removes the short accidents and the exception list
 * removes the rest.
 */
const IZE_PATTERN = /\b\w{3,}iz(?:e|es|ed|ing|ation|ations)\b/i;

const IZE_EXCEPTIONS: ReadonlySet<string> = new Set([
  "resize",
  "resizes",
  "resized",
  "resizing",
  "capsize",
  "capsizes",
  "capsized",
  "capsizing",
  "downsize",
  "downsizes",
  "downsized",
  "downsizing",
  "oversize",
  "oversized",
]);

function americanSpellingSpans(body: string): TextSpan[] {
  const plain = allRegexSpans(body, AMERICAN_SPELLINGS);

  const ize = regexSpans(body, IZE_PATTERN).filter(
    (span) => !IZE_EXCEPTIONS.has(body.slice(span.start, span.end).toLowerCase()),
  );

  return [...plain, ...ize].sort((a, b) => a.start - b.start);
}

const BRITISH_ENGLISH_REGIONS = new Set(["GB", "IE", "AU", "NZ"]);

/** Words of the body, lowercased, punctuation removed. */
function words(text: string): string[] {
  return [...text.toLowerCase().matchAll(/\p{L}+/gu)].map((match) => match[0]);
}

/** How many function words of `language` the body uses. */
function score(bodyWords: readonly string[], language: string): number {
  const markers = FUNCTION_WORDS[language];
  if (markers === undefined) return 0;

  const set = new Set(markers);
  return bodyWords.filter((word) => set.has(word)).length;
}

/**
 * A body has to look this much more like another language than the expected
 * one before the gate calls it a mismatch. Function-word sets overlap between
 * neighbouring languages, and a margin is what keeps that overlap from
 * producing failures on correct drafts.
 */
const LANGUAGE_MARGIN = 3;

/** Below this length, function-word counting says nothing worth acting on. */
const MIN_WORDS_FOR_DETECTION = 20;

interface LanguageVerdict {
  expected: number;
  best: { language: string; hits: number } | null;
}

function detect(bodyWords: readonly string[], expectedLanguage: string): LanguageVerdict {
  const expected = score(bodyWords, expectedLanguage);

  let best: { language: string; hits: number } | null = null;
  for (const language of Object.keys(FUNCTION_WORDS)) {
    if (language === expectedLanguage) continue;
    const hits = score(bodyWords, language);
    if (best === null || hits > best.hits) best = { language, hits };
  }

  return { expected, best };
}

export const g09Locale: Gate = (draft, merchant) => {
  if (draft.locale !== merchant.locale) {
    return fail(
      "G09_locale",
      `Draft is labelled ${quote(draft.locale)} but the merchant record says ` +
        `${quote(merchant.locale)}. The draft was written for the wrong market.`,
    );
  }

  const [language = "", region = ""] = draft.locale.split("-");
  const bodyWords = words(draft.body);

  // Prose check. Skipped for a language with no marker set and for a body too
  // short to score, in both cases because the check would be noise.
  if (FUNCTION_WORDS[language] !== undefined && countWords(draft.body) >= MIN_WORDS_FOR_DETECTION) {
    const { expected, best } = detect(bodyWords, language);

    if (best !== null && best.hits - expected >= LANGUAGE_MARGIN) {
      return fail(
        "G09_locale",
        `Body does not read as ${language}: it uses ${best.hits} ${best.language} ` +
          `function words against ${expected} ${language} ones. ` +
          `The merchant's locale is ${quote(merchant.locale)}.`,
      );
    }
  }

  // Regional spelling. Only meaningful for English, where the two standards
  // differ in ways a reader in these markets notices.
  if (language === "en" && BRITISH_ENGLISH_REGIONS.has(region)) {
    const spans: TextSpan[] = americanSpellingSpans(draft.body);
    if (spans.length > 0) {
      const hits = unique(textOfSpans(draft.body, spans)).map((hit) => quote(hit));
      return fail(
        "G09_locale",
        `Draft locale is ${quote(draft.locale)} but the body uses US spelling: ` +
          `${hits.join(", ")}.`,
        spans,
      );
    }
  }

  return pass("G09_locale");
};
