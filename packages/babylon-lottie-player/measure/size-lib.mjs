// Shared size-measurement library — the single source of truth for the sprite-vs-stencil bundle
// sizes used by the dashboard. Keeping one copy avoids the methodology drift that made the
// founding 11-vs-20 numbers unfair.
//
// Each player is esbuild-bundled (minify + treeShaking, gzip L9) with babylon-lite-gl TREE-SHAKEN IN
// — BOTH players against the SAME installed @babylonjs/lite-gl. The sprite player keeps its shipped
// feature chunks; the stencil player is measured as the two variants it actually ships: full and
// shapes-only.

import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MEASURE_DIR = here;
export const repo = resolve(here, "..");
/** Measurement reference players live here; see vendor/README.md. Including the sprite source makes
 *  the comparison reproducible on any clone and visible to CI. */
export const vendorDir = resolve(here, "vendor");
export const spriteDir = resolve(vendorDir, "sprite");
/** Local Lottie fixtures live in a gitignored `anims/` directory (see anims/README.md). */
export const animsDir = resolve(repo, "anims");

/** Every `*.json` present in `anims/`, in alphabetical order. */
export const ANIMS = existsSync(animsDir)
    ? readdirSync(animsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort()
    : [];

export const roundKB = (bytes) => Math.round((bytes / 1024) * 10) / 10;
const gz = (buf) => gzipSync(buf, { level: 9 }).byteLength;
const baseName = (p) => (p || "").replace(/\\/g, "/").split("/").pop();

/** Rewrite relative `*.js` imports to `*.ts` when a sibling .ts exists (both players use .js specifiers). */
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

/** Externalize the worker URL a main-thread CLIENT references via `new Worker(new URL("./x.worker.js"
 *  | "./workerEntry", import.meta.url))`, so a client size build measures ONLY the main-thread bytes
 *  and never inlines the worker chunk. Never externalizes the entry point itself. */
const externalizeWorker = {
    name: "externalize-worker",
    setup(b) {
        b.onResolve({ filter: /(\.worker(\.[jt]s)?|workerEntry(\.[jt]s)?)$/ }, (args) => (args.kind === "entry-point" ? undefined : { external: true }));
    },
};

// BOTH players are measured against the SAME babylon-lite-gl: the installed @babylonjs/lite-gl npm
// package this repo depends on. That's what each player actually ships against in production, so it
// isolates the PLAYER's size rather than conflating it with two different lite-gl variants. The
// vendored sprite imports the unscoped `babylon-lite-gl` (+ /sprites, /dynamic-texture subpaths);
// the alias below maps those to the installed package's per-module files (its barrel re-exports the
// same symbols, and the subpath files ship in the published dist), so the sprite is measured against
// the exact lite-gl the stencil player uses. Resolved via import.meta.resolve (the package's exports
// map is import-only, so the CJS require.resolve cannot see it).
const glEntry = fileURLToPath(import.meta.resolve("@babylonjs/lite-gl"));
export const GL_DIR = dirname(glEntry);
const glExtension = extname(glEntry);
const stencilGl = GL_DIR;
const spriteGl = GL_DIR;
/** babylon-lite-gl → installed-package alias (barrel + subpaths). `glSrc` is the installed
 *  @babylonjs/lite-gl directory; its published dist ships one `.js` per module. */
export function aliasFor(glSrc) {
    return {
        "babylon-lite-gl": resolve(glSrc, `index${glExtension}`),
        "babylon-lite-gl/sprites": resolve(glSrc, `sprites${glExtension}`),
        "babylon-lite-gl/dynamic-texture": resolve(glSrc, `dynamic-texture${glExtension}`),
        "babylon-lite-gl/html-texture": resolve(glSrc, `html-texture${glExtension}`),
        "babylon-lite-gl/render-target": resolve(glSrc, `render-target${glExtension}`),
        "babylon-lite-gl/mesh": resolve(glSrc, `mesh${glExtension}`),
        "babylon-lite-gl/depth-stencil": resolve(glSrc, `depth-stencil${glExtension}`),
        "babylon-lite-gl/scissor": resolve(glSrc, `scissor${glExtension}`),
    };
}

async function buildSplit(entry, outdir, alias, extraPlugins = []) {
    rmSync(outdir, { recursive: true, force: true });
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        legalComments: "none",
        splitting: true,
        outdir,
        metafile: true,
        write: true,
        alias,
        plugins: [...extraPlugins, jsToTs],
        logLevel: "error",
    });
    const chunks = [];
    for (const [file, info] of Object.entries(result.metafile.outputs)) {
        const bytes = readFileSync(file);
        chunks.push({
            name: baseName(file),
            raw: bytes.length,
            gzip: gz(bytes),
            inputs: Object.keys(info.inputs).map((p) => p.replace(/\\/g, "/")),
        });
    }
    return chunks;
}

