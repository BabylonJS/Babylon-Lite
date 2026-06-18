import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
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

/**
 * Emit a publish-ready package.json into the build output directory and copy
 * the README and LICENSE alongside it so the published package is complete.
 */
function emitPackageJson(outDir: string): Plugin {
    return {
        name: "emit-package-json",
        writeBundle() {
            const pkg = {
                name: "@babylonjs/lite",
                version: "0.1.0",
                description: "A lightweight, tree-shakable, WebGPU-first rendering library derived from Babylon.js.",
                license: "Apache-2.0",
                homepage: "https://doc.babylonjs.com/lite/",
                repository: {
                    type: "git",
                    url: "https://github.com/BabylonJS/Babylon-Lite.git",
                },
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
            };
            writeFileSync(resolve(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
            copyFileSync(resolve(__dirname, "README.md"), resolve(outDir, "README.md"));
            copyFileSync(resolve(__dirname, "../../LICENSE"), resolve(outDir, "LICENSE"));
        },
    };
}

/**
 * Third-party packages whose code is bundled into the published output (as
 * opposed to dev-only tooling, which never ships). Each runtime dependency's
 * license text must be propagated per its MIT/Apache-2.0 attribution terms.
 * Keep this list in sync with the `dependencies` field of package.json.
 */
const BUNDLED_DEPENDENCIES = ["manifold-3d", "@recast-navigation/core", "@recast-navigation/generators", "@recast-navigation/wasm", "text-shaper"];

/**
 * Resolve a bundled dependency's installed directory. These are declared
 * runtime `dependencies`, so the package manager installs them under this
 * package's `node_modules`. We read from there directly rather than resolving
 * the dependency specifier, because several of them restrict access via their
 * `exports` map (resolving the bare entry or `package.json` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED).
 */
function resolveDependencyDir(dep: string): string {
    const dir = resolve(__dirname, "node_modules", dep);
    const pkgJson = resolve(dir, "package.json");
    if (!existsSync(pkgJson)) {
        throw new Error(`Could not locate installed package directory for bundled dependency "${dep}" at ${dir}`);
    }
    return dir;
}

/**
 * Generate THIRD_PARTY_NOTICES.txt by aggregating the license text of every
 * bundled runtime dependency. Generated at build time so the notices stay in
 * sync with the actual dependency versions on each release. Fails the build if
 * a license file cannot be located, so attribution is never silently dropped.
 */
function emitThirdPartyNotices(outDir: string): Plugin {
    return {
        name: "emit-third-party-notices",
        writeBundle() {
            const sections: string[] = [
                "@babylonjs/lite bundles the following third-party open source software.",
                "Their license texts are reproduced below as required by their terms.",
            ];
            for (const dep of BUNDLED_DEPENDENCIES) {
                const pkgDir = resolveDependencyDir(dep);
                const { version } = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as { version: string };
                const licenseFile = readdirSync(pkgDir).find((f) => /^(license|licence|copying)/i.test(f));
                if (!licenseFile) {
                    throw new Error(`No license file found for bundled dependency "${dep}" in ${pkgDir}`);
                }
                const licenseText = readFileSync(resolve(pkgDir, licenseFile), "utf8").trimEnd();
                const divider = "=".repeat(78);
                sections.push(`${divider}\n${dep} ${version}\n${divider}\n\n${licenseText}`);
            }
            writeFileSync(resolve(outDir, "THIRD_PARTY_NOTICES.txt"), sections.join("\n\n") + "\n");
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
            emitThirdPartyNotices(outDir),
        ],
    };
});
