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
                    name: "compat",
                    include: ["packages/babylon-lite-compat/tests/**/*.test.ts"],
                },
            },
        ],
    },
});