/** Sum every chunk of a build → { raw, gzip } bytes. Used for the small main-thread worker CLIENTS,
 *  which have no meaningful per-feature split (all their code is on the critical path). */
function sumFlat(chunks) {
    let raw = 0;
    let gzip = 0;
    for (const c of chunks) {
        raw += c.raw;
        gzip += c.gzip;
    }
    return { raw, gzip };
}

/** Sprite chunks: base + solid + shape + text + gradient (the featureRegistry features). */
function classifySprite(chunks) {
    const r = { base: { raw: 0, gzip: 0 }, solid: null, shape: null, text: null, gradient: null };
    for (const c of chunks) {
        const inc = (s) => c.inputs.some((p) => p.includes(s));
        if (inc("features/shapes/gradient")) {
            r.gradient = c;
        } else if (inc("features/solid")) {
            r.solid = c;
        } else if (inc("features/shape")) {
            r.shape = c;
        } else if (inc("features/text")) {
            r.text = c;
        } else {
            r.base.raw += c.raw;
            r.base.gzip += c.gzip;
        }
    }
    return r;
}

/** Detect which feature chunks an animation triggers (mirrors each player's own rules). */
export function detect(json) {
    let ty1 = false,
        ty2 = false,
        ty4 = false,
        ty5 = false,
        stroke = false,
        grad = false,
        drawable = false;
    const scan = (items) => {
        for (const it of items || []) {
            if (it?.hd === true) {
                continue;
            }
            const t = it?.ty;
            if (t === "fl" || t === "gf") {
                drawable = true;
            }
            if (t === "st") {
                stroke = true;
                drawable = true;
            }
            if (t === "gs") {
                stroke = true;
                grad = true;
                drawable = true;
            }
            if (t === "gf") {
                grad = true;
            }
            if (t === "gr") {
                scan(it.it);
            }
        }
    };
    for (const layer of json.layers || []) {
        if (layer?.hd === true) {
            continue;
        }
        const ty = layer.ty;
        if (ty === 1) {
            ty1 = true;
        } else if (ty === 2) {
            ty2 = true;
        } else if (ty === 4) {
            ty4 = true;
            scan(layer.shapes);
        } else if (ty === 5) {
            ty5 = true;
        }
    }
    return {
        stencil: { shapes: ty4 && drawable, solidShapes: ty1, strokes: stroke, images: ty2, text: ty5 },
        sprite: { solid: ty1, shape: ty4, text: ty5, gradient: grad, images: ty2 },
    };
}

/**
 * Static capability check for the SPRITE (raster atlas) player. It pre-renders the animation to a
 * fixed sprite atlas, so it CANNOT represent four Lottie features (it draws pixels for them, but
 * the output is wrong — frozen first-frame paths, missing images, ignored masks):
 *   • images  (ty:2 layers) — no image-layer support at all (renders blank).
 *   • morphs  (animated shape PATH vertices, `sh` with `ks.a === 1`) — the atlas bakes one frame,
 *     so a morphing path freezes instead of deforming.
 *   • masks   (layer.masksProperties) — masks are not applied; clipped content leaks.
 *   • mattes  (layer.tt/td) — track-matte sources are painted instead of clipping consumers.
 * Returns { supported, reasons } so the dashboard can mark these animations N/A for the sprite
 * player rather than showing misleadingly "good" numbers for a broken render. Transform animation
 * (position/scale/rotation/opacity) is fine — that's the sprite player's whole point.
 */
