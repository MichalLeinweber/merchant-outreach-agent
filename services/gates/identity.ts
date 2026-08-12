/**
 * G04 and G08 — the draft names the right business, and does not carry
 * contact details the source record never held.
 */

import type { Merchant, TextSpan } from "../../shared/contracts.js";
import { listPhrase, quote, regexSpans, textOfSpans, unique } from "./text.js";
import { fail, pass, type Gate, type GateContext } from "./types.js";

// ─── G04 merchant name ─────────────────────────────────────────

/** Case-insensitive location of `needle`, as a span into `haystack`. */
function spanOfInsensitive(haystack: string, needle: string): TextSpan | null {
  if (needle.length === 0) return null;
  const start = haystack.toLowerCase().indexOf(needle.toLowerCase());
  return start === -1 ? null : { start, end: start + needle.length };
}

/**
 * The longest run of leading words from `name` that appears in `body`.
 *
 * "Lumen Coffee House" written as "Lumen Coffee" is a different failure from
 * the name being absent altogether — the model had the record in front of it
 * and shortened the name anyway. Pointing at the truncation is more use to a
 * reviewer than reporting that nothing matched.
 */
function longestNamePrefixSpan(body: string, name: string): TextSpan | null {
  const words = name.split(/\s+/).filter((word) => word.length > 0);

  for (let count = words.length - 1; count >= 1; count -= 1) {
    const prefix = words.slice(0, count).join(" ");
    const span = spanOfInsensitive(body, prefix);
    if (span !== null) return span;
  }

  return null;
}

/**
 * G04 — the merchant's name appears in the body exactly as the record spells
 * it.
 *
 * Strict about capitalisation and punctuation, because the record is the
 * authority on how a business writes its own name. Getting it nearly right is
 * the specific thing an owner notices, and it is also the cheapest possible
 * signal that the draft was assembled rather than read.
 */
export const g04MerchantName: Gate = (draft, merchant) => {
  if (draft.body.includes(merchant.name)) return pass("G04_merchant_name");

  const insensitive = spanOfInsensitive(draft.body, merchant.name);
  if (insensitive !== null) {
    const asWritten = draft.body.slice(insensitive.start, insensitive.end);
    return fail(
      "G04_merchant_name",
      `Body writes the merchant name as ${quote(asWritten)}; the record says ` +
        `${quote(merchant.name)}. The spelling must match the record exactly.`,
      [insensitive],
    );
  }

  const partial = longestNamePrefixSpan(draft.body, merchant.name);
  if (partial !== null) {
    const asWritten = draft.body.slice(partial.start, partial.end);
    return fail(
      "G04_merchant_name",
      `Body names the merchant as ${quote(asWritten)}, which is only part of ` +
        `${quote(merchant.name)} as the record spells it.`,
      [partial],
    );
  }

  return fail(
    "G04_merchant_name",
    `Body never names the merchant. The record calls it ${quote(merchant.name)}, ` +
      `and a first-contact email that does not say who it is addressed to reads as bulk mail.`,
  );
};

// ─── G08 personal data ─────────────────────────────────────────

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/**
 * Candidate phone numbers.
 *
 * Deliberately loose in shape and strict in length: the digits are counted
 * afterwards and at least nine are required, which is short enough to catch a
 * real number and long enough that a date, a review count or a price cannot
 * trip it.
 */
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;
const MIN_PHONE_DIGITS = 9;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether `host` is an allowed host or a subdomain of one. */
function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  return allowed.some((candidate) => {
    const normalised = candidate.toLowerCase();
    return host === normalised || host.endsWith(`.${normalised}`);
  });
}

function offendingEmails(body: string, merchant: Merchant, context: GateContext): TextSpan[] {
  return regexSpans(body, EMAIL_PATTERN).filter((span) => {
    const address = body.slice(span.start, span.end);
    if (address === merchant.contactEmail) return false;

    const domain = address.slice(address.indexOf("@") + 1).toLowerCase();
    return !isAllowedHost(domain, context.allowedLinkHosts);
  });
}

function offendingUrls(body: string, merchant: Merchant, context: GateContext): TextSpan[] {
  const merchantHost = merchant.websiteUrl === null ? null : hostOf(merchant.websiteUrl);

  return regexSpans(body, URL_PATTERN).filter((span) => {
    const host = hostOf(body.slice(span.start, span.end));
    if (host === null) return true;
    if (merchantHost !== null && host === merchantHost) return false;
    return !isAllowedHost(host, context.allowedLinkHosts);
  });
}

function offendingPhones(body: string): TextSpan[] {
  return regexSpans(body, PHONE_CANDIDATE_PATTERN).filter((span) => {
    const candidate = body.slice(span.start, span.end);
    const digits = candidate.replace(/\D/g, "").length;
    return digits >= MIN_PHONE_DIGITS;
  });
}

/**
 * G08 — no personal or contact data beyond what the record holds.
 *
 * The record has exactly one address for a merchant and at most one website.
 * Anything else the draft prints — another mailbox, a phone number, a link to
 * somewhere neither we nor the merchant own — was not in the input, which
 * leaves the model as its only possible source.
 *
 * Phone numbers are always a failure, because `Merchant` has no phone field:
 * there is no value one could have been copied from.
 *
 * Not attempted: recognising a person's name in prose. There is no reliable
 * way to do it, and a gate that guesses is worse than one that admits its
 * scope — the compliance review that reads this report needs to know which is
 * which.
 */
export const g08Pii: Gate = (draft, merchant, context) => {
  const emails = offendingEmails(draft.body, merchant, context);
  const urls = offendingUrls(draft.body, merchant, context);
  const phones = offendingPhones(draft.body);

  const spans = [...emails, ...urls, ...phones].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return pass("G08_pii");

  const problems: string[] = [];
  if (emails.length > 0) {
    problems.push(
      `email address(es) ${listPhrase(unique(textOfSpans(draft.body, emails)).map((hit) => quote(hit)))}`,
    );
  }
  if (urls.length > 0) {
    problems.push(
      `link(s) to ${listPhrase(unique(textOfSpans(draft.body, urls)).map((hit) => quote(hit)))}`,
    );
  }
  if (phones.length > 0) {
    problems.push(
      `phone number(s) ${listPhrase(unique(textOfSpans(draft.body, phones)).map((hit) => quote(hit)))}`,
    );
  }

  return fail(
    "G08_pii",
    `Body contains contact data the source record does not hold: ${problems.join("; ")}. ` +
      `The record holds ${quote(merchant.contactEmail)}` +
      `${merchant.websiteUrl === null ? " and no website" : ` and ${quote(merchant.websiteUrl)}`}.`,
    spans,
  );
};
