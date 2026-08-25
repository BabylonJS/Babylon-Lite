// Interactive SMAA workbench: drop in an image, tune every filter parameter, and inspect the result
// (or either intermediate stage) against the original.
//
// The glsl-smaa reference is third-party and gitignored; see smaa-pipelines.ts for how to vendor it.
// Without it the page still works, with the reference option disabled.

import {
    compareStage,
    decodeImage,
    DEFAULT_OPTIONS,
    referenceAvailable,
    runLite,
    runReference,
    syntheticImages,
    toCanvas,
    type ImageInput,
    type SmaaOptions,
    type StageImages,
} from "./smaa-pipelines.js";

type Stage = keyof StageImages;
type Impl = "lite" | "ref";
type ViewMode = "result" | "original" | "split" | "diff";

interface Settings extends SmaaOptions {
    impl: Impl;
    stage: Stage;
    view: ViewMode;
    amplify: number;
}

const DEFAULT_SETTINGS: Settings = { ...DEFAULT_OPTIONS, impl: "lite", stage: "final", view: "result", amplify: 8 };
const STORAGE_KEY = "smaa-lab.settings";
/** WebGPU guarantees only 8192 in each dimension; a bigger drop would fail deep inside the pipeline. */
const MAX_DIM = 8192;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
    file: $<HTMLInputElement>("file"),
    pick: $<HTMLButtonElement>("pick"),
    download: $<HTMLButtonElement>("download"),
    sample: $<HTMLSelectElement>("sample"),
    impl: $<HTMLSelectElement>("impl"),
    implNote: $<HTMLParagraphElement>("implNote"),
    liteSection: $<HTMLElement>("liteSection"),
    refSection: $<HTMLElement>("refSection"),
    liteNote: $<HTMLParagraphElement>("liteNote"),
    refNote: $<HTMLParagraphElement>("refNote"),
    refFull: $<HTMLButtonElement>("refFull"),
    stage: $<HTMLSelectElement>("stage"),
    view: $<HTMLSelectElement>("view"),
    reset: $<HTMLButtonElement>("reset"),
    fit: $<HTMLButtonElement>("fit"),
    actual: $<HTMLButtonElement>("actual"),
    zoom: $<HTMLInputElement>("zoom"),
    zoomOut: $<HTMLOutputElement>("zoomOut"),
    amplify: $<HTMLInputElement>("amplify"),
    amplifyOut: $<HTMLOutputElement>("amplifyOut"),
    amplifyCtl: $<HTMLDivElement>("amplifyCtl"),
    minDiagonalRunCtl: $<HTMLDivElement>("minDiagonalRunCtl"),
    viewport: $<HTMLDivElement>("viewport"),
    canvas: $<HTMLCanvasElement>("viewCanvas"),
    drop: $<HTMLDivElement>("drop"),
    info: $<HTMLSpanElement>("info"),
    metrics: $<HTMLSpanElement>("metrics"),
    busy: $<HTMLSpanElement>("busy"),
    gpuCanvas: $<HTMLCanvasElement>("gpuCanvas"),
    glCanvas: $<HTMLCanvasElement>("glCanvas"),
};

/** Range inputs whose value maps straight onto a setting, with the readout format for each. */
const RANGES = {
    threshold: { out: $<HTMLOutputElement>("thresholdOut"), fmt: (v: number) => v.toFixed(3) },
    maxSearchSteps: { out: $<HTMLOutputElement>("maxSearchStepsOut"), fmt: (v: number) => String(v) },
    minDiagonalRun: { out: $<HTMLOutputElement>("minDiagonalRunOut"), fmt: (v: number) => `${v} px` },
} as const;
const LITE_CHECKS = ["diagonalDetection", "dominantAxisBlend", "sourceIsSrgb"] as const;
const REF_CHECKS = ["refDiagonalDetection", "refCornerDetection"] as const;
const CHECKS = [...LITE_CHECKS, ...REF_CHECKS] as const;

