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
        ],
    },
});
