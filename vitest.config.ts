import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["services/**/*.test.ts", "shared/**/*.test.ts", "scripts/**/*.test.ts"],
    // Encore's own runtime is not booted for unit tests; anything that needs
    // the database belongs in an integration test run through `encore test`.
    environment: "node",
  },
});
