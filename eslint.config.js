// Flat ESLint config (ESLint 9). Kept deliberately small: type-aware linting
// would slow CI down for little benefit at this stage of the project.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated, vendored and non-TypeScript directories.
    ignores: [
      "node_modules/**",
      "dist/**",
      // Encore's generated client and its local build output.
      "encore.gen/**",
      ".encore/**",
      "evals/**",
      "dashboard/**",
      "fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused function arguments are fine when they document a signature,
      // as long as they are prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Encore endpoints legitimately return `Promise<void>`.
      "@typescript-eslint/no-empty-function": "off",
    },
  },
);
