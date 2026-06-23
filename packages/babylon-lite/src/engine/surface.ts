import type { EngineContext, RenderCanvas, RenderingContext } from "./engine.js";
import type { RenderTarget } from "./render-target.js";
import { createRenderTarget } from "./render-target.js";

/** @internal Type guard: true for a DOM canvas (has layout + attributes). */
export function isDomCanvas(canvas: RenderCanvas): canvas is HTMLCanvasElement {
    return "clientWidth" in canvas;
}

/** @internal Map a configurable canvas format to its sRGB sibling (e.g. `bgra8unorm`
 *  → `bgra8unorm-srgb`). Already-`-srgb` formats are returned unchanged. WebGPU does
 *  not accept a `*-srgb` format directly in `GPUCanvasContext.configure()`, so the
 *  swapchain is configured with the base format plus `viewFormats: [srgbFormat]` and
 *  rendered through an sRGB view — see {@link _buildSurface}. */
export function toSrgbFormat(format: GPUTextureFormat): GPUTextureFormat {
    return format.endsWith("-srgb") ? format : (`${format}-srgb` as GPUTextureFormat);
}

/** @internal Monotonic source for {@link SurfaceContext._uniqueId}. Module-scoped so every
 *  surface created in this runtime (engine primary surfaces + auxiliary surfaces) gets a
 *  process-unique, stable identifier independent of its canvas size. */
let _nextSurfaceId = 1;

/**
 * Per-canvas rendering surface — owns the GPU canvas context, swapchain format, MSAA
 * configuration, and the list of `RenderingContext`s (scenes, effect renderers,
 * frame-graph contexts, sprite/text renderers) that present to this canvas.
 *
 * The `EngineContext` *is itself a `SurfaceContext`* (the primary one, bound to the
 * canvas passed into `createEngine`). Additional surfaces for auxiliary canvases are
 * created via {@link createSurface}. GPU resources (textures, buffers, pipelines, bind
 * groups) live on the {@link EngineContext} (device-scoped) and are shared across all
 * surfaces of the same engine — only the swapchain output is per-surface.
 */
export interface SurfaceContext {
    /** Owning engine. For the engine's primary surface this points back to the engine
     *  itself (`engine.engine === engine`). */
    readonly engine: EngineContext;
    /** Canvas this surface presents to. */
    readonly canvas: RenderCanvas;
    /** Swapchain texture format for this surface. Use as the `format` for offscreen
     *  RTs that will be composited onto this surface. When sRGB is enabled (see
     *  {@link SurfaceOptions.srgb}) this is the `*-srgb` view format that pipelines and
     *  the swapchain `RenderTarget` render through, not the format passed to
     *  `GPUCanvasContext.configure()` (that is {@link _configureFormat}). */
    readonly format: GPUTextureFormat;
    /** MSAA sample count for the main render pass into this surface (1 or 4). */
    readonly msaaSamples: number;

    /** @internal Process-unique, stable identifier for this surface, assigned at construction
     *  from a module-scoped counter. Independent of canvas size, so it stays a reliable
     *  per-surface key even when two surfaces share the same dimensions (e.g. for keying
     *  cached per-surface GPU resources like post-process internal targets). */
    _uniqueId: number;
    /**
     * Surface-owned color-only render target that wraps this canvas's swapchain texture.
     * Its `_colorTexture`/`_colorView` are re-acquired from `context.getCurrentTexture()`
     * once per frame (see `_refreshScRT`), so it is always single-sample and carries no
     * depth. Render/post-process/copy tasks target it (or resolve into it) to present to
     * the canvas. It is `_eager` — `buildRenderTarget` and `disposeRenderTarget` both
     * no-op on it and the surface owns its textures, so its shared `_descriptor` must
     * never be mutated.
     */
    readonly scRT: RenderTarget;

    /** Clamps the effective device pixel ratio used for this surface's swapchain backing
     *  store. The backing store is sized at `min(devicePixelRatio, maxDevicePixelRatio) * cssPixels`.
     *  `maxDevicePixelRatio = 1` renders at native CSS-pixel resolution (no DPR upscaling);
     *  the default `Infinity` is unclamped (full devicePixelRatio). Mutable at runtime — set
     *  before the next `resizeSurface` to take effect (mirrors Babylon `setHardwareScalingRatio`). */
    maxDevicePixelRatio: number;

