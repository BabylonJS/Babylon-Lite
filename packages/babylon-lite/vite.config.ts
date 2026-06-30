import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import { basename, resolve } from "path";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import dts from "vite-plugin-dts";
import remapping from "@ampproject/remapping";
import { trimInternalDts } from "../../scripts/vite-trim-internal-dts";
import { wgslMinifyPlugin } from "../../scripts/wgsl-minify-plugin";
import { stripManifoldNodeRequire } from "../../scripts/strip-manifold-node-require";

/**
 * api-extractor's trim pass works around #4260 by dropping top-level imports kept
 * alive only by `@internal` members. We tag the failure mode `ae-internal-missing-underscore`
 * as an error so the trim stays paired with the `underscore-requires-internal` ESLint rule.
 * See {@link trimInternalDts} for the shared implementation.
 */

/**
 * The published package is built into `build/` (the npm tarball root) and ships TWO
 * JavaScript trees plus shared metadata:
 *
 *   build/
 *     package.json              exports "." -> ./lib/index.js  (what bundlers resolve)
 *     index.d.ts                shared rolled-up types for both trees
 *     README.md, LICENSE, THIRD_PARTY_NOTICES.txt
 *     lib/                      module-granular ES output for BUNDLER consumers
 *       index.js, <mirrors src/ tree>.js, _chunks/vendor/*.js
 *     dist/                     prebundled, minified ES output for BROWSER / CDN use
 *       index.js
 *
 * `lib/` (mode "lib") emits one file per source module — one Rollup entry per
 * `src/**\/*.ts` — so a downstream bundler tree-shakes at full module granularity
 * exactly as if it consumed the TypeScript source. Third-party runtimes are folded
 * into named vendor chunks so they stay isolatable.
 *
 * `dist/` (mode "dist") is a single-entry, prebundled, minified build a browser can
 * load directly from a CDN like jsDelivr. `inlineDynamicImports` folds every dynamic
 * import edge into `dist/index.js`, yielding one browser-ready file.
 */

/**
 * Resolve the version this build should report. The release pipeline resolves the
 * next published version *before* `pnpm build` and exposes it as `PACKAGE_VERSION`
 * (see scripts/prepare-npm-release.ts), so both the runtime `VERSION` constant
 * (baked in via the `define` below) and the emitted `package.json` report the
 * version the package actually ships as. Outside the release pipeline (local
 * builds) it falls back to this package's source `version`.
 */
function resolveReleaseVersion(): string {
    const fromEnv = process.env.PACKAGE_VERSION?.trim();
    if (fromEnv) {
        return fromEnv;
    }
    const { version } = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version?: string };
    return version ?? "0.1.0";
}

/**
 * Release provenance recorded into the published `package.json` so the publish
 * script can dedupe re-runs of the same Azure build (see `getPublishedBuildId`
 * in scripts/prepare-npm-release.ts). Populated only inside the pipeline, where
 * `BUILD_BUILDID` / `BUILD_SOURCEVERSION` are set.
 */
function resolveReleaseProvenance(): { azureBuildId?: string; sourceVersion?: string } | undefined {
    const azureBuildId = process.env.BUILD_BUILDID;
    const sourceVersion = process.env.BUILD_SOURCEVERSION;
    if (!azureBuildId && !sourceVersion) {
        return undefined;
    }
    return {
        ...(azureBuildId ? { azureBuildId } : {}),
        ...(sourceVersion ? { sourceVersion } : {}),
    };
}
const PACKAGE_ROOT = resolve(__dirname, "build");
/**
 * Output directories as Vite `build.outDir` strings, relative to the package root
 * (Vite's project root for this build). vite-plugin-dts mishandles an absolute or
 * slash-nested entry name, so the dist pass emits into `build/dist` with natural
 * file names and the rolled-up `index.d.ts` is relocated to the build root afterwards.
 */
const DIST_OUT_DIR = "build/dist";
const LIB_OUT_DIR = "build/lib";

