import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { readFileSync, unlinkSync, writeFileSync } from "fs";
import dts from "vite-plugin-dts";
import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";

/**
 * Re-runs api-extractor on the already-rolled-up `dist/index.d.ts` to produce a
 * trimmed variant that drops the top-level imports kept alive only by
 * `@internal` members (works around api-extractor #4260). The trimmed file
 * replaces the original in-place. We also strip the leftover
 * `/* Excluded from this release type: X *\/` comments that vite-plugin-dts's
 * first pass leaves behind (we can't pass `omitTrimmingComments` to that first
 * pass — vite-plugin-dts locks `dtsRollup` config out of its `rollupConfig`).
 *
 * `ae-missing-release-tag` is silenced so untagged exports are kept; only
 * members explicitly tagged `/** @internal *\/` are dropped.
 */
function trimInternalDts(outDir: string): Plugin {
    return {
        name: "trim-internal-dts",
        // Must run AFTER vite-plugin-dts writes the rolled-up file.
        enforce: "post",
        async closeBundle() {
            const input = resolve(outDir, "index.d.ts");
            const trimmed = resolve(outDir, "index.public.d.ts");
            const config = ExtractorConfig.prepare({
                configObject: {
                    projectFolder: __dirname,
                    mainEntryPointFilePath: input,
                    compiler: {
                        overrideTsconfig: {
                            compilerOptions: {
                                target: "es2022",
                                module: "esnext",
                                moduleResolution: "bundler",
                                lib: ["es2022", "dom", "dom.iterable"],
                                types: ["@webgpu/types"],
                                strict: true,
                                declaration: true,
                                skipLibCheck: true,
                            },
                            include: [input],
                        },
                    },
                    apiReport: { enabled: false, reportFileName: "unused" },
                    docModel: { enabled: false },
                    tsdocMetadata: { enabled: false },
                    dtsRollup: {
                        enabled: true,
                        untrimmedFilePath: "",
                        publicTrimmedFilePath: trimmed,
                        omitTrimmingComments: true,
                    },
                    messages: {
                        compilerMessageReporting: {
                            default: { logLevel: ExtractorLogLevel.Warning },
                        },
                        extractorMessageReporting: {
                            default: { logLevel: ExtractorLogLevel.Warning },
                            "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
                            "ae-forgotten-export": { logLevel: ExtractorLogLevel.None },
                            "ae-unresolved-link": { logLevel: ExtractorLogLevel.None },
                            "ae-internal-missing-underscore": { logLevel: ExtractorLogLevel.Error },
                        },
                        tsdocMessageReporting: {
                            default: { logLevel: ExtractorLogLevel.None },
                        },
                    },
                },
                configObjectFullPath: undefined,
                packageJsonFullPath: resolve(__dirname, "package.json"),
            });
            const result = Extractor.invoke(config, { localBuild: true, showVerboseMessages: false });
            if (!result.succeeded) {
                throw new Error(`api-extractor failed: ${result.errorCount} errors, ${result.warningCount} warnings`);
            }
            // Strip leftover "/* Excluded from this release type: X */" stubs.
            const cleaned = readFileSync(trimmed, "utf8").replace(/^\s*\/\* Excluded from this release type:[^*]*\*\/\s*\n/gm, "");
            writeFileSync(input, cleaned);
            unlinkSync(trimmed);
        },
    };
}

/** Emit a publish-ready package.json into the build output directory. */
function emitPackageJson(outDir: string): Plugin {
    return {
        name: "emit-package-json",
        writeBundle() {
            const pkg = {
                name: "@babylonjs/lite",
                version: "0.1.0",
                type: "module",
                main: "./index.js",
                module: "./index.js",
                types: "./index.d.ts",
                exports: {
                    ".": {
                        import: "./index.js",
                        types: "./index.d.ts",
                    },
                },
                sideEffects: false,
                dependencies: {
                    draco3d: "^1.5.7",
                    "manifold-3d": "3.4.0",
                    "@recast-navigation/core": "0.43.0",
                    "@recast-navigation/generators": "0.43.0",
                    "@recast-navigation/wasm": "0.43.0",
                },
            };
            writeFileSync(resolve(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
        },
    };
}

export default defineConfig(({ mode }) => {
    const outDir = mode === "prod" ? "dist/prod" : "dist";
    const isWatch = process.argv.includes("--watch");
    return {
        build: {
            lib: {
                entry: resolve(__dirname, "src/index.ts"),
                formats: ["es"],
                fileName: "index",
            },
            outDir,
            rollupOptions: {
                external: [/^@recast-navigation\//],
            },
            sourcemap: true,
            minify: mode === "prod" ? "esbuild" : false,
        },
        plugins: [
            dts({
                rollupTypes: !isWatch,
                tsconfigPath: resolve(__dirname, "tsconfig.json"),
                outDir,
            }),
            ...(isWatch ? [] : [trimInternalDts(outDir)]),
            emitPackageJson(outDir),
        ],
    };
});
