/**
 * Let Node run the TypeScript sources directly.
 *
 * Node 22.18+ strips type annotations from a `.ts` file it is asked to run,
 * which is why `node scripts/generate-merchants.ts` works in this repository.
 * What it does not do is rewrite a specifier: the services import each other
 * as `"./runner.js"` — the path the file will have once TypeScript emits it —
 * and no such file exists on disk, so the import fails with
 * ERR_MODULE_NOT_FOUND. Bundlers and vitest paper over that; plain Node does
 * not.
 *
 * This is the whole gap, and it is closed by one resolve hook: when a `.js`
 * specifier does not resolve, try the same path with `.ts`. Nothing else is
 * changed — the modules that do resolve are left entirely alone.
 *
 * Registered with `node --import ./evals/harness/ts-resolve.mjs <file>.ts`.
 * `module.registerHooks` is synchronous and in-thread, so it adds no worker
 * and no measurable start-up cost.
 *
 * The alternative was a bundler or `tsx` as a dependency. This is smaller,
 * has no supply chain, and states its one assumption out loud.
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      if (
        error?.code === "ERR_MODULE_NOT_FOUND" &&
        isRelative &&
        specifier.endsWith(".js")
      ) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