/**
 * Emit a publish-ready package.json into the build root and copy the README and
 * LICENSE alongside it so the published package is complete. `exports`/`main`/
 * `module` point at `lib/` because that is the module-granular tree bundlers should
 * resolve; `jsdelivr`/`unpkg` point at the prebundled `dist/` tree — a TRUE
 * single-file `dist/index.js` containing all of Lite (including vendor runtimes) — so
 * a bare CDN URL
 * (`https://cdn.jsdelivr.net/npm/@babylonjs/lite`) serves a browser-ready build.
 */
function emitPackageJson(): Plugin {
    return {
        name: "emit-package-json",
        writeBundle() {
            const provenance = resolveReleaseProvenance();
            const pkg = {
                name: "@babylonjs/lite",
                version: resolveReleaseVersion(),
                description: "A lightweight, tree-shakable, WebGPU-first rendering library derived from Babylon.js.",
                license: "Apache-2.0",
                homepage: "https://doc.babylonjs.com/lite/",
                repository: {
                    type: "git",
                    url: "https://github.com/BabylonJS/Babylon-Lite.git",
                },
                type: "module",
                main: "./lib/index.js",
                module: "./lib/index.js",
                types: "./index.d.ts",
                exports: {
                    ".": {
                        types: "./index.d.ts",
                        import: "./lib/index.js",
                    },
                },
                jsdelivr: "./dist/index.js",
                unpkg: "./dist/index.js",
                sideEffects: false,
                ...(provenance ? { babylonLiteRelease: provenance } : {}),
            };
            writeFileSync(resolve(PACKAGE_ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
            copyFileSync(resolve(__dirname, "README.md"), resolve(PACKAGE_ROOT, "README.md"));
            copyFileSync(resolve(__dirname, "../../LICENSE"), resolve(PACKAGE_ROOT, "LICENSE"));
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
function emitThirdPartyNotices(): Plugin {
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
            writeFileSync(resolve(PACKAGE_ROOT, "THIRD_PARTY_NOTICES.txt"), sections.join("\n\n") + "\n");
        },
    };
}

const SRC_DIR = resolve(__dirname, "src");

/**
 * Fully minify each emitted chunk of the BROWSER build, including whitespace, while
 * preserving working sourcemaps back to TypeScript source.
 *
 * Vite intentionally forces `minifyWhitespace: false` for ES *library* builds
 * (`build.lib` + `formats: ["es"]`) even when `build.minify` is `"esbuild"`, so its
 * ESM lib output stays readable — the right default for the `lib/` tree, but the
 * `dist/` browser/CDN bundle should be as small as possible. Vite's built-in minify
 * is therefore disabled for the browser pass (`build.minify: false`) and ALL
 * minification is done here via `transformWithEsbuild` (esbuild directly, without the
 * lib-mode whitespace carve-out).
 *
 * Runs in `generateBundle` (enforce "post"), NOT `renderChunk`: in a hashed ES lib
 * build Rollup discards `renderChunk` return values (it re-renders chunks afterwards
 * to substitute final hashed import paths). Mutating each chunk's `code`/`map` in
 * `generateBundle` is the final word. Because esbuild's minify map only maps the
 * minified output back to the pre-min chunk, it is composed with the chunk's own
 * `chunk → source` map via `@ampproject/remapping` to yield a correct
 * `minified → TypeScript source` map. Requires `build.sourcemap: true`.
 */
function minifyBrowserChunks(): Plugin {
    return {
        name: "minify-browser-chunks",
        enforce: "post",
        async generateBundle(_options, bundle) {
            for (const file of Object.values(bundle)) {
                if (file.type !== "chunk") {
                    continue;
                }
                const chunkMap = file.map;
                const result = await transformWithEsbuild(file.code, file.fileName, {
                    minify: true,
                    legalComments: "none",
                    sourcemap: true,
                });
                // esbuild emits the map separately; strip any sourceMappingURL it leaves
                // inline so we control the comment (re-added below when a map exists).
                let code = result.code.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "");

                const mapName = `${file.fileName}.map`;
                const mapAsset = bundle[mapName];
                if (chunkMap && result.map && mapAsset && mapAsset.type === "asset") {
                    // esbuild's minify map has exactly one source: the pre-min chunk.
                    // Compose it with the chunk's own `chunk → source` map so the final
                    // map points to TS source. The loader returns chunkMap for that one
                    // source (the first call) and null for the leaf TS sources inside
                    // chunkMap, otherwise remapping would recurse infinitely.
                    let isChunkSource = true;
                    const composed = remapping(result.map as unknown as Parameters<typeof remapping>[0], () => {
                        if (isChunkSource) {
                            isChunkSource = false;
                            return chunkMap as unknown as ReturnType<Parameters<typeof remapping>[1]>;
                        }
                        return null;
                    });
                    // The `.map` is emitted as its own bundle asset, so overwrite that
                    // asset's contents (mutating `chunk.map` alone is ignored at write).
                    mapAsset.source = JSON.stringify(composed);
                    file.map = composed as unknown as typeof file.map;
                    code += `\n//# sourceMappingURL=${basename(mapName)}\n`;
                }
                file.code = code;
            }
        },
    };
}

/**
 * Minify inlined Web Worker bundles (`?worker&inline`) in BOTH the lib and dist
 * builds. A `?worker&inline` import is compiled to a self-contained JS string embedded
 * as a Blob/base64 in the importing module. That string is OPAQUE to a downstream
 * bundler — like a `?raw` WGSL string, a consumer's minifier cannot shrink code that
 * lives inside a string literal. So the worker must be minified here, at package build
 * time, regardless of the (intentionally unminified) `lib` output: otherwise every
 * consumer ships the full-fat worker source. esbuild minify (incl. whitespace) is run
 * in the worker sub-build's `renderChunk` — the worker is a normal Rollup bundle (not
 * lib mode), so its `renderChunk` return value is honoured.
 */
function minifyInlinedWorker(): Plugin {
    return {
        name: "minify-inlined-worker",
        enforce: "post",
        async renderChunk(code, chunk) {
            const result = await transformWithEsbuild(code, chunk.fileName, {
                minify: true,
                // Bundle as an IIFE so the worker's (otherwise top-level) ES-module
                // bindings become function-scoped and esbuild's identifier minifier can
                // rename them. With the default `format: "es"`, top-level names are treated
                // as potential exports and left unmangled, bloating the inlined blob — the
                // scene/demo harness builds the same worker as an IIFE, so this keeps the
                // package's inlined worker byte-aligned with a from-source build.
                format: "iife",
                legalComments: "none",
                sourcemap: false,
            });
            return { code: result.code, map: null };
        },
    };
}

/**
 * Strip the dead `//# sourceMappingURL=…` comment that Vite's worker-inline step bakes
 * into the embedded worker Blob string. Because the package build runs with
 * `build.sourcemap: true`, Vite appends the worker's sourcemap reference to the inlined
 * worker source before embedding it as a string literal (escaped `\n//# …\n`). A blob
 * URL can't resolve that sibling `.map`, so the comment is pure dead weight — and the
 * from-source harness build (`sourcemap: "hidden"`) emits none, so stripping it keeps
 * the inlined worker byte-aligned with a from-source build. Runs on the MAIN build,
 * where the blob string lives; `enforce: "post"` so it sees final chunk code (and, for
 * dist, runs after esbuild minification which leaves string contents untouched). Vite
 * may also emit an orphan worker `*.js.map` asset for the inlined worker even though
 * no sibling worker `*.js` file is written; prune those orphan maps so dist contains
 * only maps that correspond to emitted JS files.
 */
function stripInlinedWorkerSourcemap(): Plugin {
    return {
        name: "strip-inlined-worker-sourcemap",
        enforce: "post",
        generateBundle(_options, bundle) {
            for (const file of Object.values(bundle)) {
                if (file.type === "chunk" && file.code.includes("//# sourceMappingURL=")) {
                    // Match the escaped form inside the Blob string literal only (the
                    // chunk's own trailing real-newline sourcemap comment is left intact).
                    file.code = file.code.replace(/\\n\/\/# sourceMappingURL=[^\\"']*\.js\.map\\n/g, "");
                }
            }

            for (const fileName of Object.keys(bundle)) {
                if (!fileName.endsWith(".js.map")) {
                    continue;
                }
                const jsFileName = fileName.slice(0, -4);
                if (!Object.prototype.hasOwnProperty.call(bundle, jsFileName)) {
                    delete bundle[fileName];
                }
            }
        },
    };
}

/**
 * Relocate the rolled-up `build/dist/index.d.ts` (produced + trimmed during the
 * browser pass) up to the build root, so the shared `index.d.ts` sits beside
 * `package.json` and serves both the `lib/` and `dist/` trees. Runs after
 * {@link trimInternalDts}'s `closeBundle`.
 */
function relocateDts(): Plugin {
    return {
        name: "relocate-dts",
        enforce: "post",
        closeBundle() {
            const from = resolve(__dirname, DIST_OUT_DIR, "index.d.ts");
            if (existsSync(from)) {
                renameSync(from, resolve(PACKAGE_ROOT, "index.d.ts"));
            }
        },
    };
}

/**
 * Every first-party source module, keyed by its `src`-relative path without
 * extension (forward-slashed). Used as the Rollup input map for the `lib` build so
 * each module becomes its own entry chunk — reproducing `preserveModules`-style
 * module-granular output, but with clean paths and while still allowing
 * `manualChunks` (the two are mutually exclusive in Rollup). `*-worker.ts` Web
 * Worker entry modules are excluded; Vite handles them via `?worker` imports.
 */
function enumerateLibEntries(): Record<string, string> {
    const entries: Record<string, string> = {};
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const full = resolve(dir, name);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.ts$/.test(name) || /\.d\.ts$/.test(name) || /-worker\.ts$/.test(name)) {
                continue;
            }
            const key = full
                .slice(SRC_DIR.length + 1)
                .replace(/\\/g, "/")
                .replace(/\.ts$/, "");
            entries[key] = full;
        }
    };
    walk(SRC_DIR);
    return entries;
}

