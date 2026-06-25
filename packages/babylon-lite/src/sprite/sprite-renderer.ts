/**
 * `SpriteRenderer` — owns the shared index buffer and per-layer GPU state
 * required to draw `Sprite2DLayer`s. Implements
 * `RenderingContext` directly, so it plugs into `engine._renderingContexts`
 * the same way a `SceneContext` does.
 *
 * Scope:
 *   - Pure-2D / HUD path only — all layers must use `depth: "none"`.
 *   - One sprite-pipeline cache per renderer instance, keyed by format,
 *     blend mode, and sample count. The direct HUD path always uses
 *     `sampleCount=1` and `hasDepth=false`.
 *   - The renderer opens a sprite-only swapchain pass using the engine's
 *     current command encoder and swapchain view. Off-screen / HUD-to-texture
 *     rendering is deferred until there is a concrete caller.
 */
import { F32 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import { registerRenderingContext, unregisterRenderingContext, getRenderTargetSize } from "../engine/engine.js";
import type { RenderingContext } from "../engine/engine.js";
import type { SurfaceContext } from "../engine/surface.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { SpriteLayerFx } from "./custom-shader-core.js";
import { _getSpriteFxHook } from "./sprite-fx-hook.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import type { Texture2D } from "../texture/texture-2d.js";
import {
    LAYER_UBO_BYTES,
    SHARED_SPRITE_INDEX_DATA,
    buildSpriteLayerUbo,
    createSpriteInstanceBuffer,
    createSpriteLayerBindGroup,
    createSpritePipelineCache,
    ensureSpriteInstanceBuffer,
    getOrCreateSpritePipeline,
    getSpritePipelineCacheSize,
    resetSpritePipelineCache,
    uploadSpriteInstances,
    writeSpriteLayerUboIfDirty,
} from "./sprite-pipeline.js";
import type { SpritePipelineCache } from "./sprite-pipeline.js";

/** Tag used by the engine and by tests to identify a sprite renderer. */
const KIND = "sprite-renderer" as const;

/** Options accepted by `createSpriteRenderer`. */
export interface SpriteRendererOptions {
    /** Layers to draw, in registration order. The renderer also re-sorts internally each frame. */
    layers: readonly Sprite2DLayer[];
    /** Default true. Set false for HUD overlays so the sprite pass preserves existing scene color. */
    clear?: boolean;
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. */
    clearValue?: GPUColorDict;
}

/**
 * A `SpriteRenderer` — pure data, plugs into `engine._renderingContexts`.
 * Inherits `clearColor`, `_drawCallsPre`, `_update`, `_record` from `RenderingContext`;
 * adds only its discriminator tag and the renderer-owned layer list.
 *
 * **Lifecycle.** A `SpriteRenderer` is independent of any `SceneContext` — it is
 * registered directly on the engine, opens its own sampleCount=1 swapchain pass, and
 * must be disposed by the caller. Two patterns:
 *
 *   1. **Standalone** (no scene, or one or more renderers alongside a scene):
 *      `registerSpriteRenderer` after `createSpriteRenderer`, `disposeSpriteRenderer`
 *      on shutdown. Caller owns the lifetime end-to-end.
 *   2. **HUD-on-3D** (renderer overlaid on a scene): same `register` step,
 *      then tie disposal to the scene with
 *      `onSceneDispose(scene, () => disposeSpriteRenderer(hud))` —
 *      `disposeScene` then cleans it up automatically. Register the renderer
 *      *after* `registerScene` so it draws on top.
 *
 * Scene 52 demonstrates pattern (2). For depth-hosted sprites that should
 * sort against 3D meshes, use `addDepthHostedSpriteLayer(scene, layer)` with
 * a depth-enabled `Sprite2DLayer` instead — that route is fully owned by the scene.
 */
export interface SpriteRenderer extends RenderingContext {
    /** @internal */
    readonly _kind: typeof KIND;
    /** Renderer-owned layer membership. Use `addSpriteRendererLayer` / `removeSpriteRendererLayer` to mutate. */
    readonly layers: readonly Sprite2DLayer[];
    /** @internal Mutable alias of {@link layers} — same array, used by internal helpers. */
    _layers: Sprite2DLayer[];
    /** @internal Surface this renderer draws into. */
    _surface: SurfaceContext;
    /** @internal */
    _indexBuffer: GPUBuffer;
    /** @internal */
    _pipelineCache: SpritePipelineCache;
    /** @internal */
    _layerGpu: Map<Sprite2DLayer, LayerGpu>;
    /** @internal Hooks run at the start of `_update`, before layer uploads. */
    _beforeUpdate: ((deltaMs: number) => void)[];
    /** @internal Cleanup callbacks run by `disposeSpriteRenderer`; optional integrations register here. */
    _disposeCallbacks: (() => void)[];
    /** @internal */
    _visibleBundles: GPURenderBundle[];
    /** @internal Captured each `_update`, read in `_record`. */
    _targetWidth: number;
    /** @internal */
    _targetHeight: number;
    /** @internal */
    _disposed: boolean;
    /** @internal Whether this pass clears the swapchain before drawing. False for HUD overlays. */
    _clear: boolean;
    /** @internal Offscreen color-attachment view to render into; null = the swapchain.
     *  Set via {@link setSpriteRendererTarget} (which takes a {@link Texture2D} target)
     *  for render-to-texture / post-process. */
    _targetView: GPUTextureView | null;
}

/** @internal Per-layer GPU resources owned by the renderer. */
interface LayerGpu {
    layer: Sprite2DLayer;
    instanceBuffer: GPUBuffer;
    instanceBufferCapacity: number;
    uniformBuffer: GPUBuffer;
    /** Built once per layer; the bind group binds the uniform buffer + atlas texture/sampler,
     *  none of which change after construction (atlas is `readonly` on the layer; uniform
     *  buffer is allocated once in `ensureLayerGpu`). Cleared if we ever recreate either. */
    bindGroup: GPUBindGroup | null;
    uploadedVersion: number;
    /** Opaque fx attachment (`SpriteFx` UBO, scratch, elapsed time); non-null only for `customShader` layers. */
    fx: SpriteLayerFx | null;
    /** Cached pipeline object. Refreshed when target-defining GPU state resolves to a different pipeline. */
    pipeline: GPURenderPipeline | null;
    /** Snapshot of the last UBO bytes written to `uniformBuffer`. We rebuild the UBO into
     *  `_scratchUbo` each frame, then `writeBuffer` only if the contents actually changed.
     *  For static scenes (steady-state) this skips one `queue.writeBuffer` per layer per frame. */
    lastUbo: Float32Array;
    /** False until the first UBO upload. Forces an unconditional first write so `lastUbo` is real. */
    uboUploaded: boolean;
    /** Pre-recorded GPU command bundle: `setIndexBuffer` + `setPipeline` + `setBindGroup` +
     *  `setVertexBuffer` + `drawIndexed`. Collected into a reused bundle array for
     *  near-zero per-frame CPU command-recording cost (the big WebGPU win for static scenes —
     *  see `scene-core.ts._record` for the same pattern). Invalidated when `layer.count` changes
     *  (the `drawIndexed` instance count is baked into the bundle) or when the instance buffer is
     *  reallocated by `ensureLayerGpu` (the bundle holds a GPUBuffer reference). The UBO contents
     *  may freely change frame-to-frame — the bundle binds the buffer *object*, not its bytes. */
    renderBundle: GPURenderBundle | null;
    /** `layer.count` value the cached `renderBundle` was recorded against. */
    bundleCount: number;
}

/**
 * Lazy GPU-resource provisioner for one layer. On first sight: allocates the per-instance
 * vertex buffer + the 48 B layer UBO and stashes a `LayerGpu` record in `_layerGpu`. On
 * subsequent calls where the layer's CPU `_capacity` outgrew the GPU buffer (after
 * `growCapacity` doubled the array): destroys + reallocates the instance buffer at the
 * new size and forces a full re-upload via `uploadedVersion = -1`. The bind group is
 * left intact — it doesn't reference the instance buffer (vertex buffers are bound
 * separately at draw time), only the uniform buffer + atlas, neither of which moves.
 */
function ensureLayerGpu(rr: SpriteRenderer, layer: Sprite2DLayer): LayerGpu {
    let lg = rr._layerGpu.get(layer);
    if (!lg) {
        const cap = layer._capacity;
        const instanceBuffer = createSpriteInstanceBuffer(rr._surface.engine._device, layer);
        const uniformBuffer = createEmptyUniformBuffer(rr._surface.engine, LAYER_UBO_BYTES);
        const fx = _getSpriteFxHook()?.createLayerFx(rr._surface.engine, "sprite-layer-fx-ubo", layer) ?? null;
        lg = {
            layer,
            instanceBuffer,
            instanceBufferCapacity: cap,
            uniformBuffer,
            bindGroup: null,
            uploadedVersion: -1,
            fx,
            pipeline: null,
            lastUbo: new F32(LAYER_UBO_BYTES / 4),
            uboUploaded: false,
            renderBundle: null,
            bundleCount: -1,
        };
        rr._layerGpu.set(layer, lg);
    }
    const grown = ensureSpriteInstanceBuffer(rr._surface.engine._device, layer, lg.instanceBuffer, lg.instanceBufferCapacity);
    if (grown.reallocated) {
        lg.instanceBuffer = grown.buffer;
        lg.instanceBufferCapacity = grown.capacity;
        lg.uploadedVersion = -1;
        // Bundle baked a reference to the *old* GPUBuffer; the new buffer needs a re-record.
        lg.renderBundle = null;
    }
    return lg;
}

/** Sync one layer's GPU state to its CPU state — instance vertex data + per-layer UBO.
 *  Both helpers are version-/dirty-gated and skip work in the steady state. */
function uploadLayer(rr: SpriteRenderer, lg: LayerGpu, deltaMs: number): void {
    const layer = lg.layer;
    lg.uploadedVersion = uploadSpriteInstances(rr._surface.engine._device, layer, lg.instanceBuffer, lg.uploadedVersion);
    buildSpriteLayerUbo(layer, rr._targetWidth, rr._targetHeight, _scratchUbo);
    lg.uboUploaded = writeSpriteLayerUboIfDirty(rr._surface.engine._device, lg.uniformBuffer, _scratchUbo, lg.lastUbo, lg.uboUploaded);
    if (lg.fx) {
        _getSpriteFxHook()!.updateFx(lg.fx, layer, deltaMs);
    }
}

function disposeLayerGpu(lg: LayerGpu): void {
    lg.instanceBuffer.destroy();
    lg.uniformBuffer.destroy();
    if (lg.fx) {
        _getSpriteFxHook()!.disposeFx(lg.fx);
    }
}

const _scratchUbo = new F32(LAYER_UBO_BYTES / 4);

/**
 * Build (and cache) the bind group that attaches `lg.uniformBuffer` + atlas texture +
 * sampler to the pipeline's sprite `@group(0)` schema. All three resources are immutable for
 * the layer's lifetime, so this runs at most once per layer; subsequent calls return
 * the cached group. The instance buffer is **not** in the bind group — it's a vertex
 * buffer, bound separately at draw time — which is why instance-buffer growth in
 * `ensureLayerGpu` doesn't invalidate this cache.
 */
function ensureBindGroup(rr: SpriteRenderer, lg: LayerGpu, pipeline: GPURenderPipeline): GPUBindGroup {
    if (lg.bindGroup) {
        return lg.bindGroup;
    }
    lg.bindGroup = createSpriteLayerBindGroup(rr._surface.engine, pipeline, 0, lg.layer, lg.uniformBuffer, lg.fx);
    return lg.bindGroup;
}

/** Sort key for layers within a renderer: ascending `order` (back-to-front draw order). */
function compareLayers(a: Sprite2DLayer, b: Sprite2DLayer): number {
    if (a.order !== b.order) {
        return a.order - b.order;
    }
    return 0;
}

/** Create a `SpriteRenderer` for `surface`, pre-warming pipelines for the layers' blend
 *  modes. Pass the engine directly for the common single-canvas case (since
 *  `EngineContext extends SurfaceContext`); pass an auxiliary surface created via
 *  `createSurface` for multi-canvas. */
export function createSpriteRenderer(surface: SurfaceContext, opts: SpriteRendererOptions): SpriteRenderer {
    const engine = surface.engine;
    assertSpriteRendererLayers(opts.layers);
    const indexBuffer = createMappedBuffer(engine, SHARED_SPRITE_INDEX_DATA, BU.INDEX);
    const canvas = surface.canvas;

    const layers = opts.layers.slice();
    const rr: SpriteRenderer = {
        _kind: KIND,
        _surface: surface,
        _indexBuffer: indexBuffer,
        _pipelineCache: createSpritePipelineCache(),
        _layerGpu: new Map(),
        _visibleBundles: [],
        _targetWidth: canvas.width,
        _targetHeight: canvas.height,
        _disposed: false,
        _clear: opts.clear ?? true,
        _targetView: null,
        _beforeUpdate: [],
        _disposeCallbacks: [],
        layers,
        _layers: layers,
        clearColor: opts.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _update(): void {
            spriteRendererUpdate(rr);
        },
        _record(): number {
            return spriteRendererRecord(rr);
        },
    };

    // Pre-warm pipelines currently in use, so the first frame doesn't pay compile cost.
    for (const layer of rr.layers) {
        getOrCreateSpritePipeline(engine, rr._pipelineCache, surface.format, 1, layer.blendMode, false, false, undefined, undefined, layer);
    }

    return rr;
}

function assertSpriteRendererLayers(layers: readonly Sprite2DLayer[]): void {
    for (const layer of layers) {
        assertSpriteRendererLayer(layer);
    }
}

function assertSpriteRendererLayer(layer: Sprite2DLayer): void {
    if (layer.depth !== "none") {
        throw new Error('SpriteRenderer requires depth: "none".');
    }
}

/**
 * Per-frame **update** pass (called by the engine before this renderer records its pass).
 * Refreshes target dims (canvas may have resized), sorts `rr.layers` in place by
 * `order` (TimSort is O(n) on already-sorted input — effectively free in steady state),
 * then walks every visible non-empty layer and runs `ensureLayerGpu` + `uploadLayer`.
 * No GPU draw work here — only buffer uploads via `writeBuffer`.
 */
function spriteRendererUpdate(rr: SpriteRenderer): void {
    if (rr._disposed) {
        return;
    }
    const deltaMs = rr._surface.engine._currentDelta ?? 0;
    for (const hook of rr._beforeUpdate) {
        hook(deltaMs);
    }
    assertSpriteRendererLayers(rr.layers);
    const targetSize = getRenderTargetSize(rr._surface);
    rr._targetWidth = targetSize.width;
    rr._targetHeight = targetSize.height;

    // Sort layers in place by `order` once per frame. TimSort is O(n) on already-sorted input,
    // so this is effectively free in the steady state. Documented side-effect on `rr.layers`
    // (registration order is not the ground truth — `layer.order` is). Skipped for the common
    // single-layer case to avoid even the comparator-call overhead.
    if (rr.layers.length > 1) {
        rr._layers.sort(compareLayers);
    }

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = ensureLayerGpu(rr, layer);
        uploadLayer(rr, lg, deltaMs);
    }
}

