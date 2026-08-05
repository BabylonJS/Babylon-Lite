// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintPluginPrettier from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier";
import tsdoc from "eslint-plugin-tsdoc";
import babylonLiteRules from "./eslint-rules/underscore-requires-internal.mjs";

export default tseslint.config(
    // ===========================================
    // Global ignores
    // ===========================================
    {
        ignores: [
            "dist/**",
            "**/dist/**",
            "packages/babylon-lite/build/**",
            "pages-dist/**",
            "node_modules/**",
            "**/node_modules/**",
            "reference/lite/**",
            "test-results/**",
            "scripts/**",
            "playground/scripts/**",
            "**/public/**",
            "**/*.md",
            "**/*.html",
            "**/*.css",
            "**/*.wgsl",
            "*.config.ts",
            "*.config.mjs",
        ],
    },

    // ===========================================
    // Base recommended configurations
    // ===========================================
    js.configs.recommended,
    eslintConfigPrettier,

    // ===========================================
    // Global language options + Prettier
    // ===========================================
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parser: tseslint.parser,
            parserOptions: {
                sourceType: "module",
                ecmaVersion: 2022,
            },
        },
        plugins: {
            prettier: eslintPluginPrettier,
        },
        rules: {
            "prettier/prettier": "error",
            "arrow-body-style": "off",
            "prefer-arrow-callback": "off",
        },
    },

    // ===========================================
    // TypeScript source files (type-checked)
    // ===========================================
    {
        files: ["packages/**/src/**/*.ts"],
        extends: [...tseslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
            },
        },
        plugins: {
            tsdoc,
            "babylon-lite": babylonLiteRules,
        },
        rules: {
            // TSDoc syntax correctness — any TSDoc comment that IS written must be valid.
            "tsdoc/syntax": "error",

            // Underscore-prefixed members must have @internal (paired with api-extractor's
            // `ae-internal-missing-underscore` check) — see GUIDANCE.md §4b′.
            "babylon-lite/underscore-requires-internal": "error",

            // Console
            "no-console": ["error", { allow: ["warn", "error", "time", "timeEnd", "trace"] }],

            // General
            "no-unused-vars": "off",
            "no-useless-assignment": "off",
            "no-empty": ["error", { allowEmptyCatch: true }],
            curly: "error",
            "no-throw-literal": "error",

            // Disabled type-checked rules (too noisy for this codebase)
            "prefer-rest-params": "off",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unsafe-enum-comparison": "off",
            "@typescript-eslint/no-unsafe-function-type": "off",
            "@typescript-eslint/unbound-method": "off",
            "@typescript-eslint/no-base-to-string": "off",
            "@typescript-eslint/restrict-plus-operands": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/no-unused-expressions": "off",
            "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-unsafe-declaration-merging": "off",
            "@typescript-eslint/no-unnecessary-type-constraint": "off",
            "@typescript-eslint/no-redundant-type-constituents": "off",
            "@typescript-eslint/no-namespace": "off",
            "@typescript-eslint/no-array-delete": "off",
            "@typescript-eslint/no-implied-eval": "off",
            "@typescript-eslint/no-duplicate-enum-values": "off",
            "@typescript-eslint/only-throw-error": "off",
            "@typescript-eslint/no-for-in-array": "off",
            "@typescript-eslint/no-deprecated": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "off",

            // Async/Promise rules (important for WebGPU correctness)
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/no-misused-promises": [
                "error",
                {
                    checksConditionals: false,
                    checksVoidReturn: {
                        arguments: false,
                        attributes: false,
                    },
                },
            ],
            "@typescript-eslint/await-thenable": "error",
            "@typescript-eslint/prefer-promise-reject-errors": "error",

            // TypeScript rules
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
            "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false, fixStyle: "separate-type-imports" }],
        },
    },

    // ===========================================
    // Playground app (type-checked, general rules)
    // ===========================================
    {
        files: ["playground/src/**/*.ts"],
        extends: [...tseslint.configs.recommended],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            "no-console": ["error", { allow: ["warn", "error", "time", "timeEnd", "trace"] }],
            curly: "error",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-floating-promises": "error",
            "@typescript-eslint/await-thenable": "error",
            "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false, fixStyle: "separate-type-imports" }],
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
        },
    },

    // ===========================================
    // Test files (lighter rules)
    // ===========================================
    {
        files: ["tests/lite/**/*.ts", "tests/gl/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        extends: [...tseslint.configs.recommended],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
            },
        },
        rules: {
            "no-console": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
        },
    }
);