/**
 * Bundled vendor runtimes routed into their own named chunk in BOTH builds. Keeping
 * each isolated (rather than merged into the always-loaded core) lets a consumer drop
 * the whole chunk when the corresponding feature is unused — and keeps `text-shaper`,
 * which has import-time initialisation and ships no `sideEffects: false`, from
 * defeating module-granular elimination of the default-layout text path.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [RegExp, string]> = [
    [/[\\/]node_modules[\\/]text-shaper[\\/]/, "vendor/text-shaper"],
    [/[\\/]node_modules[\\/]@?recast-navigation/, "vendor/recast-navigation"],
    [/[\\/]node_modules[\\/]manifold-3d[\\/]/, "vendor/manifold"],
];

function matchChunk(id: string, table: ReadonlyArray<readonly [RegExp, string]>): string | undefined {
    for (const [pattern, name] of table) {
        if (pattern.test(id)) {
            return name;
        }
    }
    return undefined;
}

export default defineConfig(({ mode }) => {
    const isDist = mode === "dist";
    const isWatch = process.argv.includes("--watch");

    if (isDist) {
        // Prebundled, minified, browser/CDN-ready build emitted into `build/dist/`: a
        // TRUE single-file `dist/index.js` containing ALL of Lite, including vendor
        // runtimes. `inlineDynamicImports` folds every dynamic import edge into the
        // entry chunk.
        //
        // This pass ALSO produces the shared rolled-up `index.d.ts` (a single-entry rollup
        // → one .d.ts) and relocates it to the build root via `relocateDts` so both `lib/`
        // and `dist/` share it. Type generation lives here (not in the `lib` pass) because
        // vite-plugin-dts can only roll up to one `index.d.ts` from a SINGLE entry; the
        // `lib` pass is multi-entry (one per source module) and would instead emit ~560
        // per-module `.d.ts` files.
        return {
            build: {
                outDir: DIST_OUT_DIR,
                emptyOutDir: true,
                // Match the scene/demo bundle harness (LITE_BUNDLE_TARGET) so the package
                // output is transformed identically to a source build. Crucially, "esnext"
                // emits NATIVE class fields; a lower target downlevels them to esbuild's
                // `__publicField` helper, bloating every class and diverging from source.
                target: "esnext",
                // Sourcemaps ON so Rollup composes `minifyBrowserChunks`'s esbuild
                // minify map with each chunk's chunk→source map, emitting a `.js.map`
                // that maps the minified browser bundle back to TypeScript source.
                sourcemap: true,
                // Minification is handled by `minifyBrowserChunks` (full esbuild minify
                // incl. whitespace); Vite's built-in esbuild minify is disabled because
                // in ES lib mode it forces `minifyWhitespace: false`.
                minify: false as const,
                lib: {
                    entry: resolve(SRC_DIR, "index.ts"),
                    formats: ["es" as const],
                    fileName: "index",
                },
                rollupOptions: {
                    output: {
                        // Force a true single-file dist artifact. This inlines all
                        // dynamic-imported feature paths and vendor runtimes into
                        // `dist/index.js`.
                        inlineDynamicImports: true,
                    },
                },
            },
            // Minify inlined `?worker&inline` blobs (opaque to downstream bundlers).
            worker: {
                format: "es" as const,
                plugins: () => [minifyInlinedWorker()],
            },
            plugins: [
                stripManifoldNodeRequire(),
                // `mangle: false` — strip WGSL whitespace/comments but do NOT short-rename
                // identifiers (the per-chunk mangler is unsafe across the package's many
                // code-split chunks). `templates: false` — only minify `?raw` `.wgsl` files,
                // not inline backtick-template WGSL: this output is not esbuild-minified, so
                // the template minifier would corrupt raw source, and the scene/demo harness
                // already minifies inline templates once when it bundles this output.
                wgslMinifyPlugin({ mangle: false, templates: false }),
                minifyBrowserChunks(),
                stripInlinedWorkerSourcemap(),
                dts({
                    rollupTypes: !isWatch,
                    tsconfigPath: resolve(__dirname, "tsconfig.json"),
                    outDir: DIST_OUT_DIR,
                }),
                ...(isWatch ? [] : [trimInternalDts({ outDir: DIST_OUT_DIR, projectFolder: __dirname }), relocateDts()]),
            ],
        };
    }

    // Module-granular library build for bundler consumers: one entry per source
    // module — this is the tree a real bundler resolves, and what the bundle-size
    // harness measures. Emits the shared package metadata (package.json, README,
    // LICENSE, THIRD_PARTY_NOTICES) into the build root. Does NOT emit types (see the
    // `dist` pass above). `build:lib` and `build:dist` write to disjoint subdirs +
    // non-conflicting root files, so they can run in either order after a clean.
    return {
        // Bake the resolved version into the `VERSION` export (engine.ts reads
        // `__BL_VERSION__`). esbuild constant-folds the `typeof` guard so the
        // published bundle reports the npm version it ships as.
        define: {
            __BL_VERSION__: JSON.stringify(resolveReleaseVersion()),
        },
        build: {
            outDir: LIB_OUT_DIR,
            emptyOutDir: true,
            // "esnext" => native class fields (no `__publicField` helper), matching the
            // bundle harness so a consumer of `lib/` gets byte-for-byte what a source
            // build produces.
            target: "esnext",
            sourcemap: true,
            minify: false as const,
            lib: {
                entry: enumerateLibEntries(),
                formats: ["es" as const],
            },
            rollupOptions: {
                output: {
                    entryFileNames: "[name].js",
                    chunkFileNames: "_chunks/[name]-[hash].js",
                    manualChunks(id: string) {
                        return matchChunk(id, VENDOR_CHUNKS);
                    },
                },
            },
        },
        // Minify inlined `?worker&inline` blobs (opaque to downstream bundlers); see
        // {@link minifyInlinedWorker}. Applied even though `lib` output is otherwise
        // unminified, because a consumer's bundler cannot minify worker code embedded
        // in a string literal.
        worker: {
            format: "es" as const,
            plugins: () => [minifyInlinedWorker()],
        },
        plugins: [stripManifoldNodeRequire(), wgslMinifyPlugin({ mangle: false, templates: false }), stripInlinedWorkerSourcemap(), emitPackageJson(), emitThirdPartyNotices()],
    };
});
