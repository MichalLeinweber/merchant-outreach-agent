/**
 * Prompt loading.
 *
 * Prompts live in Markdown next to this file rather than in string literals,
 * so they can be edited and reviewed as prose. Each file holds two sections
 * marked by HTML comments:
 *
 *     <!-- system -->   ... becomes the system prompt
 *     <!-- user -->     ... becomes the user message
 *
 * The system section is the stable, cacheable prefix: identical for every
 * merchant in a campaign. Only the user section varies, which is what makes
 * prompt caching worth anything here.
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { PromptError } from "../../shared/errors.js";
import { fromAppRoot } from "../../shared/paths.js";

/** Resolved lazily: the app root depends on the working directory at call time. */
function promptDir(): string {
  return fromAppRoot("services", "agents", "prompts");
}

export type PromptName = "triage" | "draft";

export interface PromptTemplate {
  system: string;
  user: string;
}

/**
 * Section markers, matched only when a marker is alone on its line.
 *
 * Anchoring to the line matters: the prompt files document their own format
 * in an authoring comment, so the marker text appears inside prose there too.
 * A plain substring search finds that mention first and splits the file in
 * the wrong place — quietly, with the model receiving the fragments.
 */
const SYSTEM_MARKER = /^[ \t]*<!--[ \t]*system[ \t]*-->[ \t]*$/m;
const USER_MARKER = /^[ \t]*<!--[ \t]*user[ \t]*-->[ \t]*$/m;

/** Parsed templates, keyed by name. Prompts do not change while a run is in flight. */
const cache = new Map<PromptName, PromptTemplate>();

export async function loadPrompt(name: PromptName): Promise<PromptTemplate> {
  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = path.join(promptDir(), `${name}.md`);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new PromptError(name, `cannot be read from ${filePath}`, { cause });
  }

  const template = parsePromptTemplate(name, raw);
  cache.set(name, template);
  return template;
}

/** Exported for tests; production code goes through `loadPrompt`. */
export function parsePromptTemplate(name: PromptName, raw: string): PromptTemplate {
  const system = SYSTEM_MARKER.exec(raw);
  const user = USER_MARKER.exec(raw);

  if (!system || !user) {
    throw new PromptError(
      name,
      "must contain a system marker and a user marker, each alone on its own line",
    );
  }
  if (user.index < system.index) {
    throw new PromptError(name, "has the user marker before the system marker");
  }

  return {
    system: stripAuthoringNotes(
      name,
      "system",
      raw.slice(system.index + system[0].length, user.index),
    ),
    user: stripAuthoringNotes(name, "user", raw.slice(user.index + user[0].length)),
  };
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const THREE_OR_MORE_NEWLINES = /\n{3,}/g;

/**
 * Remove `<!-- ... -->` blocks.
 *
 * The prompt files carry notes for whoever edits them — what the placeholders
 * are, which limits the schema cannot enforce, what still needs writing.
 * Those are instructions to a person, not to the model. Without this they
 * would be sent verbatim as part of the system prompt: paid for on every
 * call, and telling the model about TODOs it is in no position to act on.
 */
function stripAuthoringNotes(
  name: PromptName,
  section: "system" | "user",
  text: string,
): string {
  const stripped = text
    .replace(HTML_COMMENT, "")
    .replace(THREE_OR_MORE_NEWLINES, "\n\n")
    .trim();

  // HTML comments cannot nest: `<!-- a <!-- b --> c -->` ends at the first
  // `-->`, leaving `c -->` behind as prose. Rather than ship those leftovers
  // to the model inside the system prompt, say so.
  if (stripped.includes("<!--") || stripped.includes("-->")) {
    throw new PromptError(
      name,
      `has an unterminated or nested comment in its ${section} section. ` +
        `HTML comments cannot nest — a "-->" inside a comment closes it early. ` +
        `Rewrite the note so it contains no comment delimiters.`,
    );
  }

  return stripped;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{name}}` placeholders.
 *
 * An unknown placeholder throws rather than rendering as an empty string. A
 * prompt with a silently blank section still produces confident-looking
 * output, which is exactly the failure this project exists to avoid.
 */
export function renderPrompt(
  name: PromptName,
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const missing: string[] = [];

  const rendered = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.push(key);
      return "";
    }
    return value;
  });

  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    throw new PromptError(
      name,
      `uses placeholder(s) with no value supplied: ${unique.map((k) => `{{${k}}}`).join(", ")}. ` +
        `Available: ${Object.keys(values).map((k) => `{{${k}}}`).join(", ") || "(none)"}`,
    );
  }

  return rendered;
}

/** Test hook. Production code never needs this. */
export function clearPromptCache(): void {
  cache.clear();
}
