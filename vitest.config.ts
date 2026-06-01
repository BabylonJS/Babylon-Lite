import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        reporters: process.env.CI ? ["default", "junit"] : ["default"],
        outputFile: {
            junit: "test-results/unit-junit.xml",
        },
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["tests/unit/**/*.test.ts"],
                },
            },
            {
                extends: true,
                test: {
                    name: "build",
                    include: ["tests/build/**/*.test.ts"],
                    testTimeout: 300_000,
                },
            },
        ],
    },
});
