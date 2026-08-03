/**
 * HTML textures — a live `HTMLElement` rasterised straight into a GPU texture via
 * Chrome's experimental **HTML-in-Canvas** API (WICG
 * {@link https://github.com/WICG/html-in-canvas | html-in-canvas}). This is the
 * WebGPU-native analog of Babylon.js `HtmlTexture`: unlike a dynamic texture
 * (which uploads an *already-rasterised* canvas/video), an HTML texture asks the
 * browser to lay out and paint an arbitrary styled DOM subtree — a `<div>`, a
 * form, an SVG — directly into the texture.
 *
 * The native path is a single GPU copy with no CPU readback:
 * `device.queue.copyElementImageToTexture({ source: element }, …)`. It requires
 * the source element to be a **direct child of the rendering canvas**, the canvas
 * to have `layoutSubtree = true`, and the copy to run inside a `paint` event — so
 * updates are paint-event-driven, never a `requestAnimationFrame` loop.
 *
 * @example
 * ```ts
 * const panel = document.createElement("div");
 * panel.style.cssText = "width:512px;height:512px;background:#1e293b;color:#fff;font:24px sans-serif;padding:24px";
 * panel.innerHTML = "<h1>Hello DOM</h1><button>Click me</button>";
 *
 * const tex = createHtmlTexture(engine, panel, { autoUpdate: true });
 * const mat = createStandardMaterial(engine, { emissiveTexture: tex, disableLighting: true });
 * // …assign `mat` to a plane; the texture refreshes whenever `panel` changes.
 *
 * // later:
 * disposeHtmlTexture(tex);
 * ```
 *
 * The HTML-in-Canvas API is Chrome-Canary-only (behind
 * `chrome://flags/#canvas-draw-element`). When it is unavailable, an optional
 * SVG `<foreignObject>` fallback rasterises a *static* snapshot instead — enough
 * for text/label panels — unless `useSvgFallback: false` is set.
 *
 * Every export is a free function with zero module-level side effects, so an app
 * that never creates an HTML texture strips the whole feature (and its fallback).
 */

