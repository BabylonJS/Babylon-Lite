import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "../tests/lite/parity-shado",
    timeout: 120_000,
    workers: 1,
    retries: 0,
    outputDir: "../test-results/shado-parity-artifacts",
    reporter: [["list"]],
});
