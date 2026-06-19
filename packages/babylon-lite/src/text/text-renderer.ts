/** TextRenderer — a standalone `RenderingContext` that draws one or more
 *  `TextLayer`s directly to the swapchain. Sibling of `SpriteRenderer`:
 *  owns its own render pass, no scene / camera dependency.
 *
 *  `TextLayer` is the 2D pixel-space placement record bound to a single TextData; it
 *  lives here because it is consumed exclusively by `TextRenderer`. */

import { registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { RenderingContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import { createEmptyUniformBuffer } from "../resource/gpu-buffers.js";
import type { TextData } from "./text-data.js";
import { TEXT_INSTANCE_BYTES } from "./text-data.js";
import { ensureSharedAtlasGpu } from "./_gpu/text-textures.js";
import { getOrCreateTextPipeline } from "./_gpu/text-pipeline.js";

// ─── TextLayer ────────────────────────────────────────────────────────────

/** Initial placement and compositing options for a 2D text layer in a standalone text renderer. */
export interface TextLayerOptions {
    /** Top-left origin (in canvas pixels) for the layer's local coordinate frame. Default (0, 0). */
    readonly positionPx?: { readonly x: number; readonly y: number };
    /** Z-axis rotation about `positionPx`, in radians. Default 0. */
    readonly rotationRad?: number;
    /** Uniform scale applied to the laid-out text. Default 1. */
    readonly scale?: number;
    /** Sort order within a renderer (lower draws first). Default 0. */
    readonly order?: number;
    /** Alpha multiplier in [0, 1]. Default 1. */
    readonly opacity?: number;
    /** Default true. */
    readonly visible?: boolean;
}

/** Pure-data 2D text layer. Mutate fields directly between frames. */
export interface TextLayer {
    /** @internal */
    readonly _kind: "text-layer";
    readonly data: TextData;
    positionPx: { x: number; y: number };
    rotationRad: number;
    scale: number;
    order: number;
    opacity: number;
    visible: boolean;
    /** @internal Monotonic version bumped by helpers that mutate placement. */
    _version: number;
}

/** Create a 2D text layer that places a `TextData` block in canvas pixel space.
 *
 *  @param data - Text data block drawn by the layer.
 *  @param options - Optional pixel placement, scale, order, opacity, and visibility.
 *  @returns A mutable layer object for use with a `TextRenderer`. */
export function createTextLayer(data: TextData, options?: TextLayerOptions): TextLayer {
    return {
        _kind: "text-layer",
        data,
        positionPx: { x: options?.positionPx?.x ?? 0, y: options?.positionPx?.y ?? 0 },
        rotationRad: options?.rotationRad ?? 0,
        scale: options?.scale ?? 1,
        order: options?.order ?? 0,
        opacity: options?.opacity ?? 1,
        visible: options?.visible ?? true,
        _version: 0,
    };
}

/** Update the layer's pixel position. Convenience wrapper. */
export function setTextLayerPosition(layer: TextLayer, x: number, y: number): void {
    layer.positionPx.x = x;
    layer.positionPx.y = y;
    layer._version++;
}

// ─── TextRenderer ─────────────────────────────────────────────────────────

const KIND = "text-renderer" as const;

/** UBO: mat4 mvp (64B) + viewport vec4 (16B) + color vec4 (16B). */
const TEXT_UBO_BYTES = 96;

/** Options for creating a standalone text renderer that draws directly to a surface. */
export interface TextRendererOptions {
    layers: readonly TextLayer[];
    /** Default true. Set false for HUD overlays so the text pass preserves existing scene color. */
    clear?: boolean;
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. */
    clearValue?: GPUColorDict;
}

/** Standalone rendering context that draws sorted 2D text layers directly to the swapchain. */
export interface TextRenderer extends RenderingContext {
    /** @internal */
    readonly _kind: typeof KIND;
    readonly layers: readonly TextLayer[];
    /** @internal Mutable alias of {@link layers} (same array reference). */
    _layers: TextLayer[];
    /** @internal */ readonly _surface: SurfaceContext;
    /** @internal Per-layer GPU resources, keyed by layer. */
    _layerGpu: Map<TextLayer, LayerGpu>;
    /** @internal */ _targetWidth: number;
    /** @internal */ _targetHeight: number;
    /** @internal */ _disposed: boolean;
    /** @internal */ _clear: boolean;
}

/** @internal Per-layer GPU resources owned by the renderer. */
interface LayerGpu {
    layer: TextLayer;
    textU: GPUBuffer;
    instanceBuf: GPUBuffer;
    instanceCap: number;
    pipeline: GPURenderPipeline | null;
    /** Per-draw-group bind groups; rebuilt when atlas grows. */
    bindGroups: GPUBindGroup[];
    bindGroupAtlasVersions: number[];
    uploadedDataVersion: number;
    uploadedViewportW: number;
    uploadedViewportH: number;
    /** Snapshot of (posX, posY, rot, scale, W, H) to skip mvp upload when unchanged. */
    lastMvpInputs: Float32Array;
    mvpUploaded: boolean;
}

const _mvpScratch = new Float32Array(16);

function buildLayerMvp(layer: TextLayer, targetW: number, targetH: number, out: Float32Array): void {
    const s = layer.scale;
    const r = layer.rotationRad;
    const cr = Math.cos(r);
    const sr = Math.sin(r);
    const px = layer.positionPx.x;
    const py = layer.positionPx.y;
    // Map glyph-local (font Y-up) coords through (scale, flip-Y) → rotate → translate → ortho(W,H, Y-down).
    // Equivalent compact affine — see plan note for derivation. Column-major.
    const cx = (2 * s) / targetW;
    const cy = (2 * s) / targetH;
    out.fill(0);
    out[0] = cx * cr; // col 0, row 0
    out[1] = -cy * sr; // col 0, row 1
    out[4] = cx * sr; // col 1, row 0
    out[5] = cy * cr; // col 1, row 1
    out[10] = 1; // depth pass-through (we don't write depth)
    out[12] = (2 * px) / targetW - 1;
    out[13] = 1 - (2 * py) / targetH;
    out[15] = 1;
}

function ensureLayerGpu(rr: TextRenderer, layer: TextLayer): LayerGpu {
    let lg = rr._layerGpu.get(layer);
    if (lg) {
        return lg;
    }
    const engine = rr._surface.engine;
    const device = engine._device;
    const cap = Math.max(layer.data._instanceCount, 8);
    lg = {
        layer,
        textU: createEmptyUniformBuffer(engine, TEXT_UBO_BYTES, "text-layer-ubo"),
        instanceBuf: device.createBuffer({
            label: "text-layer-instances",
            size: cap * TEXT_INSTANCE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        instanceCap: cap,
        pipeline: null,
        bindGroups: [],
        bindGroupAtlasVersions: [],
        uploadedDataVersion: -1,
        uploadedViewportW: 0,
        uploadedViewportH: 0,
        lastMvpInputs: new Float32Array(6),
        mvpUploaded: false,
    };
    rr._layerGpu.set(layer, lg);
    return lg;
}

function ensureInstanceCapacity(device: GPUDevice, lg: LayerGpu, needed: number): void {
    if (needed <= lg.instanceCap) {
        return;
    }
    let cap = lg.instanceCap;
    while (cap < needed) {
        cap *= 2;
    }
    lg.instanceBuf.destroy();
    lg.instanceBuf = device.createBuffer({
        label: "text-layer-instances",
        size: cap * TEXT_INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    lg.instanceCap = cap;
    lg.uploadedDataVersion = -1;
}

function uploadLayer(rr: TextRenderer, lg: LayerGpu, bindGroupLayout: GPUBindGroupLayout): void {
    const device = rr._surface.engine._device;
    const layer = lg.layer;
    const data = layer.data;

    // Atlas + bind groups per draw group.
    for (let i = 0; i < data._groups.length; i++) {
        const g = data._groups[i]!;
        const { rebuilt, gpu: atlasGpu } = ensureSharedAtlasGpu(device, g.curveSet.atlas);
        const current = lg.bindGroups[i];
        const currentVer = lg.bindGroupAtlasVersions[i] ?? -1;
        if (!current || rebuilt || currentVer !== atlasGpu.uploadedVersion) {
            lg.bindGroups[i] = device.createBindGroup({
                label: "text-renderer-bg0-" + g.curveSetId,
                layout: bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: lg.textU } },
                    { binding: 1, resource: atlasGpu.curveTex.createView() },
                    { binding: 2, resource: atlasGpu.bandTex.createView() },
                ],
            });
            lg.bindGroupAtlasVersions[i] = atlasGpu.uploadedVersion;
        }
    }
    if (lg.bindGroups.length > data._groups.length) {
        lg.bindGroups.length = data._groups.length;
        lg.bindGroupAtlasVersions.length = data._groups.length;
    }

    // Instance buffer.
    ensureInstanceCapacity(device, lg, data._instanceCount);
    if (lg.uploadedDataVersion !== data._version && data._instanceCount > 0) {
        const dirtyValid = lg.uploadedDataVersion !== -1 && data._dirtyEnd > data._dirtyStart;
        if (dirtyValid) {
            const startFloats = data._dirtyStart * (TEXT_INSTANCE_BYTES / 4);
            const endFloats = data._dirtyEnd * (TEXT_INSTANCE_BYTES / 4);
            const view = data._instances.subarray(startFloats, endFloats);
            device.queue.writeBuffer(lg.instanceBuf, data._dirtyStart * TEXT_INSTANCE_BYTES, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
        } else {
            const view = data._instances.subarray(0, data._instanceCount * (TEXT_INSTANCE_BYTES / 4));
            device.queue.writeBuffer(lg.instanceBuf, 0, view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
        }
        lg.uploadedDataVersion = data._version;
        data._dirtyStart = 0;
        data._dirtyEnd = 0;
    }

    // MVP — skip upload when nothing relevant changed.
    const W = rr._targetWidth;
    const H = rr._targetHeight;
    const mi = lg.lastMvpInputs;
    if (!lg.mvpUploaded || mi[0] !== layer.positionPx.x || mi[1] !== layer.positionPx.y || mi[2] !== layer.rotationRad || mi[3] !== layer.scale || mi[4] !== W || mi[5] !== H) {
        buildLayerMvp(layer, W, H, _mvpScratch);
        device.queue.writeBuffer(lg.textU, 0, _mvpScratch.buffer as ArrayBuffer, _mvpScratch.byteOffset, 64);
        mi[0] = layer.positionPx.x;
        mi[1] = layer.positionPx.y;
        mi[2] = layer.rotationRad;
        mi[3] = layer.scale;
        mi[4] = W;
        mi[5] = H;
        lg.mvpUploaded = true;
    }

    // Viewport (only used by Slug dilation; pixel reciprocal is fine to refresh on resize).
    if (lg.uploadedViewportW !== W || lg.uploadedViewportH !== H) {
        const vp = new Float32Array([W, H, 0, 0]);
        device.queue.writeBuffer(lg.textU, 64, vp.buffer as ArrayBuffer, vp.byteOffset, 16);
        lg.uploadedViewportW = W;
        lg.uploadedViewportH = H;
    }

    // Color uniform carries the whole-layer opacity as alpha (RGB = white). Per-glyph/per-run
    // color comes from the instance `slugColor` attribute and is multiplied by this in the shader.
    const col = new Float32Array([1, 1, 1, layer.opacity]);
    device.queue.writeBuffer(lg.textU, 80, col.buffer as ArrayBuffer, col.byteOffset, 16);
}

function disposeLayerGpu(lg: LayerGpu): void {
    lg.textU.destroy();
    lg.instanceBuf.destroy();
}

function compareLayers(a: TextLayer, b: TextLayer): number {
    return a.order - b.order;
}

/** Create a standalone text renderer for one surface.
 *
 *  @param surface - Surface whose swapchain receives the text pass.
 *  @param opts - Initial layers and clear settings.
 *  @returns A rendering context that can be registered with the engine. */
export function createTextRenderer(surface: SurfaceContext, opts: TextRendererOptions): TextRenderer {
    const canvas = surface.canvas;
    const layers = opts.layers.slice();

    const rr: TextRenderer = {
        _kind: KIND,
        _surface: surface,
        _layerGpu: new Map(),
        _targetWidth: canvas.width,
        _targetHeight: canvas.height,
        _disposed: false,
        _clear: opts.clear ?? true,
        layers,
        _layers: layers,
        clearColor: opts.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _update(): void {
            textRendererUpdate(rr);
        },
        _record(): number {
            return textRendererRecord(rr);
        },
    };
    return rr;
}

function textRendererUpdate(rr: TextRenderer): void {
    if (rr._disposed) {
        return;
    }
    const size = rr._surface.canvas;
    rr._targetWidth = size.width;
    rr._targetHeight = size.height;

    if (rr._layers.length > 1) {
        rr._layers.sort(compareLayers);
    }

    // Pipeline: depth-less, sampleCount=1, swapchain format. The key is identical for every
    // layer, so resolve it once per frame and reuse the pipeline + bind-group layout below.
    const { pipeline, cache } = getOrCreateTextPipeline(rr._surface.engine, rr._surface.format, 1, null, false);

    for (const layer of rr._layers) {
        if (!layer.visible) {
            continue;
        }
        const lg = ensureLayerGpu(rr, layer);
        if (lg.pipeline !== pipeline) {
            lg.pipeline = pipeline;
            // Pipeline change → bind groups must be rebuilt against new bindGroupLayout.
            lg.bindGroups.length = 0;
            lg.bindGroupAtlasVersions.length = 0;
        }
        uploadLayer(rr, lg, cache.bindGroupLayout);
    }
}

function textRendererRecord(rr: TextRenderer): number {
    if (rr._disposed) {
        return 0;
    }
    const eng = rr._surface.engine;
    const encoder = eng._currentEncoder;
    const swapView = rr._surface.scRT._colorView!;

    const pass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: swapView,
                clearValue: rr.clearColor,
                loadOp: rr._clear ? "clear" : "load",
                storeOp: "store",
            },
        ],
    });

    let drawCalls = 0;
    let lastPipeline: GPURenderPipeline | null = null;
    const { cache } = getOrCreateTextPipeline(rr._surface.engine, rr._surface.format, 1, null, false);
    const quadVertex = cache.quadVertexBuffer;
    pass.setVertexBuffer(0, quadVertex);

    for (const layer of rr._layers) {
        if (!layer.visible) {
            continue;
        }
        const lg = rr._layerGpu.get(layer);
        if (!lg || !lg.pipeline) {
            continue;
        }
        const data = layer.data;
        if (data._instanceCount === 0) {
            continue;
        }
        if (lastPipeline !== lg.pipeline) {
            pass.setPipeline(lg.pipeline);
            lastPipeline = lg.pipeline;
        }
        pass.setVertexBuffer(1, lg.instanceBuf);
        for (let i = 0; i < data._groups.length; i++) {
            const g = data._groups[i]!;
            const bg = lg.bindGroups[i];
            if (g.slotCount === 0 || !bg) {
                continue;
            }
            pass.setBindGroup(0, bg);
            pass.draw(6, g.slotCount, 0, g.slotStart);
            drawCalls++;
        }
    }

    pass.end();
    return drawCalls;
}

/** Add a text layer to an existing renderer if it is not already present.
 *
 *  @param tr - Text renderer to mutate.
 *  @param layer - Layer to append; draw order is sorted during renderer update. */
export function addTextRendererLayer(tr: TextRenderer, layer: TextLayer): void {
    if (tr._disposed) {
        throw new Error("TextRenderer has been disposed.");
    }
    if (tr._layers.includes(layer)) {
        return;
    }
    tr._layers.push(layer);
}

/** Remove a text layer and release its per-layer GPU buffers.
 *
 *  @returns `true` when the layer was present and removed. */
export function removeTextRendererLayer(tr: TextRenderer, layer: TextLayer): boolean {
    const i = tr._layers.indexOf(layer);
    if (i < 0) {
        return false;
    }
    tr._layers.splice(i, 1);
    const lg = tr._layerGpu.get(layer);
    if (lg) {
        disposeLayerGpu(lg);
        tr._layerGpu.delete(layer);
    }
    return true;
}

/** Register a text renderer with its surface so the engine updates and records it each frame. */
export function registerTextRenderer(tr: TextRenderer): void {
    registerRenderingContext(tr._surface, tr);
}

/** Unregister a text renderer from its surface without disposing its layer data. */
export function unregisterTextRenderer(tr: TextRenderer): void {
    unregisterRenderingContext(tr._surface, tr);
}

/** Dispose a text renderer and all per-layer GPU resources it owns. Layer `TextData` remains caller-owned. */
export function disposeTextRenderer(tr: TextRenderer): void {
    if (tr._disposed) {
        return;
    }
    unregisterTextRenderer(tr);
    tr._disposed = true;
    for (const lg of tr._layerGpu.values()) {
        disposeLayerGpu(lg);
    }
    tr._layerGpu.clear();
    tr._layers.length = 0;
}