    /** @internal */
    _context: GPUCanvasContext;
    /** @internal Format passed to `GPUCanvasContext.configure()`. Equals {@link format}
     *  unless sRGB is enabled, in which case this is the configurable base format
     *  (e.g. `bgra8unorm`) while {@link format} is its `*-srgb` view. Every
     *  `context.configure()` call (initial build, device-loss recovery, screenshot
     *  COPY_SRC promotion) configures this format with `viewFormats: [format]`. */
    _configureFormat: GPUTextureFormat;
    /** @internal */
    _alphaMode: GPUCanvasAlphaMode;
    /** @internal Registered rendering contexts in render order for this surface
     *  (first clears; subsequent overlay). */
    _renderingContexts: RenderingContext[];

    /** @internal Pending `captureScreenshot` requests for this surface. Serviced by
     *  `renderFrame` on a subsequent frame (one shared copy of the surface's swapchain
     *  texture resolves all queued requests), then cleared. Undefined when nothing is
     *  waiting so non-capturing frames pay nothing. */
    _captureQueue?: { resolve: (s: import("./screenshot.js").Screenshot) => void; reject: (e: unknown) => void }[];

    /** @internal Set once this surface's swapchain has been reconfigured with COPY_SRC for
     *  screenshot readback. Off by default so non-capturing surfaces keep a
     *  compression-friendly RENDER_ATTACHMENT-only swapchain; flipped on the first capture
     *  by the pre-frame hook (before that frame's texture is acquired) and honoured by
     *  device-loss recovery. Per-surface so aux surfaces that never capture stay COPY_SRC-free
     *  even when another surface on the same engine is capturable. */
    _swapchainCopySrc?: boolean;

    /** @internal Screenshot readback hook, dynamically installed by `captureScreenshot` on
     *  first use. `renderFrame` calls it once per surface per frame (after the contexts have
     *  recorded) via optional chaining; it records the surface's swapchain copy into the frame
     *  encoder for any queued requests. By the time it runs the swapchain is already
     *  COPY_SRC-capable (see `_capturePreFrame`), so the copy lands in the current frame. Kept
     *  off `SurfaceContext` until a capture is requested so the copy/unpack code
     *  (`screenshot-readback.js`) stays out of every bundle that never captures a frame. */
    _captureService?: import("./screenshot-readback.js").CaptureService;

    /** @internal Pre-acquire screenshot hook, installed alongside `_captureService` by
     *  `captureScreenshot` on first use. `renderFrame` calls it via optional chaining for each
     *  surface BEFORE acquiring that surface's swapchain texture; on the first queued capture it
     *  reconfigures the surface's swapchain with COPY_SRC (reconfiguring expires the current
     *  texture, so it must run before acquire, never mid-frame). Kept off `SurfaceContext` until
     *  a capture is requested so the reconfigure code stays out of every non-capturing bundle. */
    _capturePreFrame?: import("./screenshot-readback.js").CapturePreFrame;
}

/** Options for {@link createSurface}, and for the per-surface portion of `createEngine`. */
export interface SurfaceOptions {
    /** MSAA sample count for the main render pass. WebGPU only permits `1` (no MSAA)
     *  or `4` (4x MSAA). Defaults to `4`. */
    msaaSamples?: 1 | 4;
    /** WebGPU canvas alpha mode. Use `"premultiplied"` to enable canvas transparency
     *  (clear color with `alpha < 1` will let HTML content underneath show through).
     *  Defaults to `"opaque"`. */
    alphaMode?: GPUCanvasAlphaMode;
    /** Override the swapchain format. Defaults to `navigator.gpu.getPreferredCanvasFormat()`.
     *  Must be a format accepted by `GPUCanvasContext.configure()` (i.e. not a `*-srgb`
     *  format — use {@link srgb} for that). */
    format?: GPUTextureFormat;
    /** Render the swapchain through an sRGB view so the GPU applies linear→sRGB encoding
     *  on store (and decodes sRGB→linear when sampling sRGB textures), making alpha
     *  blending — e.g. text/sprite anti-aliasing — gamma-correct. The canvas is configured
     *  with the base format plus `viewFormats: [<format>-srgb]`, and pipelines target the
     *  `*-srgb` view. Color fed to renderers should be linear (e.g. via
     *  `packedSrgbToLinearRgba`), and color textures sampled for blending should use an
     *  sRGB format. Defaults to `false`. */
    srgb?: boolean;
    /** Clamps the effective device pixel ratio used for the swapchain backing store.
     *  Defaults to unclamped (full devicePixelRatio). */
    maxDevicePixelRatio?: number;
}