// ── State ──────────────────────────────────────────────────────────────────────────────────────
let settings: Settings = { ...DEFAULT_SETTINGS };
let source: ImageInput | null = null;
let sourceCanvas: HTMLCanvasElement | null = null;
let resultBytes: Uint8Array | null = null;
let resultCanvas: HTMLCanvasElement | null = null;
let diffCanvas: HTMLCanvasElement | null = null;
let refOk = false;

const camera = { zoom: 1, panX: 0, panY: 0, split: 0.5 };
let showOriginal = false; // Space held

// ── Settings persistence ───────────────────────────────────────────────────────────────────────
function loadSettings(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
        settings = { ...DEFAULT_SETTINGS };
    }
}

function saveSettings(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        /* private mode — the app works fine without persistence */
    }
}

// ── Control ⇄ state sync ───────────────────────────────────────────────────────────────────────
function settingsToControls(): void {
    for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
        $<HTMLInputElement>(key).value = String(settings[key]);
    }
    for (const key of CHECKS) $<HTMLInputElement>(key).checked = settings[key];
    els.impl.value = settings.impl;
    els.stage.value = settings.stage;
    els.view.value = settings.view;
    els.amplify.value = String(settings.amplify);
    refreshDerivedUi();
}

function controlsToSettings(): void {
    settings.threshold = Number($<HTMLInputElement>("threshold").value);
    settings.maxSearchSteps = Number($<HTMLInputElement>("maxSearchSteps").value);
    settings.minDiagonalRun = Number($<HTMLInputElement>("minDiagonalRun").value);
    for (const key of CHECKS) settings[key] = $<HTMLInputElement>(key).checked;
    settings.impl = els.impl.value as Impl;
    settings.stage = els.stage.value as Stage;
    settings.view = els.view.value as ViewMode;
    settings.amplify = Number(els.amplify.value);
    refreshDerivedUi();
    saveSettings();
}

/** Readouts, and greying out controls that cannot affect the current pipeline. */
function refreshDerivedUi(): void {
    for (const [key, spec] of Object.entries(RANGES) as [keyof typeof RANGES, (typeof RANGES)[keyof typeof RANGES]][]) {
        spec.out.textContent = spec.fmt(settings[key]);
    }
    els.amplifyOut.textContent = `×${settings.amplify}`;
    els.zoomOut.textContent = camera.zoom >= 1 ? `${camera.zoom.toFixed(camera.zoom < 10 ? 1 : 0)}×` : `1/${(1 / camera.zoom).toFixed(1)}×`;
    els.zoom.value = String(zoomToSlider(camera.zoom));

    const isRef = settings.impl === "ref";

    // Each section is inert for the implementation it does not belong to. Only one pipeline runs at a
    // time, so greying the other side keeps it obvious which controls are actually in play.
    els.liteSection.classList.toggle("off", isRef);
    els.refSection.classList.toggle("off", !isRef);
    for (const key of LITE_CHECKS) $<HTMLInputElement>(key).disabled = isRef;
    for (const key of REF_CHECKS) $<HTMLInputElement>(key).disabled = !isRef;
    els.refFull.disabled = !isRef;
    const runDisabled = isRef || !settings.diagonalDetection;
    els.minDiagonalRunCtl.classList.toggle("off", runDisabled);
    $<HTMLInputElement>("minDiagonalRun").disabled = runDisabled;

    els.implNote.hidden = true;
    els.liteNote.hidden = !isRef;
    if (isRef) {
        // Say what the reference DOES about these, not merely that Lite's switches are inert —
        // "ignored" would wrongly suggest the reference is agnostic about them.
        els.liteNote.textContent = "Not used by the reference: it always blends on the dominant axis, and has no sRGB or min-run equivalent.";
    }

    const full = settings.refDiagonalDetection && settings.refCornerDetection;
    els.refNote.hidden = false;
    els.refNote.textContent = !isRef
        ? "Babylon-Lite implements neither of these; select the reference to use them."
        : full
          ? "Running full canonical SMAA — every feature enabled."
          : "Defaults match the subset Lite implements. Enable both for a fully featured SMAA.";
    els.refNote.classList.toggle("warn", isRef && !full);

    els.amplifyCtl.style.display = settings.view === "diff" ? "" : "none";
    els.canvas.classList.toggle("splitting", settings.view === "split");
}

