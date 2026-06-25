import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import dts from "vite-plugin-dts";
import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";

/**
 * Re-runs api-extractor on each already-rolled-up entry `.d.ts` to drop every
 * member tagged `@internal` (and the top-level imports kept alive only by
 * them), mirroring `packages/babylon-lite/vite.config.ts`. Unlike the Lite
 * package, lite-gl ships multiple public entries (`index` + `html-texture` +
 * `sprites` + `render-target`), so each rolled d.ts is trimmed in turn. Uses
 * `types: []` — this is a WebGL2 package and must not pull in `@webgpu/types`.
 */
function trimInternalDts(outDir: string, entries: string[]): Plugin {
    return {
        name: "trim-internal-dts",
        // Must run AFTER vite-plugin-dts writes the rolled-up files.
        enforce: "post",
        closeBundle() {
            for (const entry of entries) {
                const input = resolve(outDir, `${entry}.d.ts`);
                const trimmed = resolve(outDir, `${entry}.public.d.ts`);
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
                                    types: [],
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
                    throw new Error(`api-extractor failed for ${entry}: ${result.errorCount} errors, ${result.warningCount} warnings`);
                }
                // Strip leftover "/* Excluded from this release type: X */" stubs.
                const cleaned = readFileSync(trimmed, "utf8").replace(/^\s*\/\* Excluded from this release type:[^*]*\*\/\s*\n/gm, "");
                writeFileSync(input, cleaned);
                unlinkSync(trimmed);
            }
        },
    };
}

/** Emit a publish-ready package.json into the build output directory. */
function emitPackageJson(outDir: string): Plugin {
    return {
        name: "emit-package-json",
        writeBundle() {
            const pkg = {
                name: "@babylonjs/lite-gl",
                version: "0.1.0",
                description: "Function-based, tree-shakeable WebGL2 micro-engine for fullscreen effects, sprites and dynamic textures — the WebGL counterpart of @babylonjs/lite.",
                keywords: ["babylon", "babylonjs", "webgl", "webgl2", "effect", "shader", "sprite", "lite", "rendering"],
                license: "Apache-2.0",
                repository: {
                    type: "git",
                    url: "https://github.com/BabylonJS/Babylon-Lite.git",
                    directory: "packages/babylon-lite-gl",
                },
                homepage: "https://github.com/BabylonJS/Babylon-Lite/tree/main/packages/babylon-lite-gl",
                type: "module",
                main: "./index.js",
                module: "./index.js",
                types: "./index.d.ts",
                sideEffects: false,
                exports: {
                    ".": {
                        import: "./index.js",
                        types: "./index.d.ts",
                    },
                    "./html-texture": {
                        import: "./html-texture.js",
                        types: "./html-texture.d.ts",
                    },
                    "./sprites": {
                        import: "./sprites.js",
                        types: "./sprites.d.ts",
                    },
                    "./render-target": {
                        import: "./render-target.js",
                        types: "./render-target.d.ts",
                    },
                    "./mesh": {
                        import: "./mesh.js",
                        types: "./mesh.d.ts",
                    },
                    "./depth-stencil": {
                        import: "./depth-stencil.js",
                        types: "./depth-stencil.d.ts",
                    },
                    "./scissor": {
                        import: "./scissor.js",
                        types: "./scissor.d.ts",
                    },
                    "./dynamic-texture": {
                        import: "./dynamic-texture.js",
                        types: "./dynamic-texture.d.ts",
                    },
                },
            };
            writeFileSync(resolve(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
            // Ship the README on the published package (publish runs from outDir).
            const readme = resolve(__dirname, "README.md");
            if (existsSync(readme)) {
                copyFileSync(readme, resolve(outDir, "README.md"));
            }
        },
    };
}

export default defineConfig(({ mode }) => {
    const outDir = mode === "prod" ? "dist/prod" : "dist";
    const isWatch = process.argv.includes("--watch");
    return {
        build: {
            lib: {
                entry: {
                    index: resolve(__dirname, "src/index.ts"),
                    "html-texture": resolve(__dirname, "src/html-texture.ts"),
                    sprites: resolve(__dirname, "src/sprites.ts"),
                    "render-target": resolve(__dirname, "src/render-target.ts"),
                    mesh: resolve(__dirname, "src/mesh.ts"),
                    "depth-stencil": resolve(__dirname, "src/depth-stencil.ts"),
                    scissor: resolve(__dirname, "src/scissor.ts"),
                    "dynamic-texture": resolve(__dirname, "src/dynamic-texture.ts"),
                },
                formats: ["es"],
            },
            outDir,
            rollupOptions: {
                external: [],
                output: {
                    preserveModules: false,
                    entryFileNames: "[name].js",
                },
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
            ...(isWatch ? [] : [trimInternalDts(outDir, ["index", "html-texture", "sprites", "render-target", "mesh", "depth-stencil", "scissor", "dynamic-texture"])]),
            emitPackageJson(outDir),
        ],
    };
});
