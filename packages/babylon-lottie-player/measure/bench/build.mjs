// Build the two perf adapter bundles (sprite + stencil) into bench/dist, copy the page, and stage
// the anim JSONs. Both adapters are bundled against the SAME installed @babylonjs/lite-gl,
// tree-shaken in — same basis as the size measurement, so perf and size are apples-to-apples and
// match production.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasFor, animsDir, GL_DIR } from "../size-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(here, "dist");

const jsToTs = {
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

// Both players are bundled against the SAME installed @babylonjs/lite-gl, tree-shaken in — same
// basis as the size measurement, so perf and size are apples-to-apples and match production.
const stencilGl = GL_DIR;
const spriteGl = GL_DIR;

async function bundle(entry, outfile, glSrc) {
    await build({
        entryPoints: [entry],
        bundle: true,
        minify: false,
        sourcemap: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        outfile,
        alias: aliasFor(glSrc),
        plugins: [jsToTs],
        logLevel: "error",
    });
}

// The production Babylon.js + lottie-react players come from npm, so they need no babylon-lite-gl
// alias — bundle them straight. Unminified + sourcemap, like the others. `define` sets NODE_ENV so
// lottie-web / React don't hit a `process.env` ReferenceError in the browser bundle.
async function bundleNpm(entry, outfile) {
    await build({
        entryPoints: [entry],
        bundle: true,
        minify: false,
        sourcemap: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        outfile,
        define: { "process.env.NODE_ENV": '"production"' },
        logLevel: "error",
    });
}

export async function buildBench() {
    mkdirSync(resolve(DIST, "anims"), { recursive: true });
    await bundle(resolve(here, "stencil-perf.ts"), resolve(DIST, "stencil-perf.js"), stencilGl);
    await bundle(resolve(here, "sprite-perf.ts"), resolve(DIST, "sprite-perf.js"), spriteGl);
    await bundleNpm(resolve(here, "babylon-perf.ts"), resolve(DIST, "babylon-perf.js"));
    await bundleNpm(resolve(here, "lottie-perf.ts"), resolve(DIST, "lottie-perf.js"));
    copyFileSync(resolve(here, "page.html"), resolve(DIST, "page.html"));
    for (const f of readdirSync(animsDir)) {
        if (f.endsWith(".json")) {
            copyFileSync(resolve(animsDir, f), resolve(DIST, "anims", f));
        }
    }
    return DIST;
}

// Allow running standalone: node bench/build.mjs
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await buildBench();
    console.log(`built bench -> ${DIST}`);
}