export function spriteCapability(json) {
    let images = false;
    let masks = false;
    let mattes = false;
    let morph = false;
    const scanShape = (items) => {
        for (const it of items || []) {
            if (it?.hd === true) {
                continue;
            }
            // Animated path vertices = a morph the atlas can't bake. (Animated rect/ellipse SIZE is
            // also a deform, but the test corpus expresses morphs as animated `sh` paths.)
            if (it?.ty === "sh" && it.ks && it.ks.a === 1) {
                morph = true;
            }
            if (it?.ty === "gr") {
                scanShape(it.it);
            }
        }
    };
    for (const layer of json.layers || []) {
        if (layer?.hd === true) {
            continue;
        }
        if (layer.ty === 2) {
            images = true;
        }
        if (Array.isArray(layer.masksProperties) && layer.masksProperties.length > 0) {
            masks = true;
        }
        if (layer.tt || layer.td) {
            mattes = true;
        }
        if (layer.ty === 4) {
            scanShape(layer.shapes);
        }
    }
    const reasons = [];
    if (images) {
        reasons.push("images");
    }
    if (morph) {
        reasons.push("morphs");
    }
    if (masks) {
        reasons.push("masks");
    }
    if (mattes) {
        reasons.push("mattes");
    }
    return { supported: reasons.length === 0, reasons };
}

/** Sum a classified player's base + selected chunks → { raw, gzip } bytes. */
function sumChunks(cls, chunks) {
    let raw = cls.base.raw;
    let gzip = cls.base.gzip;
    for (const c of chunks) {
        if (c) {
            raw += c.raw;
            gzip += c.gzip;
        }
    }
    return { raw, gzip };
}

/** Per-animation cost for the shipped players. Sprite loads triggered feature chunks; the full
 *  stencil player is one flat bundle for every animation. */
export function costForAnim(sizes, f) {
    const { sprite, stencil } = sizes;
    const spr = sumChunks(sprite, [f.sprite.solid && sprite.solid, f.sprite.shape && sprite.shape, f.sprite.text && sprite.text, f.sprite.gradient && sprite.gradient]);
    return { sprite: spr, stencil };
}

/** Measure the shipped full stencil bundle and classify the sprite player's feature chunks. */
export async function measureSizes() {
    mkdirSync(resolve(here, ".out"), { recursive: true });
    const stencil = await buildFlat(resolve(here, "full-local.ts"));
    const sprite = classifySprite(await buildSplit(resolve(here, "sprite-entry.ts"), resolve(here, ".out", "size-sprite"), aliasFor(spriteGl)));
    return { sprite, stencil };
}

/**
 * Build + classify the PRODUCTION WORKER delivery for both players: the off-thread path actually
 * shipped (the non-worker player is for testing/measurement). The stencil side measures the actual
 * flat full and shapes workers, each plus its matching main-thread client.
 *
 * The included sprite worker already dynamic-imports the parser, controller, and feature modules,
 * so it splits the same way.
 * Clients externalize their worker URL so they measure ONLY main-thread bytes.
 *
 * @returns `{ sprite, fullWorker, shapesWorker, spriteClient, fullClient, shapesClient }`.
 */
export async function measureWorkerSizes() {
    mkdirSync(resolve(here, ".out"), { recursive: true });
    const spriteWorkerEntry = resolve(spriteDir, "workerEntry.ts");
    const spriteClientEntry = resolve(spriteDir, "playerRuntime.ts");

    const sprite = classifySprite(await buildSplit(spriteWorkerEntry, resolve(here, ".out", "wkr-sprite"), aliasFor(spriteGl), [externalizeWorker]));
    const fullWorker = sumFlat(await buildSplit(resolve(repo, "src", "worker", "full.worker.ts"), resolve(here, ".out", "wkr-stencil-full"), aliasFor(stencilGl)));
    const shapesWorker = sumFlat(await buildSplit(resolve(repo, "src", "worker", "shapes.worker.ts"), resolve(here, ".out", "wkr-stencil-shapes"), aliasFor(stencilGl)));
    const fullClient = sumFlat(await buildSplit(resolve(here, "worker-full-client.ts"), resolve(here, ".out", "wkr-stencil-client"), aliasFor(stencilGl), [externalizeWorker]));
    const shapesClient = sumFlat(
        await buildSplit(resolve(here, "worker-shapes-client.ts"), resolve(here, ".out", "wkr-stencil-shapes-client"), aliasFor(stencilGl), [externalizeWorker])
    );
    const spriteClient = sumFlat(await buildSplit(spriteClientEntry, resolve(here, ".out", "wkr-sprite-client"), aliasFor(spriteGl), [externalizeWorker]));

    return { sprite, fullWorker, shapesWorker, spriteClient, fullClient, shapesClient };
}