/**
 * Per-frame **record** pass (called by the engine after `_update`).
 * For each visible non-empty layer: builds (or reuses) a `GPURenderBundle` that bakes
 * `setIndexBuffer` + `setPipeline` + `setBindGroup` + `setVertexBuffer` + `drawIndexed`,
 * then queues it for a single `pass.executeBundles(...)` replay. The bundle is the per-frame
 * fast path — it skips Chromium's per-call WebGPU validation and IPC, which dominates
 * CPU cost for static scenes at multi-kHz framerates. Bundle is rebuilt only when
 * `layer.count` changes or the instance buffer was reallocated.
 * Returns one draw call per visible non-empty layer (1000 sprites in a layer = 1 draw
 * call thanks to instancing).
 */
function spriteRendererRecord(rr: SpriteRenderer): number {
    if (rr._disposed) {
        return 0;
    }
    assertSpriteRendererLayers(rr.layers);
    const eng = rr._surface.engine;
    const encoder = eng._currentEncoder;
    const swapView = rr._targetView ?? eng.scRT._colorView!;

    // Open a sampleCount=1 render pass on the target view (the swapchain by default, or an
    // offscreen render texture when one is set via setSpriteRendererTarget). This keeps HUD
    // sprites from resolving a fresh MSAA target over the already-rendered scene.
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
    const visibleBundles = rr._visibleBundles;
    visibleBundles.length = 0;

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = rr._layerGpu.get(layer);
        if (!lg) {
            continue;
        }
        const sampleCount = 1;
        const pipeline = getOrCreateSpritePipeline(
            rr._surface.engine,
            rr._pipelineCache,
            rr._surface.format,
            sampleCount,
            layer.blendMode,
            false,
            false,
            undefined,
            undefined,
            layer
        );
        if (lg.pipeline !== pipeline) {
            lg.pipeline = pipeline;
            lg.bindGroup = null;
            lg.renderBundle = null;
        }
        const bg = ensureBindGroup(rr, lg, pipeline);
        // (Re)record the bundle when count changes (drawIndexed instance count is baked in)
        // or when ensureLayerGpu reallocated the instance buffer (renderBundle was nulled).
        if (lg.renderBundle == null || lg.bundleCount !== layer.count) {
            const be = rr._surface.engine._device.createRenderBundleEncoder({
                colorFormats: [rr._surface.format],
                sampleCount,
            });
            be.setIndexBuffer(rr._indexBuffer, "uint16");
            be.setPipeline(pipeline);
            be.setBindGroup(0, bg);
            be.setVertexBuffer(0, lg.instanceBuffer);
            be.drawIndexed(6, layer.count, 0, 0, 0);
            lg.renderBundle = be.finish();
            lg.bundleCount = layer.count;
        }
        visibleBundles.push(lg.renderBundle!);
        drawCalls++;
    }

    if (visibleBundles.length > 0) {
        pass.executeBundles(visibleBundles);
    }
    pass.end();
    return drawCalls;
}

