import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Same convention as the backend config: an underscore prefix marks an
      // argument that documents a signature but is deliberately unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Restating the defaults of eslint-config-next, which are dropped as soon as
  // this file declares any ignores of its own.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
