import { describe, expect, it } from "vitest";

import { PromptError } from "../../shared/errors.js";
import { loadPrompt, parsePromptTemplate, renderPrompt } from "./prompts.js";

describe("parsePromptTemplate", () => {
  it("splits the file into a system and a user section", () => {
    const template = parsePromptTemplate(
      "triage",
      "<!-- system -->\nYou score merchants.\n<!-- user -->\nHere is one.",
    );

    expect(template.system).toBe("You score merchants.");
    expect(template.user).toBe("Here is one.");
  });

  it("strips authoring notes so they are never sent to the model", () => {
    const template = parsePromptTemplate(
      "triage",
      "<!-- system -->\n<!--\n  TODO: write this. Placeholders: {{merchant}}\n-->\nScore it.\n<!-- user -->\nGo.",
    );

    expect(template.system).toBe("Score it.");
    expect(template.system).not.toContain("TODO");
    expect(template.system).not.toContain("{{merchant}}");
  });

  it.each([
    ["no markers at all", "Just prose."],
    ["only a system marker", "<!-- system -->\nHello."],
    ["only a user marker", "<!-- user -->\nHello."],
  ])("rejects a file with %s", (_label, raw) => {
    expect(() => parsePromptTemplate("triage", raw)).toThrow(PromptError);
  });

  it("rejects the sections being the wrong way round", () => {
    expect(() =>
      parsePromptTemplate("triage", "<!-- user -->\nGo.\n<!-- system -->\nScore it."),
    ).toThrow(/before/);
  });

  it("splits on the real markers, not on marker text quoted in a comment", () => {
    // The real prompt files document their own format, so words like "user
    // marker" appear in prose there. Splitting on a mention would hand the
    // model the fragments — quietly.
    const template = parsePromptTemplate(
      "triage",
      [
        "<!-- system -->",
        "<!--",
        "  Text after the user marker below becomes the user message.",
        "-->",
        "Score it.",
        "<!-- user -->",
        "Go.",
      ].join("\n"),
    );

    expect(template.system).toBe("Score it.");
    expect(template.user).toBe("Go.");
  });

  it("refuses a comment that closes itself early instead of leaking the remainder", () => {
    // HTML comments cannot nest. Quoting `-->` inside one ends it there, and
    // the rest would otherwise be sent to the model as prose.
    expect(() =>
      parsePromptTemplate(
        "triage",
        ["<!-- system -->", "<!--", "  quoting --> inside a note", "-->", "Score it.", "<!-- user -->", "Go."].join("\n"),
      ),
    ).toThrow(/cannot nest/);
  });

  it("does not treat a marker as a marker when it shares a line with prose", () => {
    expect(() =>
      parsePromptTemplate("triage", "<!-- system -->\nScore it. <!-- user --> now."),
    ).toThrow(PromptError);
  });
});

describe("renderPrompt", () => {
  it("substitutes a placeholder", () => {
    expect(renderPrompt("triage", "Merchant: {{merchant}}", { merchant: "Lumen" })).toBe(
      "Merchant: Lumen",
    );
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderPrompt("triage", "{{ merchant }}", { merchant: "Lumen" })).toBe("Lumen");
  });

  it("throws on an unknown placeholder rather than rendering it blank", () => {
    // A prompt with a silently empty section still produces confident output.
    expect(() => renderPrompt("triage", "{{nope}}", { merchant: "Lumen" })).toThrow(
      PromptError,
    );
  });

  it("names the missing placeholder and what was available", () => {
    const error = (() => {
      try {
        renderPrompt("draft", "{{nope}} {{alsoNope}}", { merchant: "Lumen" });
      } catch (e) {
        return e as PromptError;
      }
      throw new Error("expected renderPrompt to throw");
    })();

    expect(error.message).toContain("{{nope}}");
    expect(error.message).toContain("{{alsoNope}}");
    expect(error.message).toContain("{{merchant}}");
  });

  it("leaves an unused value alone", () => {
    expect(renderPrompt("triage", "static", { merchant: "Lumen" })).toBe("static");
  });
});

describe("the prompt files on disk", () => {
  it.each(["triage", "draft"] as const)("%s parses into both sections", async (name) => {
    const template = await loadPrompt(name);

    expect(template.system.length).toBeGreaterThan(0);
    expect(template.user.length).toBeGreaterThan(0);
  });

  it("triage exposes the merchant to the user section", async () => {
    const { user } = await loadPrompt("triage");
    expect(user).toContain("{{merchant}}");
  });

  it("draft exposes merchant, locale and campaign to the user section", async () => {
    const { user } = await loadPrompt("draft");

    expect(user).toContain("{{merchant}}");
    expect(user).toContain("{{locale}}");
    expect(user).toContain("{{campaignId}}");
  });

  it.each(["triage", "draft"] as const)(
    "%s carries no leftover authoring notes",
    async (name) => {
      const { system, user } = await loadPrompt(name);

      expect(system).not.toContain("<!--");
      expect(user).not.toContain("<!--");
    },
  );

  it.each(["triage", "draft"] as const)(
    "%s keeps its system section free of placeholders",
    async (name) => {
      // The system section is the cached prefix. A placeholder there would
      // make it vary per merchant and quietly cost a cache write every call.
      const { system } = await loadPrompt(name);

      expect(system).not.toMatch(/\{\{/);
    },
  );
});
