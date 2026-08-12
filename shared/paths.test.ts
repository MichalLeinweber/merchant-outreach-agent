import { existsSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultFixtureDir } from "../services/agents/llm.js";
import { findAppRoot, fromAppRoot } from "./paths.js";

describe("findAppRoot", () => {
  it("finds the directory holding encore.app", () => {
    expect(existsSync(path.join(findAppRoot(), "encore.app"))).toBe(true);
  });

  it("finds the same root from a nested directory", () => {
    expect(findAppRoot(fromAppRoot("services", "agents", "prompts"))).toBe(findAppRoot());
  });

  it("falls back to where it started when there is no app root above", () => {
    const root = path.parse(process.cwd()).root;
    expect(findAppRoot(root)).toBe(root);
  });
});

describe("paths that must resolve for the app to run", () => {
  // These are the paths that would break only once the application is bundled
  // — unit tests run unbundled, so nothing else here would notice.
  it.each(["triage.md", "draft.md"])("prompt file %s is where the loader looks", (file) => {
    expect(existsSync(fromAppRoot("services", "agents", "prompts", file))).toBe(true);
  });

  it("the fixture directory is inside the app root", () => {
    expect(defaultFixtureDir()).toBe(fromAppRoot("fixtures", "llm"));
    expect(existsSync(defaultFixtureDir())).toBe(true);
  });
});
