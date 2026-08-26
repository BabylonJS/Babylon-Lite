// Interactive viewer + screenshot harness for @babylonjs/lottie-player.
//
// Run live:   node demo/serve.mjs   → open the printed URL, pick an animation from the dropdown.
// Screenshot: node demo/screenshot.mjs <name[@t]>…  (drives ?anim= / ?t= and canvas.dataset.ready)
//
// The dropdown is populated from manifest.json (written by serve.mjs / build.mjs). The synthetic
// "_stroketest" entry is bundled in (no fetch); everything else is a Lottie JSON copied next to
// this bundle.

import { disposeGLEngine, type GLEngineContext } from "@babylonjs/lite-gl";
import type { LottieFile } from "../src/animation/lottie-raw.js";
import { createLottiePlayer } from "../src/player/full-player.js";
import { createShapePlayer } from "../src/player/shapes-player.js";
import { createVectorEngine, disposePlayer, isPlayerReady, renderLottieFrame, type LottiePlayer } from "../src/player/player-core.js";
import { createLottieWorkerPlayer } from "../src/standalone.js";
import { playWorkerAnimationAsync, disposeWorkerPlayer, type LottieWorkerPlayer, type LottieWorkerInput } from "../src/client/runtime.js";
import { STROKE_TEST } from "./stroke-test.js";
import { MASK_TEST } from "./mask-test.js";

const selectEl = document.getElementById("anim") as HTMLSelectElement;
const rendererEl = document.getElementById("renderer") as HTMLSelectElement;
const threadEl = document.getElementById("thread") as HTMLSelectElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const scrub = document.getElementById("scrub") as HTMLInputElement;
const info = document.getElementById("info") as HTMLSpanElement;
const checker = document.getElementById("checker") as HTMLDivElement;

const qs = new URLSearchParams(location.search);

/** Player factories the renderer selector switches between. The shapes-only entry omits the text +
 *  image renderers, so it renders vector-only animations (a vector-only splashscreen) identically
 *  to the full player but ships a smaller bundle. */
const RENDERERS = {
    full: { label: "Full", create: createLottiePlayer },
    shapes: { label: "Shapes-only", create: createShapePlayer },
} as const;
type RendererKind = keyof typeof RENDERERS;
let renderer: RendererKind = qs.get("renderer") === "shapes" ? "shapes" : "full";

/** Main-thread (externally driven, for testing) vs Worker (the off-thread path the library ships,
 *  which self-drives its own render loop on an OffscreenCanvas). */
type ThreadKind = "main" | "worker";
let thread: ThreadKind = qs.get("thread") === "worker" ? "worker" : "main";

/** URL of the demo's esbuild-built CLASSIC worker (dist/<name>.worker.js, next to main.js), handed
 *  to the library as `workerUrl` — the same path available to non-bundler hosts: the
 *  library loads it as a CSP-friendly blob worker that `importScripts` this same-origin file. The
 *  template-literal URL is deliberately not a bare string literal, so esbuild leaves it untouched and
 *  it resolves at runtime next to main.js. */
function workerUrlFor(name: RendererKind): string {
    return new URL(`./${name}.worker.js`, import.meta.url).href;
}

interface Active {
    canvas: HTMLCanvasElement;
    engine: GLEngineContext;
    player: LottiePlayer;
    json: LottieFile;
    ip: number;
    op: number;
    fr: number;
    span: number;
    startMs: number;
    ready: boolean;
}

let active: Active | null = null;
let workerPlayer: LottieWorkerPlayer | null = null;
let playing = true;
let scrubbing = false;
let currentFrame = 0;
let loadGen = 0;
let firstLoad = true;

async function fetchManifest(): Promise<string[]> {
    try {
        const m = (await (await fetch("./manifest.json")).json()) as unknown;
        if (Array.isArray(m)) {
            return m as string[];
        }
    } catch {
        // No manifest (e.g. opened without the server); fall back to the always-available synthetic tests.
    }
    return ["_stroketest", "_masktest"];
}

async function loadJson(name: string): Promise<LottieFile> {
    if (name === "_stroketest") {
        return STROKE_TEST;
    }
    if (name === "_masktest") {
        return MASK_TEST;
    }
    return (await fetch(`./${name}.json`)).json() as Promise<LottieFile>;
}

function teardown(): void {
    if (workerPlayer) {
        disposeWorkerPlayer(workerPlayer);
        workerPlayer = null;
    }
    if (!active) {
        return;
    }
    disposePlayer(active.player);
    disposeGLEngine(active.engine);
    active.canvas.remove();
    active = null;
}

function setPlaying(p: boolean): void {
    playing = p;
    playBtn.textContent = p ? "⏸ Pause" : "▶ Play";
    if (p && active) {
        // Resume so the current frame continues smoothly (rather than jumping by paused time).
        const offset = (currentFrame - active.ip) / active.fr;
        active.startMs = performance.now() - offset * 1000;
    }
}

