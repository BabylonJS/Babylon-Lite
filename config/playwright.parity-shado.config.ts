import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "../tests/lite/parity-shado",
    // The slowest canonical scene wait is 180s; leave room for module loading,
    // readiness polling, settling, readback, encoding, and assertion work.
    timeout: 240_000,
    workers: 1,
    retries: 0,
    outputDir: "../test-results/shado-parity-artifacts",
    reporter: [["list"]],
});
