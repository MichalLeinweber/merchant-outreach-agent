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
import {
  allRegexSpans,
  listPhrase,
  quote,
  regexSpans,
  textOfSpans,
  unique,
  wordPatterns,
} from "./text.js";
import { fail, pass, type Gate } from "./types.js";

// ─── A note on the language-dependent gates ────────────────────

/**
 * G10 and G12 match vocabulary, and vocabulary is per-language.
 *
 * The campaign writes in cs, de, es and nl as well as English, and until this
 * was fixed the lists below were English-only. That did not make the gates
 * lenient in an obvious way — it made them *silently inert*: every non-English
 * draft was reported as "asks the reader to do nothing" by G10 (all three of
 * the recorded cs/de/es drafts had a perfectly good call to action), and G12
 * blocked "no obligation" in English while passing "unverbindlich" in German.
 * A gate that never fires is indistinguishable from a gate with nothing to
 * report, which is the worst way for a check to fail.
 *
 * **These lists are fragile, and knowingly so.** A phrase list cannot cover a
 * language; it covers the handful of constructions this prompt actually
 * produces. Word order, inflection, politeness register and regional variants
 * all defeat it — German splits verbs across a clause, Czech declines
 * everything, and "meld u aan" and "aanmelden" are the same ask. Every entry
 * is a guess that some future draft will phrase it this way.
 *
 * That fragility is the reason **G10 stays a warning**. It is a quality
 * signal, and a wrong quality signal costs a reviewer ten seconds. Promoting
 * it to blocking would mean a missing phrase in this list silently stops a
 * legitimate send, and the failure would be invisible in exactly the locales
 * with the fewest people reading the output.
 *
 * G12 is blocking, so the standard for adding a phrase there is higher: it
 * belongs only if the phrase is spam vocabulary in that language the way "act
 * now" is in English, not merely because it translates something on the list.
 * The borderline entries — German "unverbindlich", Dutch "vrijblijvend" — are
 * ordinary business register in their own markets and are here because they
 * are the direct equivalent of "no obligation", which English already blocks.
 * If they turn out to fire on good drafts, remove them; do not add exceptions
 * on top of them.
 *
 * Anything matched here uses `wordPattern`, never `\b` — see `text.ts` for
 * why `\b` cannot see the end of "aquí".
 */

// ─── G07 banned claims ─────────────────────────────────────────

/**
 * Claims the marketplace does not make.
 *
 * English only, on purpose: these are the specific superlatives this prompt
 * reaches for, and a translated superlative is a different phrase with
 * different edges. The equivalents belong here when a draft is seen using
 * them, not before.
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

/**
 * "best" as a sign-off occupying its own line: "Best,", "Best regards".
 *
 * A superlative in the body ("the best prices in town") and a closing in a
 * signature are the same word doing unrelated jobs, and they are told apart by
 * position, not by wording — a sign-off is the whole line.
 *
 * The pattern in `BANNED_CLAIM_PATTERNS` already excuses "Best regards" and
 * "Best wishes" wherever they appear, which covers "Best regards, Tom" on one
 * line. It did not excuse a bare "Best," on its own, which is how most of
 * these drafts actually close — two of the ten recorded drafts were blocked
 * for their signature. Both exceptions are kept: this one is narrow enough
 * that "Best prices in town." at the start of a line is still caught, because
 * nothing but an optional comma may follow.
 */
const BEST_SIGN_OFF_LINE = /^best(?:\s+(?:regards|wishes))?[^\S\n]*,?[^\S\n]*$/gim;

