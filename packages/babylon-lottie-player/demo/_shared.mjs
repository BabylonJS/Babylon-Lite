// Shared esbuild config + asset staging for the demo harness, used by both build.mjs (one-shot)
// and serve.mjs (watch + dev server). Keeps the alias/plugin/manifest logic in one place so the
// screenshot pipeline (build.mjs output) and the live viewer (serve.mjs) stay in sync.
import { existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = here;
export const DIST = resolve(here, "dist");
const repo = resolve(here, "..");

/** Real Lottie anims to copy next to the bundle: every `*.json` present in `anims/` (gitignored —
 *  drop your own; see anims/README.md). The synthetic "_stroketest" / "_masktest" are bundled into
 *  main.ts and added to the manifest without a file, so the viewer always has something to show. */
const animsFolder = resolve(repo, "anims");
export const ANIMS = existsSync(animsFolder)
    ? readdirSync(animsFolder)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
    : [];

/** Rewrite relative `*.js` imports to `*.ts` when a sibling .ts exists (the package uses .js specifiers). */
export const jsToTs = {
    name: "js-to-ts",
    setup(b) {
        b.onResolve({ filter: /\.js$/ }, (args) => {
            if (args.kind === "entry-point" || !args.path.startsWith(".")) {
                return undefined;
            }
            const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
            return existsSync(tsPath) ? { path: tsPath } : undefined;
        });
    },
};

// The package src imports the scoped `@babylonjs/lite-gl`, which esbuild resolves from node_modules
// — no alias needed (the demo never references the unscoped workspace specifier). The jsToTs plugin
// only rewrites the package's own relative `.js` → `.ts` source imports.

// Package source root (the .ts the worker entries live in).
const SRC = resolve(here, "..", "src");

/** Two esbuild configs, both emitting into demo/dist:
 *   • mainBuildOptions   → main.js          (ESM viewer; imports the package src + lite-gl)
 *   • workerBuildOptions → full.worker.js,  (CLASSIC IIFE render workers, self-contained)
 *                          shapes.worker.js
 * The viewer hands each worker's URL to the standalone factory, so the library loads it as a
 * CSP-friendly blob worker that `importScripts` the file — the same non-bundler
 * delivery path the package ships. Workers MUST be classic IIFE (not ESM) for
 * `importScripts` to accept them. */
const commonOptions = {
    bundle: true,
    minify: false,
    sourcemap: true,
    target: "esnext",
    outdir: DIST,
    plugins: [jsToTs],
};

/** The viewer bundle — ESM, since it uses `import.meta.url` and top-level module imports. */
export const mainBuildOptions = {
    ...commonOptions,
    entryPoints: { main: resolve(here, "main.ts") },
    format: "esm",
};

/** The render workers — CLASSIC IIFE so the library's blob worker can `importScripts` them. */
export const workerBuildOptions = {
    ...commonOptions,
    entryPoints: {
        "full.worker": resolve(SRC, "worker", "full.worker.ts"),
        "shapes.worker": resolve(SRC, "worker", "shapes.worker.ts"),
    },
    format: "iife",
};

/** Copy index.html + the available anim JSONs into dist and write manifest.json (the dropdown list). */
export function stageAssets() {
    mkdirSync(DIST, { recursive: true });
    copyFileSync(resolve(here, "index.html"), resolve(DIST, "index.html"));
    const present = [];
    for (const a of ANIMS) {
        const src = resolve(animsFolder, `${a}.json`);
        if (existsSync(src)) {
            copyFileSync(src, resolve(DIST, `${a}.json`));
            present.push(a);
        }
    }
    // Synthetic tests first, then whichever real anims are available locally.
    const manifest = ["_stroketest", "_masktest", ...present];
    writeFileSync(resolve(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return manifest;
}
