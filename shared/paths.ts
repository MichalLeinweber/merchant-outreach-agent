/**
 * Locating files that ship alongside the code.
 *
 * Not `import.meta.url`. Encore bundles the whole application into a single
 * file at `.encore/build/combined/combined/main.mjs`, and esbuild rewrites
 * `import.meta.url` to point at that bundle. A path derived from it resolves
 * next to the bundle rather than next to the source, so prompts and fixtures
 * are not found — at runtime only. Unit tests run unbundled and would never
 * catch it.
 *
 * The app root is instead found by walking up for `encore.app`, which is the
 * definition of an Encore application root. That works bundled, unbundled,
 * under vitest, and inside the container image, whose working directory is
 * the app root.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

const ROOT_MARKER = "encore.app";

/**
 * Nearest ancestor of `startDir` containing `encore.app`.
 *
 * Falls back to `startDir` when there is none. That case is not silently
 * papered over: whatever tries to read a file underneath it fails with an
 * error naming the full path it looked at.
 */
export function findAppRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);

  for (;;) {
    if (existsSync(path.join(dir, ROOT_MARKER))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

/** Resolve a repository-relative path against the app root. */
export function fromAppRoot(...segments: string[]): string {
  return path.join(findAppRoot(), ...segments);
}