export const g07BannedClaims: Gate = (draft) => {
  const signOffs = regexSpans(draft.body, BEST_SIGN_OFF_LINE);
  const bodySpans = allRegexSpans(draft.body, BANNED_CLAIM_PATTERNS).filter(
    (span) =>
      !signOffs.some((signOff) => span.start >= signOff.start && span.end <= signOff.end),
  );
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
 * Kinds of ask, one list of phrasings each.
 *
 * The gate counts *kinds*, not matches, and a link is not one of them. A
 * message that says "register your interest using the link below" makes one
 * ask through one mechanism; counting the link separately would fail the
 * correct shape of email. What the gate is looking for is a message asking
 * the reader to do two different things — reply *and* book a slot — which is
 * the ambiguity that costs a reply. Listing five ways to say "register" under
 * one kind is therefore free; putting one of them under the wrong kind is not.
 *
 * **Conditionals are deliberately absent.** "If that's of interest, you can
 * register here" is one ask, not two, so English does not list "of interest"
 * and the other languages must not list their equivalents either — "si le
 * interesa", "wenn Sie Interesse haben", "pokud by vás to zajímalo". Adding
 * them would turn the single correct closing sentence this prompt writes into
 * a two-CTA failure in every locale but English.
 */
const CTA_SOURCES: Record<string, readonly string[]> = {
  reply: [
    "reply",
    "write back",
    "get back to me",
    // cs
    "odpovězte",
    "napište (mi|nám)",
    // de
    "antworten Sie",
    "schreiben Sie (mir|uns) zurück",
    // es
    "responda(me)?",
    "contés?te(me)?",
    // nl
    "antwoord",
    "reageer",
  ],
  meeting: [
    "book a (slot|call|time|meeting)",
    "schedule a (call|meeting|chat)",
    "arrange a (call|meeting|chat)",
    "set up a (call|meeting|chat)",
    "in my (diary|calendar)",
    // cs
    "domluvme( si)? (schůzku|hovor|telefonát)",
    "domluvit si (schůzku|hovor)",
    "zavolejme si",
    // de
    "(einen )?Termin (vereinbaren|buchen)",
    "(ein )?Gespräch vereinbaren",
    // es
    "(concertar|agendar|reservar) una (llamada|reunión|cita)",
    // nl
    "(een )?(afspraak|gesprek) (inplannen|maken)",
  ],
  // Matched on the verb stem rather than on whole phrases. Listing closings
  // instead — "register your interest", "register here" — was too tight even
  // for English: the recorded drafts wrote "register your details here" and
  // "register to hear more here", and the gate reported that they asked for
  // nothing. The ask is carried by the verb; what follows it is style.
  register: [
    "regist\\p{L}*", // register, registering, registrieren, registrar, registreer
    "sign up",
    "create an account",
    // cs — the prefixed forms cannot be reached from the stem above, and the
    // ask is as often "confirm your interest" as it is "register"
    "zaregistr\\p{L}*",
    "přihlas\\p{L}*",
    "zájem (potvrdit|vyjádřit|projevit)",
    "(potvrďte|vyjádřete|projevte)( svůj)? zájem",
    // de
    "Interesse (bekunden|anmelden|hinterlegen)",
    "melden Sie sich an",
    // es
    "regístr\\p{L}*",
    "(inscrib|inscríb|apúnt)\\p{L}*",
    // nl
    "meld u aan",
    "(aanmelden|inschrijven)",
    "interesse (kenbaar maken|doorgeven|aangeven)",
  ],
  visit: [
    "click here",
    "visit (our|the) (site|website|page)",
    // cs
    "klikněte (zde|sem)",
    "navštivte (naše |náš )?(stránky|web|webové stránky)",
    // de
    "klicken Sie hier",
    "besuchen Sie (unsere|unser) (Website|Seite)",
    // es
    "haga clic aquí",
    "visite (nuestro|nuestra) (sitio|página|web)",
    // nl
    "klik hier",
    "bezoek onze (website|pagina)",
  ],
  question: [
    "would you like",
    "let me know",
    "are you interested",
    // cs
    "dejte (mi|nám) vědět",
    // de
    "lassen Sie es mich wissen",
    "sagen Sie mir Bescheid",
    "hätten Sie Interesse",
    // es
    "hágamelo saber",
    "avís(enos|eme)",
    // nl
    "laat het (me|mij|ons) weten",
  ],
};

/**
 * The one English pattern that cannot be written as a bounded phrase: it spans
 * a clause ("would a weekday offer be worth a look?").
 */
const WORTH_IT_QUESTION = /\bwould\b[^.?!]{0,60}\bbe worth\b/i;

const CTA_PATTERNS: Record<string, readonly RegExp[]> = Object.fromEntries(
  Object.entries(CTA_SOURCES).map(([kind, sources]) => [
    kind,
    kind === "question"
      ? [...wordPatterns(sources), WORTH_IT_QUESTION]
      : wordPatterns(sources),
  ]),
);

/**
 * G10 — exactly one call to action.
 *
 * A warning, not a blocker, per the gate table: two asks make a message worse
 * without making it untrue, and blocking a send over it would put a
 * cosmetic defect on the same footing as an invented number.
 */
export const g10SingleCta: Gate = (draft) => {
  const matched: { kind: string; spans: TextSpan[] }[] = [];

  for (const [kind, patterns] of Object.entries(CTA_PATTERNS)) {
    const spans = allRegexSpans(draft.body, patterns);
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
  ...wordPatterns([
    "act now",
    "limited time",
    "hurry",
    "last chance",
    "don'?t miss",
    "today only",
    "expires? (soon|today)",
    "while (stocks|places) last",
    "(spots|places|slots) remaining",
    "urgent",
    // cs
    "jednejte (ihned|rychle|hned)",
    "omezen(á|ou) (dobu?|nabídk[au])",
    "poslední (šance|příležitost)",
    "nenechte si (to )?ujít",
    "(pouze|jen) dnes",
    "končí (dnes|brzy)",
    "spěchejte",
    "naléhavé",
    // de
    "jetzt handeln",
    "begrenzte Zeit",
    "letzte Chance",
    "verpassen Sie (es )?nicht",
    "nur heute",
    "läuft (heute|bald) ab",
    "beeilen Sie sich",
    "dringend",
    // es
    "actúe ahora",
    "tiempo limitado",
    "última oportunidad",
    "no se lo pierda",
    "s[oó]lo hoy",
    "expira (hoy|pronto)",
    "dese prisa",
    "urgente",
    // nl
    "nu handelen",
    "beperkte tijd",
    "laatste kans",
    "mis het niet",
    "alleen vandaag",
    "verloopt (vandaag|binnenkort)",
    "haast u",
    "dringend",
  ]),
  // Counted quantities keep their digits, so they stay plain patterns.
  /\bonly \d+ (?:spots|places|slots) left\b/i,
  /(?<!\p{L})(?:zbývá|zbývají|zbývá už jen) \d+ míst/iu,
  /(?<!\p{L})nur noch \d+ (?:Plätze|Plätzen)/iu,
  /(?<!\p{L})s[oó]lo quedan \d+ (?:plazas|lugares)/iu,
  /(?<!\p{L})nog maar \d+ (?:plaatsen|plekken)/iu,
];

const SPAM_VOCABULARY_PATTERNS: readonly RegExp[] = wordPatterns([
  "free money",
  "no obligation",
  "buy now",
  "100% free",
  "congratulations",
  "you'?ve won",
  "cash bonus",
  // cs
  "peníze zdarma",
  "bez závazk[uů]",
  "nezávazně",
  "kupte (si )?(teď|ihned)",
  "100 ?% zdarma",
  "gratulujeme",
  "(vyhráli|vyhrál) jste",
  // de
  "gratis Geld",
  "unverbindlich",
  "jetzt kaufen",
  "100 ?% kostenlos",
  "herzlichen Glückwunsch",
  "Sie haben gewonnen",
  // es
  "dinero gratis",
  "sin compromiso",
  "compre ahora",
  "100 ?% gratis",
  "(enhorabuena|felicidades)",
  "ha ganado",
  // nl
  "gratis geld",
  "vrijblijvend",
  "koop nu",
  "100 ?% gratis",
  "gefeliciteerd",
  "u (heeft|hebt) gewonnen",
]);

/**
 * Three or more consecutive words in capitals — shouting, not emphasis.
 *
 * `\p{Lu}` rather than `[A-Z]`, so "ÚŽASNÁ NABÍDKA DNES" shouts as loudly as
 * its English equivalent. The `\b`s go with it, for the reason in `text.ts`.
 */
const SHOUTING_PATTERN =
  /(?<!\p{L})\p{Lu}{2,}(?!\p{L})(?:[\s,]+(?<!\p{L})\p{Lu}{2,}(?!\p{L})){2,}/u;

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
