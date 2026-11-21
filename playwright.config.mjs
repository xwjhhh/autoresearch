import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.{mjs,ts}",
  outputDir: process.env.AUTORESEARCH_E2E_OUTPUT || "test-results",
  reporter: "list",
  workers: 1,
  timeout: 45_000,
});