import { createDynamicTexture, updateDynamicTexture, type DynamicTexture2D, type DynamicTexture2DOptions } from "./dynamic-texture.js";
import { isDomCanvas } from "../engine/surface.js";
import { releaseTexture } from "../resource/gpu-pool.js";
import { generateMipmaps } from "./generate-mipmaps.js";
import { getBilinearSampler } from "../resource/samplers.js";
import { SS, TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";

declare const htmlTexture2DBrand: unique symbol;

/**
 * Minimal surface of the experimental WICG HTML-in-Canvas GPU-upload call. The
 * IDL is mid-flight, so it is declared locally (not as an ambient/global
 * augmentation) to keep the feature self-contained and add no project-wide types.
 * @internal
 */
interface HtmlInCanvasQueue {
    copyElementImageToTexture(
        source: { source: Element; sx?: number; sy?: number; swidth?: number; sheight?: number },
        destination: { destination: { texture: GPUTexture }; width?: number; height?: number }
    ): void;
}

/** A rendering canvas that opts its DOM subtree into layout + paint capture. The
 *  WICG surface is declared structurally (not as an `HTMLCanvasElement` extension)
 *  so it stays self-contained regardless of the ambient DOM lib. @internal */
interface HtmlInCanvasHost {
    layoutSubtree: boolean;
    requestPaint?: () => void;
    addEventListener(type: "paint", listener: (ev: Event) => void): void;
    removeEventListener(type: "paint", listener: (ev: Event) => void): void;
}

interface HtmlInCanvasHostRef {
    count: number;
    previousLayoutSubtree: HtmlInCanvasHost["layoutSubtree"] | undefined;
}

/** A `paint` event carrying the set of elements that changed since the last paint. @internal */
interface PaintEventLike extends Event {
    readonly changedElements?: ReadonlyArray<Element>;
}

/**
 * A {@link DynamicTexture2D} whose pixels are rasterised from a live `HTMLElement` by
 * {@link createHtmlTexture}. Drops into any material texture slot; the extra
 * fields are internal bookkeeping for the hosted element and paint listener.
 */
export interface HtmlTexture2D extends DynamicTexture2D {
    /** Opaque nominal brand. */
    readonly [htmlTexture2DBrand]: true;
    /** @internal The hosted source element. */
    _element: HTMLElement;
    /** @internal The rendering canvas hosting the element for capture. */
    _host: HTMLCanvasElement;
    /** @internal Original parent to restore the element to on dispose. */
    _prevParent: Node | null;
    /** @internal Original next-sibling to restore the element's position. */
    _prevNextSibling: Node | null;
    /** @internal Original `inert` state to restore on dispose. */
    _prevInert: boolean;
    /** @internal Attached `paint` listener (native path), or null. */
    _paint: ((ev: Event) => void) | null;
    /** @internal Desired upright orientation (Y-up) of the sampled result. */
    _invertY: boolean;
    /** @internal Refresh on every host paint where the element changed. */
    _autoUpdate: boolean;
    /** @internal Allow the SVG `<foreignObject>` static fallback. */
    _useSvgFallback: boolean;
    /** @internal One-shot: force the next paint to upload regardless of the change filter. */
    _forceNext: boolean;
    /** @internal True while this texture has hosted its element under the canvas. */
    _hosted: boolean;
    /** @internal Set once {@link disposeHtmlTexture} has run. */
    _disposed: boolean;
    /** @internal Staging texture for the native V-flip blit, or null until first used. */
    _flipSrc: GPUTexture | null;
    /** @internal Device that created {@link _flipSrc}; a mismatch (device-lost
     *  recovery) forces the staging texture to be recreated. */
    _flipDevice: GPUDevice | null;
}

/** Options for {@link createHtmlTexture}. */
export interface HtmlTexture2DOptions extends DynamicTexture2DOptions {
    /** Texture width in texels. Default `element.offsetWidth || 256`. */
    width?: number;
    /** Texture height in texels. Default `element.offsetHeight || 256`. */
    height?: number;
    /** Re-upload automatically whenever the hosted element changes (native path
     *  only — the SVG fallback is a static snapshot). Default true. */
    autoUpdate?: boolean;
    /** Present the sampled result upright under Lite's Y-up convention. Baked into
     *  the texture pixels (a GPU V-flip on the native path, an upload `flipY` on the
     *  SVG fallback), so it is correct in any material slot. Set `false` to keep the
     *  element's native top-row-first orientation. Default true. */
    invertY?: boolean;
    /** Fall back to an SVG `<foreignObject>` static snapshot when the native
     *  HTML-in-Canvas API is unavailable. Default true. */
    useSvgFallback?: boolean;
}

/** True if the engine's WebGPU device exposes the native HTML-in-Canvas upload. */
export function isHtmlInCanvasSupported(engine: EngineContext): boolean {
    return typeof (engine._device.queue as unknown as Partial<HtmlInCanvasQueue>).copyElementImageToTexture === "function";
}

/**
 * Create an HTML texture from a live `element`. When an update path exists, the
 * element is re-parented under the rendering canvas (restored on dispose), the
 * texture is allocated blank, and — on the native path — a `paint` listener is
 * attached so the texture tracks the element. Reads as transparent black until
 * the first paint uploads.
 *
 * @param engine - Engine context (must render into a DOM canvas, not an `OffscreenCanvas`).
 * @param element - The DOM element to rasterise.
 * @param options - Size / sampler / update overrides.
 */
export function createHtmlTexture(engine: EngineContext, element: HTMLElement, options: HtmlTexture2DOptions = {}): HtmlTexture2D {
    const host = engine.surfaces[0].canvas;
    if (!isDomCanvas(host)) {
        throw new Error("createHtmlTexture: requires a DOM canvas rendering surface (HTML-in-Canvas is unavailable on OffscreenCanvas).");
    }
    const supportsNativeHtmlTexture = isHtmlInCanvasSupported(engine);

    const width = options.width ?? (element.offsetWidth || 256);
    const height = options.height ?? (element.offsetHeight || 256);

    const tex = createDynamicTexture(engine, width, height, {
        srgb: options.srgb,
        mipMaps: options.mipMaps,
        addressModeU: options.addressModeU,
        addressModeV: options.addressModeV,
        minFilter: options.minFilter,
        magFilter: options.magFilter,
    }) as HtmlTexture2D;

    tex._element = element;
    tex._host = host;
    tex._prevParent = element.parentNode;
    tex._prevNextSibling = element.nextSibling;
    tex._prevInert = element.inert;
    tex._paint = null;
    tex._invertY = options.invertY ?? true;
    tex._autoUpdate = options.autoUpdate ?? true;
    tex._useSvgFallback = options.useSvgFallback ?? true;
    tex._forceNext = false;
    tex._hosted = false;
    tex._disposed = false;
    tex._flipSrc = null;
    tex._flipDevice = null;

    if (supportsNativeHtmlTexture || tex._useSvgFallback) {
        // Host the element only when an update path exists. `layoutSubtree` opts
        // the canvas's DOM descendants into layout + paint; `inert` stops the
        // subtree from stealing pointer/keyboard input from the camera controls.
        acquireHtmlInCanvasHost(host as unknown as HtmlInCanvasHost);
        element.inert = true;
        host.appendChild(element);
        tex._hosted = true;
    }

    if (supportsNativeHtmlTexture) {
        // Orientation is baked into the texture pixels (a GPU V-flip in
        // updateHtmlTexture), not applied as a material-side UV flip — the standard
        // material's single shared UV transform can only invert the diffuse/opacity/
        // bump slot, so a material flip would silently do nothing for an HTML texture
        // used as an emissive/reflection/etc. map. Baking keeps the result upright in
        // ANY slot, matching the SVG fallback (which bakes its flip at upload).

        const onPaint = (ev: Event): void => {
            if (tex._disposed) {
                return;
            }
            const force = tex._forceNext;
            tex._forceNext = false;
            if (!force) {
                if (!tex._autoUpdate) {
                    return;
                }
                const changed = (ev as PaintEventLike).changedElements;
                if (changed && !changed.some((c) => c === element || element.contains(c))) {
                    return;
                }
            }
            updateHtmlTexture(engine, tex);
        };
        tex._paint = onPaint;
        host.addEventListener("paint", onPaint);
        requestHtmlTextureUpdate(engine, tex);
    } else if (tex._useSvgFallback) {
        // No native support: rasterise a static SVG snapshot now. The upload flips
        // at copy time, so no material-side flip is needed (invertY stays unset).
        updateHtmlTexture(engine, tex);
    }

    return tex;
}

/**
 * Upload the current pixels of the hosted element into the texture. On the native
 * path this is a single `copyElementImageToTexture` and **must run inside a paint
 * event** — normally the internal paint listener calls it; call
 * {@link requestHtmlTextureUpdate} to trigger a refresh from application code.
 * When the native API is unavailable it rasterises the SVG fallback (async).
 *
 * @param engine - Engine context.
 * @param tex - Target texture from {@link createHtmlTexture}.
 * @param invertY - Override the upright-orientation flag for this upload.
 */
export function updateHtmlTexture(engine: EngineContext, tex: HtmlTexture2D, invertY: boolean = tex._invertY): void {
    if (tex._disposed) {
        return;
    }
    const queue = engine._device.queue as unknown as Partial<HtmlInCanvasQueue>;
    if (typeof queue.copyElementImageToTexture === "function") {
        // `copyElementImageToTexture` captures the element top-row-first, which is
        // upside-down under Lite's Y-up UV convention. When an upright result is
        // wanted (the default) the capture goes into a staging texture and is
        // V-flipped into the final texture; otherwise it is copied straight in.
        if (invertY) {
            const src = ensureFlipSource(engine, tex);
            queue.copyElementImageToTexture({ source: tex._element }, { destination: { texture: src }, width: tex.width, height: tex.height });
            flipVertical(engine, src, tex.texture);
        } else {
            queue.copyElementImageToTexture({ source: tex._element }, { destination: { texture: tex.texture }, width: tex.width, height: tex.height });
        }
        if (tex.texture.mipLevelCount > 1) {
            generateMipmaps(engine, tex.texture);
        }
        return;
    }
    if (tex._useSvgFallback) {
        void uploadSvgFallback(engine, tex, invertY);
    }
}

/**
 * Ask the texture to refresh from the current DOM state. On the native path this
 * schedules a `paint` (`canvas.requestPaint()`) whose listener performs the copy;
 * on the fallback path it rasterises the SVG snapshot immediately.
 *
 * @param engine - Engine context.
 * @param tex - Target texture from {@link createHtmlTexture}.
 */
export function requestHtmlTextureUpdate(engine: EngineContext, tex: HtmlTexture2D): void {
    if (tex._disposed) {
        return;
    }
    const host = tex._host as unknown as HtmlInCanvasHost;
    const supportsNativeHtmlTexture = isHtmlInCanvasSupported(engine);
    if (supportsNativeHtmlTexture && typeof host.requestPaint === "function") {
        tex._forceNext = true;
        host.requestPaint();
    } else if (!supportsNativeHtmlTexture && tex._useSvgFallback) {
        updateHtmlTexture(engine, tex);
    }
}

/**
 * Detach the paint listener, restore the hosted element to its original DOM
 * position and `inert` state, and release the GPU texture.
 *
 * @param tex - Target texture from {@link createHtmlTexture}.
 */
export function disposeHtmlTexture(tex: HtmlTexture2D): void {
    if (tex._disposed) {
        return;
    }
    tex._disposed = true;

    if (tex._paint) {
        tex._host.removeEventListener("paint", tex._paint);
        tex._paint = null;
    }

    if (tex._hosted) {
        const element = tex._element;
        if (element.parentNode === tex._host) {
            if (tex._prevParent) {
                tex._prevParent.insertBefore(element, tex._prevNextSibling);
            } else {
                tex._host.removeChild(element);
            }
        }
        element.inert = tex._prevInert;
        releaseHtmlInCanvasHost(tex._host as unknown as HtmlInCanvasHost);
        tex._hosted = false;
    }

    tex._flipSrc?.destroy();
    tex._flipSrc = null;
    tex._flipDevice = null;

    releaseTexture(tex);
}

let htmlInCanvasHostRefs: WeakMap<HtmlInCanvasHost, HtmlInCanvasHostRef> | null = null;

function acquireHtmlInCanvasHost(host: HtmlInCanvasHost): void {
    const refs = (htmlInCanvasHostRefs ??= new WeakMap());
    let ref = refs.get(host);
    if (!ref) {
        ref = { count: 0, previousLayoutSubtree: (host as Partial<HtmlInCanvasHost>).layoutSubtree };
        refs.set(host, ref);
    }
    ref.count++;
    host.layoutSubtree = true;
}

function releaseHtmlInCanvasHost(host: HtmlInCanvasHost): void {
    const ref = htmlInCanvasHostRefs?.get(host);
    if (!ref) {
        return;
    }
    ref.count--;
    if (ref.count > 0) {
        return;
    }

    // Restore the host's paint-capture mode when the last HTML texture is gone.
    if (ref.previousLayoutSubtree === undefined) {
        delete (host as Partial<HtmlInCanvasHost>).layoutSubtree;
    } else {
        host.layoutSubtree = ref.previousLayoutSubtree;
    }
    htmlInCanvasHostRefs?.delete(host);
}

/** Rasterise the element via an SVG `<foreignObject>` snapshot and upload it.
 *  Static, inline-style / same-origin only — a graceful degradation of the native
 *  path. Errors (e.g. a tainted cross-origin resource) leave the last pixels. */
async function uploadSvgFallback(engine: EngineContext, tex: HtmlTexture2D, invertY: boolean): Promise<void> {
    try {
        const source = await loadSvgSnapshot(tex._element, tex.width, tex.height);
        if (!tex._disposed) {
            updateDynamicTexture(engine, tex, source, { invertY });
        }
    } catch {
        // Fallback rasterisation failed; keep whatever was last uploaded.
    }
}

/** Serialise `element` into an SVG `<foreignObject>` snapshot and rasterise it to a
 *  2D canvas. A WebGPU copy of an SVG-backed `<img>` can yield a blank texture, so
 *  the decoded image is drawn onto a canvas — a reliable `copyExternalImageToTexture`
 *  source — before upload. */
function loadSvgSnapshot(element: HTMLElement, width: number, height: number): Promise<HTMLCanvasElement> {
    const xml = new XMLSerializer().serializeToString(element);
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>` +
        `</foreignObject></svg>`;
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);

    return new Promise<HTMLCanvasElement>((resolve, reject) => {
        const image = new Image(width, height);
        image.decoding = "async";
        image.onload = (): void => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                reject(new Error("createHtmlTexture: SVG fallback could not acquire a 2D canvas context."));
                return;
            }
            ctx.drawImage(image, 0, 0, width, height);
            resolve(canvas);
        };
        image.onerror = (): void => reject(new Error("createHtmlTexture: SVG fallback failed to rasterise the element."));
        image.src = url;
    });
}

// ── Native-path vertical flip ───────────────────────────────────────────────
// `copyElementImageToTexture` has no `flipY` option, so an upright result is baked
// with a fullscreen-triangle render pass that samples the staging capture with an
// inverted V. Resources are lazily built and cached per device (mirrors
// generate-mipmaps), so an app that never creates an HTML texture bundles none of it.

const FLIP_SHADER = `@group(0)@binding(0)var t:texture_2d<f32>;@group(0)@binding(1)var s:sampler;
struct V{@builtin(position)p:vec4f,@location(0)u:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return V(vec4f(p,0,1),p*vec2f(.5,.5)+.5);}
@fragment fn fs(v:V)->@location(0)vec4f{return textureSample(t,s,v.u);}`;

let flipDevice: GPUDevice | null = null;
let flipShader: GPUShaderModule | null = null;
let flipLayout: GPUBindGroupLayout | null = null;
let flipPipelines: Map<GPUTextureFormat, GPURenderPipeline> | null = null;

function ensureFlipPipeline(engine: EngineContext, format: GPUTextureFormat): GPURenderPipeline {
    const device = engine._device;
    if (device !== flipDevice) {
        flipDevice = device;
        flipShader = null;
        flipLayout = null;
        flipPipelines = null;
    }
    flipShader ??= device.createShaderModule({ code: FLIP_SHADER });
    flipLayout ??= device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: "float" } },
            { binding: 1, visibility: SS.FRAGMENT, sampler: {} },
        ],
    });
    flipPipelines ??= new Map();
    let pipeline = flipPipelines.get(format);
    if (!pipeline) {
        pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [flipLayout] }),
            vertex: { module: flipShader, entryPoint: "vs" },
            fragment: { module: flipShader, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
        flipPipelines.set(format, pipeline);
    }
    return pipeline;
}

/** Lazily allocate (and size-match) the staging texture the native capture is copied
 *  into before the V-flip blit. */
function ensureFlipSource(engine: EngineContext, tex: HtmlTexture2D): GPUTexture {
    const device = engine._device;
    let src = tex._flipSrc;
    if (!src || tex._flipDevice !== device || src.width !== tex.width || src.height !== tex.height) {
        src?.destroy();
        src = device.createTexture({
            size: { width: tex.width, height: tex.height },
            format: tex.texture.format,
            usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
        });
        tex._flipSrc = src;
        tex._flipDevice = device;
    }
    return src;
}

/** Render `src` into `dst` mip 0 vertically flipped (a single fullscreen triangle). */
function flipVertical(engine: EngineContext, src: GPUTexture, dst: GPUTexture): void {
    const device = engine._device;
    const pipeline = ensureFlipPipeline(engine, dst.format);
    const bindGroup = device.createBindGroup({
        layout: flipLayout!,
        entries: [
            { binding: 0, resource: src.createView() },
            { binding: 1, resource: getBilinearSampler(engine) },
        ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dst.createView({ baseMipLevel: 0, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
}
