// Plain-`tsc` build for @babylonjs/lite-gl — no bundler (see docs/gl/architecture/00-lite-gl.md for rationale).
//
// `tsc` (driven by tsconfig.json: `outDir: dist`, `stripInternal`) emits one
// `.js` + `.d.ts` per source module straight into `dist/`, mirroring `src/`.
// Every relative import in `src` already carries an explicit `.js` extension, so
// the emitted JS is runnable native ESM — no resolver or bundler required.
//
// `tsc` does not emit a publish manifest, so after compiling we write the
// publish-ready `dist/package.json` (the scoped `@babylonjs/lite-gl` name with
// the public `exports` map) and copy the README. The GL npm pipeline publishes
// the `dist/` folder directly (`npm publish ./packages/babylon-lite-gl/dist`),
// so the manifest must live inside `dist/`.
//
// Kept dependency-free (plain Node ESM, no bundler/plugins) so the `gl-build`
// output test can invoke it directly via the node executable, without pnpm/npx
// needing to be on PATH.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(packageDir, "dist");
// TypeScript is a workspace devDependency hoisted to the repo-root node_modules.
const tscBin = resolve(packageDir, "../../node_modules/typescript/bin/tsc");
// `composite` makes tsc incremental; pin the build-info file so we can delete it
// for a guaranteed full emit (otherwise tsc sees "up to date" after we wipe dist
// and emits nothing).
const tsBuildInfo = resolve(packageDir, "tsconfig.tsbuildinfo");

rmSync(distDir, { recursive: true, force: true });
rmSync(tsBuildInfo, { force: true });
execFileSync(process.execPath, [tscBin, "-p", resolve(packageDir, "tsconfig.json"), "--tsBuildInfoFile", tsBuildInfo], { stdio: "inherit" });

// Release provenance recorded into the published package.json so the publish
// script (scripts/prepare-npm-release.ts) can dedupe reruns of the same Azure
// build. Populated only inside the pipeline, where BUILD_BUILDID /
// BUILD_SOURCEVERSION are set. Mirrors packages/babylon-lite.
const azureBuildId = process.env.BUILD_BUILDID;
const sourceVersion = process.env.BUILD_SOURCEVERSION;
const provenance = azureBuildId || sourceVersion ? { ...(azureBuildId ? { azureBuildId } : {}), ...(sourceVersion ? { sourceVersion } : {}) } : undefined;

// Default/local builds fall back to the source manifest version; release builds
// override it via PACKAGE_VERSION. Mirrors packages/babylon-lite.
const sourceVersionFallback = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")).version || "0.1.0";

// Publish-ready manifest. Mirrors the package's source `publishConfig`, with
// `exports`/`main`/`types` paths made relative to `dist/` (the publish root).
const manifest = {
    name: "@babylonjs/lite-gl",
    // The release pipeline resolves the next version and exposes it as
    // PACKAGE_VERSION before building; fall back to the source version for local
    // builds (mirrors packages/babylon-lite).
    version: process.env.PACKAGE_VERSION?.trim() || sourceVersionFallback,
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
        ".": { import: "./index.js", types: "./index.d.ts" },
    },
    ...(provenance ? { babylonLiteRelease: provenance } : {}),
};

writeFileSync(resolve(distDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

const readme = resolve(packageDir, "README.md");
if (existsSync(readme)) {
    copyFileSync(readme, resolve(distDir, "README.md"));
}