/** Per-animation production cost with a worker. Sprite loads triggered chunks; full stencil always
 *  loads the complete full worker. */
export function workerCostForAnim(worker, f) {
    const addClient = (bytes, client) => ({ raw: bytes.raw + client.raw, gzip: bytes.gzip + client.gzip });
    const spr = sumChunks(worker.sprite, [
        f.sprite.solid && worker.sprite.solid,
        f.sprite.shape && worker.sprite.shape,
        f.sprite.text && worker.sprite.text,
        f.sprite.gradient && worker.sprite.gradient,
    ]);
    return { sprite: addClient(spr, worker.spriteClient), stencil: addClient(worker.fullWorker, worker.fullClient) };
}

/** Production cost with the shapes worker: shapes client + flat shapes worker. */
export function shapesWorkerCost(worker) {
    return { raw: worker.shapesWorker.raw + worker.shapesClient.raw, gzip: worker.shapesWorker.gzip + worker.shapesClient.gzip };
}

/** Flat (single-bundle) size of a stencil-player entry — minify + treeShaking, no code-splitting,
 *  babylon-lite-gl tree-shaken in. This is the REAL shipped size of a subpath entry. */
async function buildFlat(entry) {
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        legalComments: "none",
        alias: aliasFor(stencilGl),
        plugins: [jsToTs],
        write: false,
        logLevel: "error",
    });
    let raw = 0;
    for (const f of result.outputFiles) {
        raw += f.contents.byteLength;
    }
    return { raw, gzip: gz(Buffer.from(result.outputFiles[0].contents)) };
}

/**
 * Measure the two flat local stencil variants using equivalent local-only API surfaces.
 * Returns { full, shapes } in bytes.
 */
export async function measureVariants() {
    const full = await buildFlat(resolve(here, "full-local.ts"));
    const shapes = await buildFlat(resolve(here, "shapes-local.ts"));
    return { full, shapes };
}

/** True when an animation can use the shapes-only variant: shape/solid content, no text/images. */
export function shapesEligible(json) {
    const f = detect(json);
    return (f.stencil.shapes || f.stencil.solidShapes) && !f.stencil.text && !f.stencil.images;
}

/**
 * Measure the CURRENT PRODUCTION Babylon.js Lottie player (`@babylonjs/lottie-player`, consumed from
 * npm) as a FLAT bundle on the SAME esbuild basis as the lite players (minify + treeShaking + gzip
 * L9), with its `@babylonjs/core` ThinEngine slice tree-shaken in. Unlike the lite players it has no
 * per-feature code split, so its "cost to play" any animation is this one constant number. Measured
 * via the main-thread `LocalPlayer` entry (`measure/babylonjs-entry.ts`) so it's the apples-to-apples
 * "everything loaded" size. It's the player customers ship TODAY — the baseline the lite players improve on.
 * @returns `{ raw, gzip }` bytes.
 */
export async function measureBabylon() {
    const result = await build({
        entryPoints: [resolve(here, "babylonjs-entry.ts")],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        legalComments: "none",
        write: false,
        logLevel: "error",
    });
    let raw = 0;
    let gzip = 0;
    for (const f of result.outputFiles) {
        raw += f.contents.byteLength;
        gzip += gz(f.contents);
    }
    return { raw, gzip };
}

/**
 * Measure lottie-react (^2.3.1) as a FLAT bundle on the SAME esbuild basis as the other players
 * (minify + treeShaking + gzip L9), with React marked EXTERNAL — a React app already ships React, so
 * this isolates the incremental Lottie bytes (the lottie-react wrapper + the lottie-web engine).
 * lottie-react is a thin wrapper over lottie-web, the reference CPU renderer (SVG/Canvas2D); it's a
 * production Lottie player used in some products, measured via `measure/lottie-react-entry.ts`.
 * @returns `{ raw, gzip }` bytes.
 */
export async function measureLottieReact() {
    const result = await build({
        entryPoints: [resolve(here, "lottie-react-entry.ts")],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: "esm",
        target: "esnext",
        platform: "browser",
        legalComments: "none",
        external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
        define: { "process.env.NODE_ENV": '"production"' },
        write: false,
        logLevel: "error",
    });
    let raw = 0;
    let gzip = 0;
    for (const f of result.outputFiles) {
        raw += f.contents.byteLength;
        gzip += gz(f.contents);
    }
    return { raw, gzip };
}