// ── Zoom helpers ───────────────────────────────────────────────────────────────────────────────
const MIN_ZOOM = 2 ** -3;
const MAX_ZOOM = 2 ** 5;
const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const zoomToSlider = (z: number): number => Math.round(Math.log2(z) * 100);
const sliderToZoom = (v: number): number => clampZoom(2 ** (v / 100));

function fitToViewport(): void {
    if (!source) return;
    const vw = els.viewport.clientWidth;
    const vh = els.viewport.clientHeight;
    camera.zoom = clampZoom(Math.min(vw / source.width, vh / source.height));
    centre();
}

function centre(): void {
    if (!source) return;
    camera.panX = (els.viewport.clientWidth - source.width * camera.zoom) / 2;
    camera.panY = (els.viewport.clientHeight - source.height * camera.zoom) / 2;
    refreshDerivedUi();
    draw();
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────────
let checker: CanvasPattern | null = null;

/** Checkerboard behind the image: without it a transparent image (or the alpha-cutout pattern) is
 *  indistinguishable from the empty viewport, and the image bounds are invisible against black. */
function checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern {
    if (checker) return checker;
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const g = c.getContext("2d")!;
    g.fillStyle = "#191d23";
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = "#22272f";
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(c, "repeat")!;
    return checker;
}

function resizeView(): void {
    const dpr = window.devicePixelRatio || 1;
    els.canvas.width = Math.max(1, Math.round(els.viewport.clientWidth * dpr));
    els.canvas.height = Math.max(1, Math.round(els.viewport.clientHeight * dpr));
    draw();
}

function draw(): void {
    const ctx = els.canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    if (!source || !sourceCanvas) return;

    const vw = els.canvas.width / dpr;
    const vh = els.canvas.height / dpr;

    // Backdrop in screen space, so the checker stays a constant on-screen size instead of zooming.
    const iw = source.width * camera.zoom;
    const ih = source.height * camera.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = checkerPattern(ctx);
    ctx.fillRect(camera.panX, camera.panY, iw, ih);
    ctx.strokeStyle = "#3a424e";
    ctx.lineWidth = 1;
    ctx.strokeRect(camera.panX - 0.5, camera.panY - 0.5, iw + 1, ih + 1);

    const paint = (img: HTMLCanvasElement): void => {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Crisp pixels when magnifying (the whole point of inspecting an AA filter); filtered when
        // minifying, where nearest-neighbour would invent its own aliasing on top of the image's.
        ctx.imageSmoothingEnabled = camera.zoom < 1;
        ctx.translate(camera.panX, camera.panY);
        ctx.scale(camera.zoom, camera.zoom);
        ctx.drawImage(img, 0, 0);
    };

    const output = resultCanvas ?? sourceCanvas;
    if (showOriginal || settings.view === "original" || !resultCanvas) {
        paint(sourceCanvas);
    } else if (settings.view === "diff") {
        paint(diffCanvas ?? output);
    } else if (settings.view === "split") {
        const splitX = camera.split * vw;
        paint(sourceCanvas);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.save();
        // Clipping is baked in device space at clip() time, so re-setting the transform inside
        // paint() cannot drag the divider along with the image.
        ctx.beginPath();
        ctx.rect(splitX, 0, vw - splitX, vh);
        ctx.clip();
        paint(output);
        ctx.restore();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = "#5aa9ff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(splitX + 0.5, 0);
        ctx.lineTo(splitX + 0.5, vh);
        ctx.stroke();
    } else {
        paint(output);
    }
}

function buildDiff(): void {
    diffCanvas = null;
    if (!source || !resultBytes || settings.view !== "diff") return;
    const { width: w, height: h, data: a } = source;
    const out = new Uint8Array(w * h * 4);
    const gain = settings.amplify;
    for (let i = 0; i < out.length; i += 4) {
        for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.abs(a[i + c]! - resultBytes[i + c]!) * gain);
        out[i + 3] = 255;
    }
    diffCanvas = toCanvas(out, w, h);
}

