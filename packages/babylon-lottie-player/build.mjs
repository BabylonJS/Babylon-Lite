// Plain-`tsc` build for @babylonjs/lottie-player — no bundler, modeled on @babylonjs/lite-gl's build.
//
// `tsc` (driven by tsconfig.json: `outDir: dist`, `stripInternal`) emits one `.js` + `.d.ts` per
// source module straight into `dist/`, mirroring `src/`. Every relative import in `src` already
// carries an explicit `.js` extension, so the emitted JS is runnable native ESM — no bundler
// required. The default (`.`) entry's worker clients use `new Worker(new URL("./full.worker.js",
// import.meta.url))`, which a consumer's bundler (Vite/webpack) statically detects to emit + locate
// the worker chunk; the package blob-wraps it at runtime so it loads under a `worker-src blob:` CSP.
//
// Keeping the package UNBUNDLED (one module per file) is deliberate: this player's whole identity is
// per-feature tree-shaking, so we defer bundling to the consumer rather than shipping one blob.
//
// After the per-module `tsc` emit, we esbuild-bundle the worker entry points into single-file,
// self-contained CLASSIC workers under `dist/workers/` (lite-gl inlined + minified) for non-bundler
// hosts that consume the `./standalone` entry with an injected `workerUrl`.
//
// `tsc` does not emit a publish manifest, so after compiling we write the publish-ready
// `dist/package.json` (the scoped `@babylonjs/lottie-player` name; the `.`/`./shapes`/`./standalone`
// exports map plus the prebuilt `./workers/*` files; and — critically — the `@babylonjs/lite-gl`
// runtime dependency) and copy the README + license. The npm pipeline publishes the `dist/` folder
// directly (`npm publish ./dist`), so the manifest lives in `dist/`. Uses esbuild (a devDependency)
// to bundle the prebuilt workers; otherwise plain Node ESM.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const packageDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(packageDir, "dist");
// TypeScript is a workspace devDependency hoisted to the repository root.
const tscBin = resolve(packageDir, "../../node_modules/typescript/bin/tsc");
const tsBuildInfo = resolve(packageDir, "tsconfig.tsbuildinfo");

// Full, clean emit: wipe dist + the incremental build-info so tsc never short-circuits to "up to
// date" after we delete dist.
rmSync(distDir, { recursive: true, force: true });
rmSync(tsBuildInfo, { force: true });
execFileSync(process.execPath, [tscBin, "-p", resolve(packageDir, "tsconfig.json"), "--tsBuildInfoFile", tsBuildInfo], { stdio: "inherit" });

const source = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

// Generic classic-script client for hosts without a module bundler. Callers supply either prebuilt
// worker URL below; the client itself is renderer-variant agnostic.
esbuild.buildSync({
    entryPoints: [resolve(distDir, "standalone.js")],
    outfile: resolve(distDir, "standalone.min.js"),
    bundle: true,
    format: "iife",
    globalName: "LiteLottie",
    platform: "browser",
    target: "es2020",
    minify: true,
    // These fields belong to the opaque LottieWorkerPlayer handle. Keep public options/input and
    // cross-thread protocol properties (notably `canvas`) unmangled.
    mangleProps: /^(spawn|worker|input|animWidth|animHeight|resizeObserver|_worker)$/,
    legalComments: "none",
});

// Auto-starting, fixed-layout shapes splash for first-paint-critical hosts. This is a paired static
// asset rather than an ESM API: client.min.js derives resource URLs from document.currentScript and
// expects worker.min.js plus the animation JSON beside it.
const fixedShapesSplashDir = resolve(distDir, "fixed-shapes-splash");
esbuild.buildSync({
    entryPoints: [resolve(packageDir, "src/fixed-shapes-splash.ts")],
    outfile: resolve(fixedShapesSplashDir, "client.min.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
});
for (const suffix of [".js", ".js.map", ".d.ts"]) {
    rmSync(resolve(distDir, `fixed-shapes-splash${suffix}`), { force: true });
}

// Prebuilt, self-contained CLASSIC workers for non-bundler hosts, consumed via the
// `./standalone` entry's `workerUrl`. Unlike the per-module `dist/worker/*.js` chunks (which a
// consumer's bundler stitches together), these are single-file IIFE bundles with `@babylonjs/lite-gl`
// INLINED and minified — a classic worker that `importScripts` can load under a `worker-src blob:`
// CSP. Bundled from the tsc output, where every `.js` specifier already resolves on disk.
const workersOutDir = resolve(distDir, "workers");
for (const variant of ["full", "shapes"]) {
    esbuild.buildSync({
        entryPoints: [resolve(distDir, `worker/${variant}.worker.js`)],
        outfile: resolve(workersOutDir, `${variant}.worker.js`),
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2020",
        minify: true,
        legalComments: "none",
    });
}
copyFileSync(resolve(workersOutDir, "shapes.worker.js"), resolve(fixedShapesSplashDir, "worker.min.js"));

// Release provenance recorded into the published manifest so a publish script can dedupe reruns of
// the same CI build. Populated only in CI, where these are set. Mirrors the lite-gl build.
const azureBuildId = process.env.BUILD_BUILDID;
const sourceVersion = process.env.BUILD_SOURCEVERSION;
const provenance = azureBuildId || sourceVersion ? { ...(azureBuildId ? { azureBuildId } : {}), ...(sourceVersion ? { sourceVersion } : {}) } : undefined;

// Release CI resolves the next version and exposes it as PACKAGE_VERSION before building; fall back
// to the source manifest version for local builds. Mirrors lite-gl.
const version = process.env.PACKAGE_VERSION?.trim() || source.version || "0.1.0";

// Publish-ready manifest. Paths are relative to `dist/` (the publish root). `@babylonjs/lite-gl`
// remains external in the ESM entries, so consumers install it alongside this package.
const manifest = {
    name: "@babylonjs/lottie-player",
    version,
    description: source.description,
    keywords: source.keywords,
    license: source.license,
    repository: source.repository,
    homepage: source.homepage,
    type: "module",
    main: "./index.js",
    module: "./index.js",
    types: "./index.d.ts",
    sideEffects: ["./fixed-shapes-splash/client.min.js"],
    exports: {
        ".": { import: "./index.js", types: "./index.d.ts" },
        "./shapes": { import: "./shapes.js", types: "./shapes.d.ts" },
        "./standalone": { import: "./standalone.js", types: "./standalone.d.ts" },
        "./standalone.min.js": "./standalone.min.js",
        "./fixed-shapes-splash/client.min.js": "./fixed-shapes-splash/client.min.js",
        "./fixed-shapes-splash/worker.min.js": "./fixed-shapes-splash/worker.min.js",
        "./workers/full.worker.js": "./workers/full.worker.js",
        "./workers/shapes.worker.js": "./workers/shapes.worker.js",
    },
    // Source resolves this public specifier to the local `babylon-lite-gl` workspace package.
    // Published consumers must receive a normal npm range, never a workspace protocol.
    dependencies: { "@babylonjs/lite-gl": "^1.7.0" },
    ...(provenance ? { babylonLiteRelease: provenance } : {}),
};

writeFileSync(resolve(distDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

for (const doc of ["README.md", "license.md"]) {
    const from = resolve(packageDir, doc);
    if (existsSync(from)) {
        copyFileSync(from, resolve(distDir, doc));
    }
}

console.log(`Built @babylonjs/lottie-player ${version} → ${distDir}`);
