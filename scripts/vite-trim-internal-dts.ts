import { resolve } from "path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";
import type { Plugin } from "vite";

/** Options for {@link trimInternalDts}. */
export interface TrimInternalDtsOptions {
    /** Build output directory the rolled-up declaration files live in. */
    outDir: string;
    /**
     * Package root folder — pass the calling config's `__dirname`. Used as
     * api-extractor's `projectFolder` and to locate the package's `package.json`.
     */
    projectFolder: string;
    /**
     * Entry declaration files to trim, each a path relative to `outDir`
     * (e.g. `"./index.d.ts"`). Defaults to `["./index.d.ts"]`; multi-entry
     * packages pass every rolled-up entry.
     */
    entries?: readonly string[];
    /**
     * How to treat `@internal` members that lack an underscore prefix.
     * `"error"` (the default) fails the build — it pairs with the repo's
     * `underscore-requires-internal` ESLint rule. `"off"` permits `@internal`
     * on members that cannot be underscore-prefixed (e.g. constructors).
     */
    internalMissingUnderscore?: "error" | "off";
    /**
     * Silence api-extractor's `ae-wrong-input-file-type`, raised when it follows
     * an imported type into a peer dependency that publishes its `types` from
     * `.ts` source rather than `.d.ts`.
     */
    silenceWrongInputFileType?: boolean;
    /**
     * Optional post-trim transform applied to each declaration file's text after
     * the leftover "Excluded from this release type" comment stubs are stripped
     * (e.g. to rewrite a workspace import specifier to its published name).
     */
    transform?: (content: string) => string;
}

/**
 * A Vite plugin that re-runs api-extractor on each already-rolled-up declaration
 * file (produced by `vite-plugin-dts` with `rollupTypes`) to produce a trimmed
 * variant that drops the top-level imports kept alive only by `@internal` members
 * (works around api-extractor #4260) and removes the leftover
 * `/* Excluded from this release type: X *\/` comment stubs the rollup pass leaves
 * behind. The trimmed file replaces the original in-place.
 *
 * Shared by every package that publishes trimmed, single-file `.d.ts` rollups so
 * the api-extractor wiring lives in exactly one place.
 *
 * `ae-missing-release-tag` is silenced so untagged exports are kept; only members
 * explicitly tagged `@internal` are dropped.
 */
export function trimInternalDts(options: TrimInternalDtsOptions): Plugin {
    const { outDir, projectFolder, entries = ["./index.d.ts"], internalMissingUnderscore = "error", silenceWrongInputFileType = false, transform } = options;

    return {
        name: "trim-internal-dts",
        // Must run AFTER vite-plugin-dts writes the rolled-up files.
        enforce: "post",
        async closeBundle() {
            for (const rel of entries) {
                const input = resolve(outDir, rel.replace(/^\.\//, ""));
                if (!existsSync(input)) {
                    continue;
                }
                const trimmed = input.replace(/\.d\.ts$/, ".public.d.ts");
                const config = ExtractorConfig.prepare({
                    configObject: {
                        projectFolder,
                        mainEntryPointFilePath: input,
                        compiler: {
                            overrideTsconfig: {
                                compilerOptions: {
                                    target: "es2022",
                                    module: "esnext",
                                    moduleResolution: "bundler",
                                    lib: ["es2022", "dom", "dom.iterable"],
                                    types: ["@webgpu/types", "webxr"],
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
                                "ae-internal-missing-underscore": {
                                    logLevel: internalMissingUnderscore === "off" ? ExtractorLogLevel.None : ExtractorLogLevel.Error,
                                },
                                ...(silenceWrongInputFileType ? { "ae-wrong-input-file-type": { logLevel: ExtractorLogLevel.None } } : {}),
                            },
                            tsdocMessageReporting: {
                                default: { logLevel: ExtractorLogLevel.None },
                            },
                        },
                    },
                    configObjectFullPath: undefined,
                    packageJsonFullPath: resolve(projectFolder, "package.json"),
                });
                const result = Extractor.invoke(config, { localBuild: true, showVerboseMessages: false });
                if (!result.succeeded) {
                    throw new Error(`api-extractor failed for ${rel}: ${result.errorCount} errors, ${result.warningCount} warnings`);
                }
                // Strip leftover "/* Excluded from this release type: X */" stubs, then
                // apply the package-specific transform (if any).
                let cleaned = readFileSync(trimmed, "utf8").replace(/^\s*\/\* Excluded from this release type:[^*]*\*\/\s*\n/gm, "");
                if (transform) {
                    cleaned = transform(cleaned);
                }
                writeFileSync(input, cleaned);
                unlinkSync(trimmed);
            }
        },
    };
}