// ── Running the filter ─────────────────────────────────────────────────────────────────────────
let running = false;
let dirty = false;
let debounce = 0;

/** Busy covers the debounce wait too, so the status line never reads idle with work outstanding. */
function updateBusy(): void {
    els.busy.classList.toggle("idle", !running && debounce === 0);
}

function scheduleRun(): void {
    window.clearTimeout(debounce);
    // Sliders fire continuously; a short settle keeps a drag from queueing a run per pixel.
    debounce = window.setTimeout(() => {
        debounce = 0;
        void run();
    }, 100);
    updateBusy();
}

async function run(): Promise<void> {
    if (!source) {
        updateBusy();
        return;
    }
    if (running) {
        dirty = true; // settings moved mid-run; loop again with whatever is current when we get back
        return;
    }
    running = true;
    updateBusy();
    try {
        do {
            dirty = false;
            await runOnce();
        } while (dirty);
    } finally {
        running = false;
        updateBusy();
    }
}

async function runOnce(): Promise<void> {
    const img = source;
    if (!img) return;
    const opts: SmaaOptions = {
        threshold: settings.threshold,
        maxSearchSteps: settings.maxSearchSteps,
        diagonalDetection: settings.diagonalDetection,
        minDiagonalRun: settings.minDiagonalRun,
        dominantAxisBlend: settings.dominantAxisBlend,
        sourceIsSrgb: settings.sourceIsSrgb,
        refDiagonalDetection: settings.refDiagonalDetection,
        refCornerDetection: settings.refCornerDetection,
    };
    const stage = settings.stage;
    const impl = settings.impl;

    const t0 = performance.now();
    let stages: StageImages;
    try {
        const out = impl === "ref" ? await runReference(els.glCanvas, [img], opts) : await runLite(els.gpuCanvas, [img], opts);
        stages = out.get(img.name)!;
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
    }
    const ms = performance.now() - t0;

    resultBytes = stages[stage];
    resultCanvas = toCanvas(resultBytes, img.width, img.height);
    buildDiff();
    els.download.disabled = false;
    els.metrics.textContent = `${describe(stage, img, resultBytes)} · ${ms.toFixed(0)} ms`;
    els.metrics.classList.remove("err");
    draw();
}

/** A stage-appropriate one-line summary: agreement stats for the final image, coverage otherwise. */
function describe(stage: Stage, img: ImageInput, bytes: Uint8Array): string {
    if (stage === "final") {
        const { mad, psnr } = compareStage(img.data, bytes, [0, 1, 2]);
        let changed = 0;
        for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i] !== img.data[i] || bytes[i + 1] !== img.data[i + 1] || bytes[i + 2] !== img.data[i + 2]) changed++;
        }
        const pct = (changed / (img.width * img.height)) * 100;
        return `${pct.toFixed(2)}% of pixels changed · MAD ${mad.toFixed(2)} · PSNR ${psnr === Infinity ? "∞" : psnr.toFixed(1)} dB`;
    }
    // Edges pack their two booleans into R/G; weights use all four channels.
    const channels = stage === "edges" ? 2 : 4;
    let hit = 0;
    for (let i = 0; i < bytes.length; i += 4) {
        for (let c = 0; c < channels; c++) {
            if (bytes[i + c]! > 0) {
                hit++;
                break;
            }
        }
    }
    const label = stage === "edges" ? "pixels with an edge" : "pixels with a blend weight";
    return `${((hit / (img.width * img.height)) * 100).toFixed(2)}% ${label}`;
}

function setError(message: string): void {
    els.metrics.textContent = message;
    els.metrics.classList.add("err");
}