async function loadAnim(name: string, preserveFrame = false): Promise<void> {
    const gen = ++loadGen;
    const keepFrame = currentFrame;
    const json = await loadJson(name);
    if (gen !== loadGen) {
        return; // a newer switch superseded this load
    }
    if (thread === "worker") {
        loadWorkerAnim(name, json);
        return;
    }
    teardown();
    const canvas = document.createElement("canvas");
    canvas.width = json.w;
    canvas.height = json.h;
    checker.appendChild(canvas);
    const engine = createVectorEngine(canvas);
    const player = RENDERERS[renderer].create(engine, json);
    const ip = json.ip ?? 0;
    const op = json.op ?? 60;
    const fr = json.fr ?? 30;
    active = { canvas, engine, player, json, ip, op, fr, span: Math.max(1, op - ip), startMs: performance.now(), ready: false };
    scrub.max = String(active.span);
    // Keep the current frame across a renderer switch (A/B at the same moment); otherwise start at ip.
    currentFrame = preserveFrame ? Math.min(Math.max(keepFrame, ip), op) : ip;
    if (preserveFrame) {
        const offset = (currentFrame - ip) / fr;
        active.startMs = performance.now() - offset * 1000;
    }

    // First load only: honor ?frame=N / ?t=0..1 (used by the screenshot tool) — start paused there.
    if (firstLoad) {
        firstLoad = false;
        const fixed = qs.has("frame") ? Number(qs.get("frame")) : qs.has("t") ? ip + Number(qs.get("t")) * active.span : null;
        if (fixed !== null) {
            currentFrame = fixed;
            setPlaying(false);
        }
    }
}

/** Worker (off-thread) playback: the library's worker player creates its own canvas in the
 *  container and self-drives the render loop on an OffscreenCanvas. Real anims are handed to the
 *  worker as a URL (exercising the worker's own fetch + parse); the synthetic tests are passed as
 *  raw JSON. The scrubber/play controls don't apply here — the worker owns the clock. */
function loadWorkerAnim(name: string, json: LottieFile): void {
    teardown();
    firstLoad = false;
    const synthetic = name === "_stroketest" || name === "_masktest";
    // The standalone factory is variant-agnostic; the selected worker URL determines the renderer.
    const player = createLottieWorkerPlayer({ workerUrl: workerUrlFor(renderer) });
    workerPlayer = player;
    const input: LottieWorkerInput = {
        container: checker,
        animationSource: synthetic ? json : `./${name}.json`,
        loop: true,
        onFirstRender: () => {
            // Mark the worker's canvas ready so the screenshot harness can capture it.
            const c = checker.querySelector("canvas");
            if (c) {
                c.dataset.ready = "true";
            }
        },
    };
    info.textContent = `${RENDERERS[renderer].label} · worker · ${json.w}×${json.h} @ ${json.fr ?? 30}fps`;
    void playWorkerAnimationAsync(player, input);
}

function loop(): void {
    if (active) {
        if (playing && !scrubbing) {
            const elapsed = (performance.now() - active.startMs) / 1000;
            currentFrame = active.ip + ((elapsed * active.fr) % active.span);
        }
        renderLottieFrame(active.player, currentFrame);
        if (!active.ready && isPlayerReady(active.player)) {
            active.ready = true;
            active.canvas.dataset.ready = "true";
        }
        if (!scrubbing) {
            scrub.value = String(Math.round(currentFrame - active.ip));
        }
        info.textContent = `${RENDERERS[renderer].label} · ${active.json.w}×${active.json.h} @ ${active.fr}fps — frame ${Math.round(currentFrame)} / ${active.op}`;
    }
    requestAnimationFrame(loop);
}

playBtn.addEventListener("click", () => setPlaying(!playing));
scrub.addEventListener("input", () => {
    scrubbing = true;
    setPlaying(false);
    if (active) {
        currentFrame = active.ip + Number(scrub.value);
    }
});
scrub.addEventListener("change", () => {
    scrubbing = false;
});
selectEl.addEventListener("change", () => {
    setPlaying(true);
    void loadAnim(selectEl.value);
});
rendererEl.addEventListener("change", () => {
    renderer = rendererEl.value === "shapes" ? "shapes" : "full";
    // Rebuild the current animation with the selected player factory, holding the current frame so
    // you can A/B the two renderers at the exact same moment.
    void loadAnim(selectEl.value, true);
});
threadEl.addEventListener("change", () => {
    thread = threadEl.value === "worker" ? "worker" : "main";
    setPlaying(true);
    void loadAnim(selectEl.value);
});

async function init(): Promise<void> {
    const manifest = await fetchManifest();
    for (const n of manifest) {
        const opt = document.createElement("option");
        opt.value = n;
        opt.textContent = n === "_stroketest" ? "▣ stroke test (synthetic)" : n === "_masktest" ? "▣ mask test (synthetic)" : n;
        selectEl.appendChild(opt);
    }
    const initial = qs.get("anim") ?? manifest[0] ?? "_stroketest";
    selectEl.value = initial;
    rendererEl.value = renderer;
    threadEl.value = thread;
    await loadAnim(initial);
    requestAnimationFrame(loop);
}

void init();
