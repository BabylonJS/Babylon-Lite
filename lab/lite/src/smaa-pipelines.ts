// The two SMAA pipelines used by the interactive comparison lab.
//
//   runLite      — Babylon-Lite's createSmaaPostProcessTask, on WebGPU
//   runReference — the third-party glsl-smaa reference (MIT), on WebGL2
//
// The reference is third-party and gitignored. To set it up:
//   mkdir -p scripts/smaa-ref && cd scripts/smaa-ref
//   npm pack glsl-smaa@3.0.0 && tar -xzf glsl-smaa-3.0.0.tgz
//   copy package/smaa-*.frag package/smaa-*.vert package/LICENSE.md -> lab/public/smaa-ref/
//   npx tsx scripts/smaa-oracle-luts.ts
//
// Both take raw RGBA8 bytes and return raw RGBA8 bytes for all three stages, at the image's native
// size with no resampling, so the caller can compare like for like.
//
// Both are also safe to call repeatedly: the expensive per-canvas state (WebGPU device, compiled GL
// programs, the reference LUTs) is cached, and every per-run allocation is released before
// returning. smaa-lab.ts re-runs the whole filter on each slider move, so a leak of one full-size
// texture per call would exhaust GPU memory within a single drag.

import { addTask, createEngine, createRenderTarget, createSceneContext, createSmaaPostProcessTask, disposeScene, registerScene } from "babylon-lite";

/**
 * Everything both pipelines can be told.
 *
 * Only `threshold` and `maxSearchSteps` are shared. The rest are per-implementation, because the two
 * filters do not have the same feature set: blending the two sides' flags into one control would
 * make "our shipping config vs fully-featured canonical SMAA" impossible to express, and would
 * silently conflate two different causes in a single comparison number.
 */
export interface SmaaOptions {
    // ── Shared ──
    threshold: number;
    maxSearchSteps: number;
    // ── Babylon-Lite only ──
    diagonalDetection: boolean;
    minDiagonalRun: number;
    dominantAxisBlend: boolean;
    sourceIsSrgb: boolean;
    // ── Reference only ──
    /** The reference's own 45-degree path (AreaTex-based), independent of Lite's analytic one. */
    refDiagonalDetection: boolean;
    /** SMAA's corner rounding. Lite implements none, so there is deliberately no Lite counterpart. */
    refCornerDetection: boolean;
}

/** Defaults keep the two pipelines like for like, so a plain comparison isolates the parts both
 *  implement. Enable both `ref*` flags for canonical SMAA with every feature running. */
export const DEFAULT_OPTIONS: SmaaOptions = {
    threshold: 0.05,
    maxSearchSteps: 16,
    diagonalDetection: false,
    minDiagonalRun: 4,
    dominantAxisBlend: true,
    sourceIsSrgb: false,
    refDiagonalDetection: false,
    refCornerDetection: false,
};

/** RGBA8 bytes for each stage of the filter. */
export interface StageImages {
    edges: Uint8Array;
    weights: Uint8Array;
    final: Uint8Array;
}

export interface ImageInput {
    name: string;
    width: number;
    height: number;
    data: Uint8Array;
}

function loadImg(src: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("could not decode image — is it a format the browser supports?"));
        i.src = src;
    });
}

/**
 * Decode any browser-supported image URL (data: or http:) into raw RGBA8 at its native size.
 * Smoothing is off and the canvas matches the image exactly, so no resampling can occur — an AA
 * filter compared against a resampled input would be measuring the browser, not the filter.
 */
export async function decodeImage(src: string, name = "input"): Promise<ImageInput> {
    const img = await loadImg(src);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    return { name, width: c.width, height: c.height, data: new Uint8Array(d.data.buffer.slice(0)) };
}

/** Wrap raw RGBA8 back into a canvas, ready to draw or export. */
export function toCanvas(data: Uint8Array, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const id = g.createImageData(w, h);
    id.data.set(data);
    g.putImageData(id, 0, 0);
    return c;
}

const REF = "/smaa-ref";

// ── Reference (WebGL2) ─────────────────────────────────────────────────────────────────────────
async function loadText(url: string): Promise<string> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
    return r.text();
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${label}: ${gl.getShaderInfoLog(s)}`);
    return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string, label: string): WebGLProgram {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, `${label}.vert`));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, `${label}.frag`));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${label} link: ${gl.getProgramInfoLog(p)}`);
    return p;
}