/** Add a pure-2D layer to the renderer. No-op if the layer is already present. */
export function addSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): void {
    if (sr._disposed) {
        throw new Error("SpriteRenderer has been disposed.");
    }
    assertSpriteRendererLayer(layer);
    if (sr.layers.includes(layer)) {
        return;
    }
    sr._layers.push(layer);
    getOrCreateSpritePipeline(sr._surface.engine, sr._pipelineCache, sr._surface.format, 1, layer.blendMode, false);
}

/** Remove a layer from the renderer and destroy any GPU resources cached for it. */
export function removeSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): boolean {
    const index = sr.layers.indexOf(layer);
    if (index < 0) {
        return false;
    }
    sr._layers.splice(index, 1);
    const lg = sr._layerGpu.get(layer);
    if (lg) {
        disposeLayerGpu(lg);
        sr._layerGpu.delete(layer);
    }
    return true;
}

/** Push the renderer onto its engine's `_renderingContexts`. Idempotent — a second call is a no-op. */
export function registerSpriteRenderer(sr: SpriteRenderer): void {
    registerRenderingContext(sr._surface, sr);
}

/**
 * Redirect a sprite renderer's output to an offscreen render {@link Texture2D} `target` (for
 * render-to-texture / post-processing), or pass `null` to render to the swapchain (the
 * default). Pair with {@link createRenderTexture2D} at its default format and the renderer's
 * target size. The target's texture must be the engine's swapchain format: sprite pipelines
 * are baked with `engine.format`, so a target of any OTHER format fails WebGPU validation at
 * render-pass begin. A second renderer can then sample that texture (e.g. a fullscreen
 * custom-shader layer) and present it. Renderers registered later run later, so register the
 * offscreen scene pass before the presenting pass.
 */