// ── Loading images ─────────────────────────────────────────────────────────────────────────────
function setSource(img: ImageInput, label: string): void {
    source = img;
    sourceCanvas = toCanvas(img.data, img.width, img.height);
    resultBytes = null;
    resultCanvas = null;
    diffCanvas = null;
    els.download.disabled = true;
    els.drop.classList.add("hidden");
    els.info.innerHTML = `<b>${escapeHtml(label)}</b> ${img.width}×${img.height}`;
    els.metrics.textContent = "";
    els.metrics.classList.remove("err");
    fitToViewport();
    void run();
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function loadFile(file: File): Promise<void> {
    if (!file.type.startsWith("image/")) {
        setError(`${file.name} is not an image`);
        return;
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await decodeImage(url, "input");
        if (img.width > MAX_DIM || img.height > MAX_DIM) {
            setError(`${img.width}×${img.height} exceeds the ${MAX_DIM}px limit`);
            return;
        }
        els.sample.value = "";
        setSource(img, file.name);
    } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ── Wiring ─────────────────────────────────────────────────────────────────────────────────────
function wireControls(): void {
    const onChange = (): void => {
        controlsToSettings();
        buildDiff();
        draw();
        scheduleRun();
    };
    for (const key of Object.keys(RANGES)) $<HTMLInputElement>(key).addEventListener("input", onChange);
    for (const key of CHECKS) $<HTMLInputElement>(key).addEventListener("change", onChange);
    els.impl.addEventListener("change", onChange);
    els.stage.addEventListener("change", onChange);

    // View-only controls: no need to re-run the filter, just repaint.
    const onView = (): void => {
        controlsToSettings();
        buildDiff();
        draw();
    };
    els.view.addEventListener("change", onView);
    els.amplify.addEventListener("input", onView);

    els.zoom.addEventListener("input", () => {
        zoomAbout(sliderToZoom(Number(els.zoom.value)), els.viewport.clientWidth / 2, els.viewport.clientHeight / 2);
    });
    els.fit.addEventListener("click", () => fitToViewport());
    els.actual.addEventListener("click", () => zoomAbout(1, els.viewport.clientWidth / 2, els.viewport.clientHeight / 2));

    els.reset.addEventListener("click", () => {
        settings = { ...DEFAULT_SETTINGS, impl: settings.impl, stage: settings.stage, view: settings.view };
        settingsToControls();
        saveSettings();
        scheduleRun();
    });

    els.refFull.addEventListener("click", () => {
        settings.refDiagonalDetection = true;
        settings.refCornerDetection = true;
        settingsToControls();
        saveSettings();
        scheduleRun();
    });
    els.pick.addEventListener("click", () => els.file.click());
    els.file.addEventListener("change", () => {
        const f = els.file.files?.[0];
        if (f) void loadFile(f);
        els.file.value = "";
    });
    els.download.addEventListener("click", download);

    els.sample.addEventListener("change", () => {
        const name = els.sample.value;
        if (!name) return;
        const found = syntheticImages().find((s) => s.name === name);
        if (found) setSource(found, `pattern: ${name}`);
    });
}

function zoomAbout(nextZoom: number, screenX: number, screenY: number): void {
    const z = clampZoom(nextZoom);
    const ix = (screenX - camera.panX) / camera.zoom;
    const iy = (screenY - camera.panY) / camera.zoom;
    camera.zoom = z;
    camera.panX = screenX - ix * z;
    camera.panY = screenY - iy * z;
    refreshDerivedUi();
    draw();
}

function wireViewport(): void {
    els.canvas.addEventListener(
        "wheel",
        (e) => {
            if (!source) return;
            e.preventDefault();
            const r = els.canvas.getBoundingClientRect();
            zoomAbout(camera.zoom * 2 ** (-e.deltaY / 400), e.clientX - r.left, e.clientY - r.top);
        },
        { passive: false }
    );

    let mode: "none" | "pan" | "split" = "none";
    let lastX = 0;
    let lastY = 0;
    const splitScreenX = (): number => camera.split * els.canvas.getBoundingClientRect().width;

    els.canvas.addEventListener("pointerdown", (e) => {
        if (!source) return;
        const r = els.canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        mode = settings.view === "split" && Math.abs(x - splitScreenX()) < 12 ? "split" : "pan";
        lastX = e.clientX;
        lastY = e.clientY;
        els.canvas.setPointerCapture(e.pointerId);
        els.canvas.classList.toggle("panning", mode === "pan");
        if (mode === "split") setSplit(x / r.width);
    });
    els.canvas.addEventListener("pointermove", (e) => {
        const r = els.canvas.getBoundingClientRect();
        if (mode === "none") {
            els.canvas.classList.toggle("splitting", settings.view === "split" && Math.abs(e.clientX - r.left - splitScreenX()) < 12);
            return;
        }
        if (mode === "split") {
            setSplit((e.clientX - r.left) / r.width);
        } else {
            camera.panX += e.clientX - lastX;
            camera.panY += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            draw();
        }
    });
    const end = (e: PointerEvent): void => {
        mode = "none";
        els.canvas.classList.remove("panning");
        if (els.canvas.hasPointerCapture(e.pointerId)) els.canvas.releasePointerCapture(e.pointerId);
    };
    els.canvas.addEventListener("pointerup", end);
    els.canvas.addEventListener("pointercancel", end);
    els.canvas.addEventListener("dblclick", () => fitToViewport());

    new ResizeObserver(() => resizeView()).observe(els.viewport);
}

function setSplit(fraction: number): void {
    camera.split = Math.min(1, Math.max(0, fraction));
    draw();
}

function wireInput(): void {
    let depth = 0; // dragenter/dragleave fire per child, so count instead of toggling
    window.addEventListener("dragenter", (e) => {
        e.preventDefault();
        depth++;
        document.body.classList.add("dragging");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
        e.preventDefault();
        if (--depth <= 0) {
            depth = 0;
            document.body.classList.remove("dragging");
        }
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        depth = 0;
        document.body.classList.remove("dragging");
        const f = e.dataTransfer?.files?.[0];
        if (f) void loadFile(f);
    });

    window.addEventListener("paste", (e) => {
        const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
        const f = item?.getAsFile();
        if (f) void loadFile(f);
    });

    window.addEventListener("keydown", (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (e.code === "Space" && !showOriginal) {
            e.preventDefault();
            showOriginal = true;
            draw();
        } else if (e.key === "0") {
            fitToViewport();
        } else if (e.key === "1") {
            zoomAbout(1, els.viewport.clientWidth / 2, els.viewport.clientHeight / 2);
        }
    });
    window.addEventListener("keyup", (e) => {
        if (e.code === "Space") {
            showOriginal = false;
            draw();
        }
    });
}

function download(): void {
    if (!resultCanvas || !source) return;
    const a = document.createElement("a");
    a.download = `smaa-${settings.impl}-${settings.stage}-t${settings.threshold}.png`;
    a.href = resultCanvas.toDataURL("image/png");
    a.click();
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
    els.sample.append(new Option("— none —", ""));
    for (const s of syntheticImages()) els.sample.append(new Option(s.name, s.name));

    loadSettings();
    settingsToControls();
    wireControls();
    wireViewport();
    wireInput();
    resizeView();

    if (!navigator.gpu) {
        (els.impl.querySelector('option[value="lite"]') as HTMLOptionElement).disabled = true;
        setError("WebGPU unavailable — Babylon-Lite's SMAA cannot run in this browser.");
    }
    refOk = await referenceAvailable();
    if (!refOk) {
        const opt = els.impl.querySelector('option[value="ref"]') as HTMLOptionElement;
        opt.disabled = true;
        opt.textContent = "glsl-smaa reference (not installed)";
        if (settings.impl === "ref") {
            settings.impl = "lite";
            settingsToControls();
        }
    }
}

void boot();