function texFromBytes(gl: WebGL2RenderingContext, data: Uint8Array | null, w: number, h: number, nearest = false): WebGLTexture {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

function texFromImage(gl: WebGL2RenderingContext, img: HTMLImageElement, nearest = false): WebGLTexture {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
}

/**
 * Per-canvas reference state that survives across runs: the GL context, the shader sources, the two
 * LUTs and the fullscreen-triangle buffers. Only the linked programs depend on the settings.
 */
interface RefCache {
    gl: WebGL2RenderingContext;
    sources: readonly string[];
    areaTex: WebGLTexture;
    searchTex: WebGLTexture;
    vao: WebGLVertexArrayObject;
    programs: Map<string, RefPrograms>;
}

interface RefPrograms {
    edges: WebGLProgram;
    weights: WebGLProgram;
    blend: WebGLProgram;
}

const refCaches = new WeakMap<HTMLCanvasElement, Promise<RefCache>>();

function refCacheFor(canvas: HTMLCanvasElement): Promise<RefCache> {
    const existing = refCaches.get(canvas);
    if (existing) return existing;
    const pending = (async (): Promise<RefCache> => {
        const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
        if (!gl) throw new Error("WebGL2 unavailable");
        // Dithering is on by default in GL and would add implementation-dependent noise to the bytes
        // we read back, which is fatal for a comparison that expects bit-exact edge stages.
        gl.disable(gl.DITHER);
        const sources = await Promise.all([
            loadText(`${REF}/smaa-edges.vert`),
            loadText(`${REF}/smaa-edges.frag`),
            loadText(`${REF}/smaa-weights.vert`),
            loadText(`${REF}/smaa-weights.frag`),
            loadText(`${REF}/smaa-blend.vert`),
            loadText(`${REF}/smaa-blend.frag`),
        ]);
        const mod = (await import(/* @vite-ignore */ `${REF}/textures.js`)) as { SMAATextures: { area: string; search: string } };
        const [areaImg, searchImg] = await Promise.all([loadImg(mod.SMAATextures.area), loadImg(mod.SMAATextures.search)]);
        // The two LUTs are NOT uploaded the same way, and getting this wrong is silent: edges stay
        // bit-exact (they use no LUT) while every blend weight is subtly wrong.
        //   AreaTex   — linear, NOT flipped.
        //   SearchTex — nearest, flipped in Y. SMAASearchLength's own comment says "the texture is
        //               flipped vertically" and compensates with a negative Y scale, so the upload
        //               has to supply it flipped for that to cancel.
        // Both settings are taken from glsl-smaa's own example (examples/index.js).
        const areaTex = texFromImage(gl, areaImg);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        const searchTex = texFromImage(gl, searchImg, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        return { gl, sources, areaTex, searchTex, vao, programs: new Map() };
    })();
    refCaches.set(canvas, pending);
    // The reference is third-party and gitignored, so it may simply not be installed. A failure must
    // not poison the cache, or the page could never retry after the user sets it up.
    pending.catch(() => refCaches.delete(canvas));
    return pending;
}

/** Cheap probe for whether the gitignored reference has been vendored into lab/public/smaa-ref. */
export async function referenceAvailable(): Promise<boolean> {
    try {
        const r = await fetch(`${REF}/smaa-edges.frag`);
        // A dev server that falls back to index.html for unknown paths still answers 200, so check
        // that what came back is actually the shader.
        return r.ok && (await r.text()).includes("SMAA");
    } catch {
        return false;
    }
}

/**
 * Run the reference glsl-smaa over each image.
 *
 * It takes only `threshold`, `maxSearchSteps` and the two `ref*` feature flags; the Lite-side
 * options have no counterpart here, for four different reasons:
 *  - dominantAxisBlend: the reference ALWAYS blends on the dominant axis (smaa-blend.frag:
 *    `bool h = max(a.x, a.z) > max(a.y, a.w)`), which is the same rule Lite applies when the flag is
 *    on. Leave Lite's on to compare like for like; turning it off diverges on purpose.
 *  - sourceIsSrgb: the reference takes luma straight off the sampled RGB, i.e. it assumes the caller
 *    hands it gamma-space bytes through a non-decoding sampler, which is exactly what this harness
 *    does. Lite's flag exists for the case the reference cannot be in — an sRGB texture *view* that
 *    decodes on sample — and re-encodes to recover the same gamma-space luma.
 *  - minDiagonalRun: the reference reads real diagonal coverage from AreaTex, so it needs no
 *    minimum-run threshold. Its diagonal knob is SMAA_MAX_SEARCH_STEPS_DIAG (a maximum distance,
 *    default 8), a different quantity.
 *  - diagonalDetection: Lite's analytic 45-degree path and the reference's AreaTex one are separate
 *    implementations, so they get separate switches (`refDiagonalDetection`).
 */
export async function runReference(canvas: HTMLCanvasElement, images: readonly ImageInput[], opts: SmaaOptions): Promise<Map<string, StageImages>> {
    const cache = await refCacheFor(canvas);
    const { gl } = cache;

    const defines =
        `#define SMAA_EDGES_LUMA 1\n` +
        `#define SMAA_THRESHOLD ${opts.threshold.toFixed(6)}\n` +
        `#define SMAA_MAX_SEARCH_STEPS ${opts.maxSearchSteps}\n` +
        (opts.refDiagonalDetection ? "" : "#define SMAA_DISABLE_DIAG_DETECTION 1\n") +
        (opts.refCornerDetection ? "" : "#define SMAA_DISABLE_CORNER_DETECTION 1\n");

    let progs = cache.programs.get(defines);
    if (!progs) {
        const inject = (src: string): string => {
            const m = src.match(/^\s*#version[^\n]*\n/);
            return m ? m[0] + defines + src.slice(m[0].length) : defines + src;
        };
        const [ev, ef, wv, wf, bv, bf] = cache.sources as readonly [string, string, string, string, string, string];
        progs = {
            edges: program(gl, inject(ev), inject(ef), "edges"),
            weights: program(gl, inject(wv), inject(wf), "weights"),
            blend: program(gl, inject(bv), inject(bf), "blend"),
        };
        // Every threshold tick recompiles, so a slider drag would otherwise pile up programs.
        while (cache.programs.size >= 8) {
            const oldestKey = cache.programs.keys().next().value as string;
            const oldest = cache.programs.get(oldestKey)!;
            gl.deleteProgram(oldest.edges);
            gl.deleteProgram(oldest.weights);
            gl.deleteProgram(oldest.blend);
            cache.programs.delete(oldestKey);
        }
        cache.programs.set(defines, progs);
    }
    const { edges: pEdges, weights: pWeights, blend: pBlend } = progs;
    gl.bindVertexArray(cache.vao);

    const bindQuad = (p: WebGLProgram): void => {
        const loc = gl.getAttribLocation(p, "aPosition");
        if (loc >= 0) {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        }
    };
    const setSize = (p: WebGLProgram, w: number, h: number): void => {
        const t = gl.getUniformLocation(p, "uTexelSize");
        if (t) gl.uniform2f(t, 1 / w, 1 / h);
        const v = gl.getUniformLocation(p, "uViewportSize");
        if (v) gl.uniform2f(v, w, h);
    };
    const bindTex = (p: WebGLProgram, name: string, tex: WebGLTexture, unit: number): void => {
        const l = gl.getUniformLocation(p, name);
        if (!l) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(l, unit);
    };

    const results = new Map<string, StageImages>();
    for (const img of images) {
        const { width: w, height: h } = img;
        canvas.width = w;
        canvas.height = h;
        const makeRT = (): { fb: WebGLFramebuffer; tex: WebGLTexture } => {
            const tex = texFromBytes(gl, null, w, h);
            const fb = gl.createFramebuffer()!;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            return { fb, tex };
        };
        const rtEdges = makeRT();
        const rtWeights = makeRT();
        const rtFinal = makeRT();
        // No vertical flip anywhere: texImage2D treats row 0 as the BOTTOM row and readPixels returns
        // bottom-up, so the two conventions cancel and bytes come back in the order they went in.
        const read = (fb: WebGLFramebuffer): Uint8Array => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px;
        };
        const srcTex = texFromBytes(gl, img.data, w, h);
        gl.viewport(0, 0, w, h);

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtEdges.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(pEdges);
        bindQuad(pEdges);
        setSize(pEdges, w, h);
        bindTex(pEdges, "uColorTexture", srcTex, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtWeights.fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(pWeights);
        bindQuad(pWeights);
        setSize(pWeights, w, h);
        bindTex(pWeights, "uEdgesTexture", rtEdges.tex, 0);
        bindTex(pWeights, "uAreaTexture", cache.areaTex, 1);
        bindTex(pWeights, "uSearchTexture", cache.searchTex, 2);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, rtFinal.fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(pBlend);
        bindQuad(pBlend);
        setSize(pBlend, w, h);
        bindTex(pBlend, "uColorTexture", srcTex, 0);
        bindTex(pBlend, "uBlendTexture", rtWeights.tex, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        results.set(img.name, { edges: read(rtEdges.fb), weights: read(rtWeights.fb), final: read(rtFinal.fb) });

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        for (const rt of [rtEdges, rtWeights, rtFinal]) {
            gl.deleteFramebuffer(rt.fb);
            gl.deleteTexture(rt.tex);
        }
        gl.deleteTexture(srcTex);
    }
    return results;
}

// ── Babylon-Lite (WebGPU) ──────────────────────────────────────────────────────────────────────

/**
 * One engine per canvas, kept alive across runs. The interactive lab re-filters on every slider
 * move, and building a fresh engine each time would strand a WebGPU device per drag; the CLI creates
 * one and exits, so it sees no difference. Held as the promise so overlapping callers share it.
 */
type LiteEngine = Awaited<ReturnType<typeof createEngine>>;

const liteEngines = new WeakMap<HTMLCanvasElement, Promise<LiteEngine>>();

function engineFor(canvas: HTMLCanvasElement, width: number, height: number): Promise<LiteEngine> {
    const existing = liteEngines.get(canvas);
    if (existing) return existing;
    canvas.width = width;
    canvas.height = height;
    const pending = createEngine(canvas, { msaaSamples: 1 });
    liteEngines.set(canvas, pending);
    pending.catch(() => liteEngines.delete(canvas));
    return pending;
}

/** Release a render target's texture. `disposeRenderTarget` is not public and refuses to touch eager
 *  targets anyway, and everything here is allocated per run, so free it directly. */
function destroyRT(rt: unknown): void {
    const t = rt as { _colorTexture: GPUTexture | null; _colorView: GPUTextureView | null };
    t._colorTexture?.destroy();
    t._colorTexture = null;
    t._colorView = null;
}

/** Run Babylon-Lite's SMAA task over each image. One engine is built and reused for all of them. */
export async function runLite(canvas: HTMLCanvasElement, images: readonly ImageInput[], opts: SmaaOptions): Promise<Map<string, StageImages>> {
    const first = images[0];
    if (!first) return new Map();
    const engine = await engineFor(canvas, first.width, first.height);
    const device = engine._device;
    const results = new Map<string, StageImages>();

    for (const img of images) {
        const { width: w, height: h } = img;
        // A scene per image, not per call: addTask leaves the task in the scene's frame graph, so a
        // shared scene would re-record the previous image's task on the next build() — against a
        // source render target this loop has already released.
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        // Source RT with a texture we own, so the input can be uploaded straight in: a normal render
        // target is created without COPY_DST.
        const srcRT = createRenderTarget({ lbl: "smaa-src", format: "rgba8unorm", samples: 1, size: { width: w, height: h } });
        const srcTex = device.createTexture({
            label: "smaa-src-tex",
            size: [w, h],
            format: "rgba8unorm",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        });
        const rt = srcRT as unknown as { _colorTexture: GPUTexture; _colorView: GPUTextureView; _width: number; _height: number; _eager: boolean };
        rt._colorTexture = srcTex;
        rt._colorView = srcTex.createView();
        rt._width = w;
        rt._height = h;
        rt._eager = true; // never rebuilt or destroyed by the frame graph

        const dstRT = createRenderTarget({ lbl: "smaa-dst", format: "rgba8unorm", samples: 1, size: { width: w, height: h } });
        const smaa = createSmaaPostProcessTask(
            {
                name: "smaa-lab",
                sourceTexture: srcRT,
                targetTexture: dstRT,
                threshold: opts.threshold,
                maxSearchSteps: opts.maxSearchSteps,
                diagonalDetection: opts.diagonalDetection,
                minDiagonalRun: opts.minDiagonalRun,
                dominantAxisBlend: opts.dominantAxisBlend,
                sourceIsSrgb: opts.sourceIsSrgb,
            },
            engine,
            scene
        );
        try {
            addTask(scene, smaa);
            await registerScene(scene);
            // No getFrameGraph(scene).build() here: build() walks the scene recording every task, and
            // the explicit record() below already sizes the intermediates and binds the passes to the
            // encoder we install. Calling both just records the same task twice.

            const readRT = async (target: { _colorTexture: GPUTexture }): Promise<Uint8Array> => {
                const bpr = Math.ceil((w * 4) / 256) * 256;
                const buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const enc = device.createCommandEncoder();
                enc.copyTextureToBuffer({ texture: target._colorTexture }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
                device.queue.submit([enc.finish()]);
                await buf.mapAsync(GPUMapMode.READ);
                const src = new Uint8Array(buf.getMappedRange());
                const outBytes = new Uint8Array(w * h * 4);
                for (let y = 0; y < h; y++) outBytes.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
                buf.unmap();
                buf.destroy();
                return outBytes;
            };

            device.queue.writeTexture({ texture: srcTex }, img.data, { bytesPerRow: w * 4 }, [w, h]);
            const enc = device.createCommandEncoder({ label: "smaa-frame" });
            (engine as unknown as { _currentEncoder: GPUCommandEncoder })._currentEncoder = enc;
            smaa.record();
            smaa.execute!();
            device.queue.submit([enc.finish()]);
            await device.queue.onSubmittedWorkDone();

            results.set(img.name, {
                edges: await readRT(smaa.edgesTexture as unknown as { _colorTexture: GPUTexture }),
                weights: await readRT(smaa.weightsTexture as unknown as { _colorTexture: GPUTexture }),
                final: await readRT(dstRT as unknown as { _colorTexture: GPUTexture }),
            });
        } finally {
            smaa.dispose(); // frees the task's own edge/weight intermediates
            destroyRT(srcRT);
            destroyRT(dstRT);
            disposeScene(scene);
        }
    }
    return results;
}

// ── Comparison ─────────────────────────────────────────────────────────────────────────────────
export interface CompareResult {
    mad: number;
    psnr: number;
    maxAbs: number;
    pctOver8: number;
    nonzeroA: number;
    nonzeroB: number;
}

/** Per-channel difference stats plus each side's non-zero coverage, so an empty buffer on one side
 *  cannot masquerade as agreement (MAD against all-zeros is invariant to what the other side does). */
export function compareStage(a: Uint8Array, b: Uint8Array, channels: readonly number[]): CompareResult {
    let sum = 0;
    let sq = 0;
    let max = 0;
    let over = 0;
    let n = 0;
    let nzA = 0;
    let nzB = 0;
    for (let i = 0; i < a.length; i += 4) {
        for (const c of channels) {
            const av = a[i + c]!;
            const bv = b[i + c]!;
            const d = Math.abs(av - bv);
            sum += d;
            sq += d * d;
            if (d > max) max = d;
            if (d > 8) over++;
            if (av > 0) nzA++;
            if (bv > 0) nzB++;
            n++;
        }
    }
    const mse = sq / n;
    return {
        mad: sum / n,
        psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
        maxAbs: max,
        pctOver8: (over / n) * 100,
        nonzeroA: (nzA / n) * 100,
        nonzeroB: (nzB / n) * 100,
    };
}

/** Synthetic patterns that exercise each family the filter has to handle. */
export function syntheticImages(size = 256): ImageInput[] {
    const W = size;
    const H = size;
    const mk = (name: string, draw: (px: (x: number, y: number, r: number, g: number, b: number, a?: number) => void) => void): ImageInput => {
        const d = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) d[i * 4 + 3] = 255;
        draw((x, y, r, g, b, a = 255) => {
            if (x < 0 || y < 0 || x >= W || y >= H) return;
            const i = (y * W + x) * 4;
            d[i] = r;
            d[i + 1] = g;
            d[i + 2] = b;
            d[i + 3] = a;
        });
        return { name, width: W, height: H, data: d };
    };
    return [
        mk("thin-lines", (px) => {
            for (let x = 0; x < W; x++) px(x, Math.floor(H / 4), 255, 255, 255);
            for (let y = 0; y < H; y++) px(Math.floor(W * 0.375), y, 255, 255, 255);
            for (let i = 0; i < Math.min(W, H); i++) px(i, i, 255, 255, 255);
        }),
        mk("stair-slopes", (px) => {
            for (let x = 0; x < W; x++) {
                for (let y = 0; y < 40 + Math.floor(x / 4); y++) px(x, y, 220, 220, 220);
                for (let y = 120 + Math.floor(x / 2); y < 170; y++) px(x, y, 200, 60, 60);
                for (let y = 180 + Math.floor(x); y < H; y++) px(x, y, 60, 90, 220);
            }
        }),
        mk("corners-LT", (px) => {
            const rect = (x0: number, y0: number, w: number, h: number): void => {
                for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, 240, 240, 240);
            };
            rect(20, 20, 60, 60);
            rect(120, 20, 100, 20);
            rect(160, 20, 20, 100);
            rect(30, 140, 90, 20);
            rect(30, 140, 20, 80);
        }),
        mk("alpha-cutout", (px) => {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const inside = (x - W / 2) * (x - W / 2) + (y - H / 2) * (y - H / 2) < W * 0.27 * (W * 0.27);
                    px(x, y, 255, 255, 255, inside ? 255 : 0);
                }
            }
        }),
        mk("equal-luma-chroma", (px) => {
            // Rec.709 luma of (255,0,0) is 54.2 and of (0,76,0) is 54.4 — a LUMA detector must find
            // (almost) nothing, so any disagreement here is colour-space handling, not pattern logic.
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const left = x < W / 2;
                    px(x, y, left ? 255 : 0, left ? 0 : 76, 0);
                }
            }
        }),
    ];
}
