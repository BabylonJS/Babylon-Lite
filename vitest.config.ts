import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        setupFiles: ["./tests/lite/unit/setup-webgpu-globals.ts"],
        reporters: process.env.CI ? ["default", "junit"] : ["default"],
        outputFile: {
            junit: "test-results/unit-junit.xml",
        },
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["tests/lite/unit/**/*.test.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "build",
                    include: ["tests/lite/build/**/*.test.ts"],
                    testTimeout: 300_000,
                },
            },
            {
                extends: true,
                test: {
                    name: "gl-unit",
                    include: ["tests/gl/unit/**/*.test.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "gl-build",
                    include: ["tests/gl/build/**/*.test.ts"],
                    testTimeout: 300_000,
                },
            },
            {
                extends: true,
                test: {
                    name: "compat",
                    include: ["packages/babylon-lite-compat/tests/**/*.test.ts"],
                },
            },
            {
                // Opt-in Tier-2/3 tests that render through a REAL OfflineAudioContext
                // via the native dev dependency `node-web-audio-api`. Specs self-skip
                // when the binary is unavailable, so this project is safe everywhere.
                extends: true,
                test: {
                    name: "audio-offline",
                    include: ["tests/lite/audio/**/*.test.ts"],
                },
            },
        ],
    },
});
