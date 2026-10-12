import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "../tests/lite/parity-shado",
    timeout: 120_000,
    fullyParallel: true,
    workers: process.env.CI ? 2 : 1,
    retries: 0,
    outputDir: "../test-results/shado-parity-artifacts",
    reporter: [["list"], ["junit", { outputFile: "../test-results/shado-parity-junit.xml" }], ["html", { outputFolder: "../test-results/shado-parity-report", open: "never" }]],
});
