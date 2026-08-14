/**
 * Text helpers shared by the gates.
 *
 * Everything here works in offsets into the body, because that is what the
 * interface highlights with. A gate that knows a phrase is wrong but cannot
 * say where it is forces the reviewer to search for it by eye.
 */

import type { TextSpan } from "../../shared/contracts.js";

/** Words, counted the way a person would: runs of non-whitespace. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Every occurrence of `needle` in `haystack`, left to right. */
export function spansOf(haystack: string, needle: string): TextSpan[] {
  if (needle.length === 0) return [];

  const spans: TextSpan[] = [];
  let from = 0;

  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return spans;
    spans.push({ start, end: start + needle.length });
    from = start + needle.length;
  }
}

/**
 * The first occurrence of `needle` that no span in `taken` already covers.
 *
 * Two evidence refs may legitimately quote the same phrase, and each should
 * highlight its own occurrence rather than both landing on the first one.
 */
export function firstFreeSpan(
  haystack: string,
  needle: string,
  taken: readonly TextSpan[],
): TextSpan | null {
  for (const span of spansOf(haystack, needle)) {
    const overlaps = taken.some(
      (other) => span.start < other.end && other.start < span.end,
    );
    if (!overlaps) return span;
  }
  return null;
}

/**
 * Every match of `pattern` in `text`, as spans.
 *
 * The pattern is recompiled with the global flag, so a caller can pass a
 * plain regex without having to think about `lastIndex` being carried between
 * calls — a shared stateful regex is a classic source of results that change
 * depending on what ran before them.
 */
export function regexSpans(text: string, pattern: RegExp): TextSpan[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);

  const spans: TextSpan[] = [];
  for (const match of text.matchAll(global)) {
    if (match.index === undefined) continue;
    // A zero-length match would loop forever and highlight nothing.
    if (match[0].length === 0) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Spans for every pattern in `patterns` that matches, concatenated in order. */
export function allRegexSpans(text: string, patterns: readonly RegExp[]): TextSpan[] {
  return patterns.flatMap((pattern) => regexSpans(text, pattern));
}

/**
 * A phrase bounded by non-letters, matched case-insensitively.
 *
 * `\b` cannot be used for this outside English. It is defined in terms of
 * `\w`, which is `[A-Za-z0-9_]` — and stays that way even under the `u` flag.
 * So `/\baquí\b/u` does not match "aquí": the final `í` is not a word
 * character, so there is no word boundary after it to assert. The same trap
 * catches "zájem", "grüße" and every other word ending in an accented letter,
 * and it fails *silently* — the pattern simply never matches, and a gate that
 * never fires looks exactly like a gate with nothing to report.
 *
 * `\p{L}` is every letter in every script, so the lookarounds below mean what
 * `\b` was supposed to mean. `source` is spliced in as a pattern, not escaped,
 * so callers can pass alternations: `wordPattern("odpov(ěz|ězte)")`.
 */
export function wordPattern(source: string): RegExp {
  return new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, "iu");
}

/** `wordPattern` over a list, for the vocabulary lists the gates are built from. */
export function wordPatterns(sources: readonly string[]): RegExp[] {
  return sources.map(wordPattern);
}

/** The substrings a set of spans covers, for use in a failure message. */
export function textOfSpans(text: string, spans: readonly TextSpan[]): string[] {
  return spans.map((span) => text.slice(span.start, span.end));
}

/** Distinct values, preserving first-seen order. Failure messages read better. */
export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Quoted and shortened, so one runaway sentence cannot fill a detail line. */
export function quote(value: string, maxLength = 60): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const shown =
    collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
  return JSON.stringify(shown);
}

/** "a, b and c" — for listing what a gate objected to. */
export function listPhrase(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0] as string;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1] as string}`;
}