/**
 * Create an auxiliary rendering surface bound to an existing engine. The surface
 * configures its own `GPUCanvasContext` against `engine._device` and is appended to
 * `engine.surfaces`. GPU resources (textures, buffers, pipelines) are shared across
 * all surfaces of the same engine because they're device-scoped — render to multiple
 * canvases by creating additional surfaces and binding scenes / renderers to each.
 *
 * The engine's own primary surface (`engine.surfaces[0] === engine`) is created
 * automatically by `createEngine(canvas)`; use `createSurface` only for additional
 * canvases beyond that one.
 *
 * Accepts either a DOM canvas (main thread) or an `OffscreenCanvas` (e.g. transferred
 * to a Web Worker via `transferControlToOffscreen()`).
 */
export function createSurface(engine: EngineContext, canvas: RenderCanvas, options?: SurfaceOptions): SurfaceContext {
    const surface = _buildSurface(engine, canvas, options);
    engine._surfaces.push(surface);
    // Size the canvas backing store first (so the swap texture is acquired at the final
    // size), then populate the swapchain target from the first current texture so its
    // `_colorView`/`_width`/`_height` are non-null before any frame graph builds.
    resizeSurface(surface);
    _refreshScRT(surface);
    return surface;
}

/** @internal Construct (but do not append or initialize) a `SurfaceContext`. Used by
 *  `createSurface` for aux canvases, and by `createEngine` to build the per-canvas
 *  fields of the engine itself (which extends `SurfaceContext`). For the engine path
 *  the caller patches `engine` on the returned record once the engine exists. */
export function _buildSurface(engine: EngineContext, canvas: RenderCanvas, options?: SurfaceOptions): SurfaceContext {
    const context = canvas.getContext("webgpu");
    if (!context) {
        throw new Error("WebGPU context not available");
    }
    const configureFormat = options?.format ?? navigator.gpu.getPreferredCanvasFormat();
    // sRGB swapchain: WebGPU rejects a `*-srgb` format in `configure()`, so configure the
    // base format and render through the `*-srgb` view (set as `surface.format`, which
    // pipelines + the swapchain RT consume). The GPU then encodes linear→sRGB on store,
    // making blend math gamma-correct. `viewFormats` always lists the render format; in the
    // non-sRGB case it equals the base format, which is a no-op (no reinterpretation, so
    // framebuffer compression is unaffected) and lets every `configure()` site stay
    // branch-free.
    const renderFormat = options?.srgb ? toSrgbFormat(configureFormat) : configureFormat;
    const alphaMode: GPUCanvasAlphaMode = options?.alphaMode ?? "opaque";
    // Plain RENDER_ATTACHMENT swapchain by default — deliberately no COPY_SRC. Marking the
    // swapchain copyable can force some drivers to drop lossless framebuffer compression, so
    // surfaces that never take a screenshot must not pay for it. `captureScreenshot` lazily
    // reconfigures the primary surface's swapchain with COPY_SRC on first use (see
    // `engine/screenshot-readback.ts`), keeping the public API unchanged while costing
    // non-capturing surfaces nothing.
    context.configure({ device: engine._device, format: configureFormat, alphaMode, viewFormats: [renderFormat] });
    const msaaSamples: 1 | 4 = options?.msaaSamples === 1 ? 1 : 4;
    // Surface-owned swapchain target — a color-only, single-sample RT that wraps the
    // canvas texture. `_eager` so `buildRenderTarget` skips it; the surface refreshes
    // its textures each frame from `context.getCurrentTexture()`.
    const scRT = createRenderTarget({ lbl: "swapchain", format: renderFormat, samples: 1, size: { width: 0, height: 0 } });
    scRT._eager = true;
    return {
        engine,
        canvas,
        format: renderFormat,
        msaaSamples,
        scRT,
        maxDevicePixelRatio: options?.maxDevicePixelRatio ?? Infinity,
        _uniqueId: _nextSurfaceId++,
        _context: context,
        _configureFormat: configureFormat,
        _alphaMode: alphaMode,
        _renderingContexts: [],
    };
}

