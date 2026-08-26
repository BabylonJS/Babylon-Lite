// ONE COMMAND → full Sprite-vs-Stencil comparison + shareable dashboard.
//
//   node packages/babylon-lottie-player/measure/bench/run.mjs
//
// Measures bundle size (per-animation, both players, lite-gl tree-shaken in) AND runtime perf
// (Potential FPS, draw calls, init, time-to-first-frame, RAF CPU avg/p95, memory) in headed Chrome,
// then writes a self-contained dashboard.html (open it / email it) plus results.json.
//
// Env: PERF_DURATION=5 (seconds per measurement), ANIMS="anim1,anim2" (subset), NO_OPEN=1 (don't auto-open).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
    ANIMS,
    animsDir,
    costForAnim,
    detect,
    measureBabylon,
    measureLottieReact,
    measureSizes,
    measureVariants,
    measureWorkerSizes,
    roundKB,
    shapesEligible,
    shapesWorkerCost,
    spriteCapability,
    workerCostForAnim,
} from "../size-lib.mjs";
import { buildBench, DIST } from "./build.mjs";
import { runPerf } from "./perf.mjs";
import { generateDashboard } from "./dashboard.mjs";

const anims = (process.env.ANIMS ? process.env.ANIMS.split(",").map((s) => s.trim()) : ANIMS).filter((a) => existsSync(resolve(animsDir, `${a}.json`)));

// Static capability per animation: the sprite (raster atlas) player can't represent images,
// morphs, or masks — pre-scan so those cells are marked unsupported (and not perf-measured). The
// production Babylon.js player is ALSO a raster atlas with the SAME three limitations (its docs list
// no image/mask/matte support and animate only the layer transform, not shape morphs), so it shares
// the same capability gate.
const cap = {};
for (const anim of anims) {
    const json = JSON.parse(readFileSync(resolve(animsDir, `${anim}.json`), "utf8"));
    cap[anim] = { sprite: spriteCapability(json), babylon: spriteCapability(json) };
}

console.log(`\n● Measuring bundle size (esbuild, gzip, lite-gl tree-shaken in)…`);
const sizes = await measureSizes();

console.log(`● Measuring PRODUCTION Babylon.js player size (@babylonjs/lottie-player, flat, @babylonjs/core tree-shaken in)…`);
const babylonSize = await measureBabylon();
console.log(`  babylon (prod): ${roundKB(babylonSize.gzip)} KB gz · ${roundKB(babylonSize.raw)} KB raw`);

console.log(`● Measuring PRODUCTION lottie-react size (lottie-react + lottie-web, flat, React external)…`);
const lottieSize = await measureLottieReact();
console.log(`  lottie-react (prod): ${roundKB(lottieSize.gzip)} KB gz · ${roundKB(lottieSize.raw)} KB raw`);

console.log(`● Measuring PRODUCTION worker delivery (main-thread client + shipped worker, both players)…`);
const worker = await measureWorkerSizes();
const shapesW = shapesWorkerCost(worker);
console.log(`  clients: full ${roundKB(worker.fullClient.gzip)} · sprite ${roundKB(worker.spriteClient.gzip)} · shapes ${roundKB(worker.shapesClient.gzip)} KB gz`);

console.log(`● Measuring full and shapes-only stencil variants…`);
const variants = await measureVariants();
console.log(`  full ${roundKB(variants.full.gzip)} KB gz → shapes-only ${roundKB(variants.shapes.gzip)} KB gz (local) · ${roundKB(shapesW.gzip)} KB gz (worker)`);

console.log(`● Building perf bench bundles…`);
await buildBench();

console.log(`● Running runtime perf in headed Chrome (${anims.length} anims × 2 players, ${Number(process.env.PERF_DURATION || 5)}s each)…`);
const perf = await runPerf(DIST, anims, (anim, player) =>
    (player === "sprite" || player === "babylon") && !cap[anim].sprite.supported ? cap[anim].sprite.reasons.join("+") : null
);

// Combine size + perf per animation into the dashboard shape. An animation the sprite player can't
// represent is fully N/A for sprite (size included — you can't "play" what it can't render).
const combined = {};
for (const anim of anims) {
    const json = JSON.parse(readFileSync(resolve(animsDir, `${anim}.json`), "utf8"));
    const features = detect(json);
    const cost = costForAnim(sizes, features);
    const wcost = workerCostForAnim(worker, features);
    const sizeOf = (bytes) => ({ rawKB: roundKB(bytes.raw), gzipKB: roundKB(bytes.gzip) });
    const merge = (player, bytes, wbytes) => ({
        rawKB: roundKB(bytes.raw),
        gzipKB: roundKB(bytes.gzip),
        // Production delivery with the worker: main-thread client + the actual shipped worker.
        worker: sizeOf(wbytes),
        ...perf[anim][player],
    });
    const sprite = cap[anim].sprite.supported
        ? merge("sprite", cost.sprite, wcost.sprite)
        : { unsupported: cap[anim].sprite.reasons.join("+"), rendered: false, ...perf[anim].sprite };
    const stencil = merge("stencil", cost.stencil, wcost.stencil);
    // Eligible vector-only animations can use the flat shapes entry and matching shapes worker.
    if (shapesEligible(json)) {
        stencil.shapes = sizeOf(variants.shapes);
        stencil.shapesWorker = sizeOf(shapesW);
    }
    // The CURRENT PRODUCTION Babylon.js player: flat size (constant across anims — no per-feature
    // split), plus its runtime perf. Same raster-atlas limitations as the lite sprite player, so it's
    // fully N/A (size + perf) for the same morph/mask/image animations.
    const babylon = cap[anim].babylon.supported
        ? { rawKB: roundKB(babylonSize.raw), gzipKB: roundKB(babylonSize.gzip), ...perf[anim].babylon }
        : { unsupported: cap[anim].babylon.reasons.join("+"), rendered: false, ...perf[anim].babylon };
    // lottie-react (lottie-web) renders the FULL Lottie format — never capability-gated. Flat size
    // (constant across anims) + its TTF/memory perf (WebGL-specific metrics are N/A; see perf.mjs).
    const lottie = { rawKB: roundKB(lottieSize.raw), gzipKB: roundKB(lottieSize.gzip), ...perf[anim].lottie };
    combined[anim] = { sprite, stencil, babylon, lottie };
}

const html = generateDashboard(combined, { note: "Per-animation bundle size + runtime perf — production Babylon.js vs lite sprite vs lite stencil, WebGL2." });
const htmlPath = resolve(DIST, "dashboard.html");
writeFileSync(htmlPath, html);
writeFileSync(resolve(DIST, "results.json"), JSON.stringify(combined, null, 2) + "\n");

console.log(`\n✓ Dashboard:  ${htmlPath}`);
console.log(`  results.json: ${resolve(DIST, "results.json")}`);

if (!process.env.NO_OPEN) {
    // Windows-friendly open; harmless elsewhere.
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", htmlPath]] : process.platform === "darwin" ? ["open", [htmlPath]] : ["xdg-open", [htmlPath]];
    try {
        spawn(opener[0], opener[1], { detached: true, stdio: "ignore" }).unref();
    } catch {
        // Opening is best-effort.
    }
}