export function setSpriteRendererTarget(sr: SpriteRenderer, target: Texture2D | null): void {
    sr._targetView = target ? target.view : null;
}

/** Splice the renderer out of its engine's `_renderingContexts`. No-op if not present. */
export function unregisterSpriteRenderer(sr: SpriteRenderer): void {
    unregisterRenderingContext(sr._surface, sr);
}

/**
 * Destroy all GPU resources owned by the renderer, unregister it from the engine, and clear `layers`.
 * Idempotent. To tie disposal to a scene, call
 * `onSceneDispose(scene, () => disposeSpriteRenderer(sr))` after `registerSpriteRenderer` —
 * see the `SpriteRenderer` doc-comment.
 */
export function disposeSpriteRenderer(sr: SpriteRenderer): void {
    if (sr._disposed) {
        return;
    }
    unregisterSpriteRenderer(sr);
    sr._disposed = true;
    const disposeCallbacks = sr._disposeCallbacks.slice();
    sr._disposeCallbacks.length = 0;
    for (const dispose of disposeCallbacks) {
        dispose();
    }
    for (const lg of sr._layerGpu.values()) {
        disposeLayerGpu(lg);
    }
    sr._layerGpu.clear();
    sr._visibleBundles.length = 0;
    sr._beforeUpdate.length = 0;
    sr._indexBuffer.destroy();
    resetSpritePipelineCache(sr._pipelineCache);
    sr._layers.length = 0;
}

/** @internal Test-only accessor for pipeline-cache size. */
export function _spriteRendererPipelineCacheSize(sr: SpriteRenderer): number {
    return getSpritePipelineCacheSize(sr._pipelineCache, sr._surface.engine._device);
}