/** @internal Re-acquire the canvas swapchain texture into `surface.scRT`. WebGPU
 *  returns a fresh `GPUTexture` from `getCurrentTexture()` each frame, so this is
 *  called once per frame (in `renderFrame`, before contexts record) — and again after
 *  surface creation / device-loss reconfigure — to keep the surface-owned target
 *  pointing at the live canvas texture. */
export function _refreshScRT(surface: SurfaceContext): void {
    const tex = surface._context.getCurrentTexture();
    const swap = surface.scRT;
    swap._colorTexture = tex;
    // View format must match the pipelines + scRT descriptor. With sRGB enabled the canvas
    // texture is the base format with `[srgbFormat]` view formats, so we render through the
    // sRGB view; without sRGB this equals the texture's own format (always a legal view).
    swap._colorView = tex.createView({ format: surface.format });
    swap._width = tex.width;
    swap._height = tex.height;
}

/** Resize this surface's swapchain backing store to match the canvas client size. When
 *  the size changes, asks every rendering context registered on this surface to rebuild
 *  its canvas-sized GPU resources via the optional `_resize` hook. If the canvas has
 *  not been laid out yet, preserves its explicit backing-store size.
 *
 *  Only DOM canvases are auto-sized from layout here. An `OffscreenCanvas` has no
 *  layout box, so its size must be pushed in externally via {@link setSurfaceSize}
 *  (e.g. from the host thread that owns the visible canvas) and this call is a no-op
 *  for it. */
export function resizeSurface(surface: SurfaceContext): void {
    const canvas = surface.canvas;
    if (!isDomCanvas(canvas)) {
        return;
    }
    const clientWidth = canvas.clientWidth;
    const clientHeight = canvas.clientHeight;
    if (!(clientWidth > 0 && clientHeight > 0)) {
        return;
    }
    const scale = Math.min(globalThis.devicePixelRatio || 1, surface.maxDevicePixelRatio);
    const w = (clientWidth * scale) | 0;
    const h = (clientHeight * scale) | 0;
    setSurfaceSize(surface, w, h);
}

/** Set this surface's swapchain backing-store size directly, in device pixels. Use this
 *  when the surface renders into an `OffscreenCanvas` whose layout size is only known
 *  on another thread (the host posts the CSS size × devicePixelRatio). When the size
 *  changes, asks every rendering context registered on this surface to rebuild its
 *  canvas-sized GPU resources via the optional `_resize` hook. */
export function setSurfaceSize(surface: SurfaceContext, widthPx: number, heightPx: number): void {
    const canvas = surface.canvas;
    const w = widthPx | 0;
    const h = heightPx | 0;
    if (!(w > 0 && h > 0)) {
        return;
    }
    if (w === canvas.width && h === canvas.height) {
        return;
    }
    canvas.width = w;
    canvas.height = h;
    // Keep the surface swapchain target's dimensions in sync with the canvas. Canvas-sized
    // reads happen at frame-graph build time (e.g. the blur post-process derives its texel
    // step from `outputTexture._width`), before the next frame re-acquires the swap texture.
    surface.scRT._width = w;
    surface.scRT._height = h;
    for (const c of surface._renderingContexts) {
        c._resize?.();
    }
}

/** Remove and unconfigure an auxiliary surface from its engine. Rendering contexts
 *  registered on this surface are dropped from its list but not disposed — call their
 *  own disposers (e.g. `disposeScene`) separately.
 *
 *  Throws if called on the engine's primary surface (`surface === engine`); use
 *  `disposeEngine` to tear down the engine and all its surfaces. */
export function disposeSurface(surface: SurfaceContext): void {
    if ((surface as unknown as EngineContext) === surface.engine) {
        throw new Error("Babylon Lite: disposeSurface cannot dispose the engine's primary surface — use disposeEngine instead.");
    }
    surface._renderingContexts.length = 0;
    surface._context.unconfigure();
    const list = surface.engine._surfaces;
    const i = list.indexOf(surface);
    if (i !== -1) {
        list.splice(i, 1);
    }
}
