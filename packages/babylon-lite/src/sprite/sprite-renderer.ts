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
import { getRenderTargetSize, registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { EngineContext, EngineContextInternal, RenderingContext } from "../engine/engine.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import {
    LAYER_UBO_BYTES,
    SHARED_SPRITE_INDEX_DATA,
    buildSpriteLayerUbo,
    clearSpritePipelineCache,
    createSpriteInstanceBuffer,
    createSpriteLayerBindGroup,
    createSpritePipelineCache,
    ensureSpriteInstanceBuffer,
    getOrCreateSpritePipeline,
    getSpritePipelineCacheSize,
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
    readonly _kind: typeof KIND;
    /** Renderer-owned layer membership. Use `addSpriteRendererLayer` / `removeSpriteRendererLayer` to mutate. */
    readonly layers: readonly Sprite2DLayer[];
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

interface SpriteRendererInternal extends SpriteRenderer {
    _engine: EngineContextInternal;
    _indexBuffer: GPUBuffer;
    _pipelineCache: SpritePipelineCache;
    _layerGpu: Map<Sprite2DLayer, LayerGpu>;
    layers: Sprite2DLayer[];
    _visibleBundles: GPURenderBundle[];
    /** Captured each `_update`, read in `_record`. */
    _targetWidth: number;
    _targetHeight: number;
    _disposed: boolean;
    /** Whether this pass clears the swapchain before drawing. False for HUD overlays. */
    _clear: boolean;
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
function ensureLayerGpu(rr: SpriteRendererInternal, layer: Sprite2DLayer): LayerGpu {
    let lg = rr._layerGpu.get(layer);
    if (!lg) {
        const cap = layer._capacity;
        const instanceBuffer = createSpriteInstanceBuffer(rr._engine.device, layer, "sprite-layer-instances");
        const uniformBuffer = createEmptyUniformBuffer(rr._engine, LAYER_UBO_BYTES, "sprite-layer-ubo");
        lg = {
            layer,
            instanceBuffer,
            instanceBufferCapacity: cap,
            uniformBuffer,
            bindGroup: null,
            uploadedVersion: -1,
            pipeline: null,
            lastUbo: new Float32Array(LAYER_UBO_BYTES / 4),
            uboUploaded: false,
            renderBundle: null,
            bundleCount: -1,
        };
        rr._layerGpu.set(layer, lg);
    }
    const grown = ensureSpriteInstanceBuffer(rr._engine.device, layer, lg.instanceBuffer, lg.instanceBufferCapacity, "sprite-layer-instances");
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
function uploadLayer(rr: SpriteRendererInternal, lg: LayerGpu): void {
    const layer = lg.layer;
    lg.uploadedVersion = uploadSpriteInstances(rr._engine.device, layer, lg.instanceBuffer, lg.uploadedVersion);
    buildSpriteLayerUbo(layer, rr._targetWidth, rr._targetHeight, _scratchUbo);
    lg.uboUploaded = writeSpriteLayerUboIfDirty(rr._engine.device, lg.uniformBuffer, _scratchUbo, lg.lastUbo, lg.uboUploaded);
}

function disposeLayerGpu(lg: LayerGpu): void {
    lg.instanceBuffer.destroy();
    lg.uniformBuffer.destroy();
}

const _scratchUbo = new Float32Array(LAYER_UBO_BYTES / 4);

/**
 * Build (and cache) the bind group that attaches `lg.uniformBuffer` + atlas texture +
 * sampler to the pipeline's sprite `@group(0)` schema. All three resources are immutable for
 * the layer's lifetime, so this runs at most once per layer; subsequent calls return
 * the cached group. The instance buffer is **not** in the bind group — it's a vertex
 * buffer, bound separately at draw time — which is why instance-buffer growth in
 * `ensureLayerGpu` doesn't invalidate this cache.
 */
function ensureBindGroup(rr: SpriteRendererInternal, lg: LayerGpu, pipeline: GPURenderPipeline): GPUBindGroup {
    if (lg.bindGroup) {
        return lg.bindGroup;
    }
    lg.bindGroup = createSpriteLayerBindGroup(rr._engine, pipeline, 0, lg.layer, lg.uniformBuffer);
    return lg.bindGroup;
}

/** Sort key for layers within a renderer: ascending `order` (back-to-front draw order). */
function compareLayers(a: Sprite2DLayer, b: Sprite2DLayer): number {
    if (a.order !== b.order) {
        return a.order - b.order;
    }
    return 0;
}

/** Create a `SpriteRenderer` for `engine`, pre-warming pipelines for the layers' blend modes. */
export function createSpriteRenderer(engine: EngineContext, opts: SpriteRendererOptions): SpriteRenderer {
    assertSpriteRendererLayers(opts.layers);
    const eng = engine as EngineContextInternal;
    const indexBuffer = createMappedBuffer(eng, SHARED_SPRITE_INDEX_DATA, GPUBufferUsage.INDEX);
    const targetSize = getRenderTargetSize(eng);

    const rr: SpriteRendererInternal = {
        _kind: KIND,
        _engine: eng,
        _indexBuffer: indexBuffer,
        _pipelineCache: createSpritePipelineCache(),
        _layerGpu: new Map(),
        _visibleBundles: [],
        _targetWidth: targetSize.width,
        _targetHeight: targetSize.height,
        _disposed: false,
        _clear: opts.clear ?? true,
        layers: opts.layers.slice(),
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
        getOrCreateSpritePipeline(rr._engine, rr._pipelineCache, rr._engine.format, 1, layer.blendMode, false);
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
        throw new Error('SpriteRenderer only supports Sprite2DLayer with depth: "none". Use addDepthHostedSpriteLayer(scene, layer) for depth-hosted sprites.');
    }
}

/**
 * Per-frame **update** pass (called by the engine before this renderer records its pass).
 * Refreshes target dims (canvas may have resized), sorts `rr.layers` in place by
 * `order` (TimSort is O(n) on already-sorted input — effectively free in steady state),
 * then walks every visible non-empty layer and runs `ensureLayerGpu` + `uploadLayer`.
 * No GPU draw work here — only buffer uploads via `writeBuffer`.
 */
function spriteRendererUpdate(rr: SpriteRendererInternal): void {
    if (rr._disposed) {
        return;
    }
    assertSpriteRendererLayers(rr.layers);
    const targetSize = getRenderTargetSize(rr._engine);
    rr._targetWidth = targetSize.width;
    rr._targetHeight = targetSize.height;

    // Sort layers in place by `order` once per frame. TimSort is O(n) on already-sorted input,
    // so this is effectively free in the steady state. Documented side-effect on `rr.layers`
    // (registration order is not the ground truth — `layer.order` is). Skipped for the common
    // single-layer case to avoid even the comparator-call overhead.
    if (rr.layers.length > 1) {
        rr.layers.sort(compareLayers);
    }

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = ensureLayerGpu(rr, layer);
        uploadLayer(rr, lg);
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
function spriteRendererRecord(rr: SpriteRendererInternal): number {
    if (rr._disposed) {
        return 0;
    }
    assertSpriteRendererLayers(rr.layers);
    const eng = rr._engine;
    const encoder = eng._currentEncoder;
    const swapView = eng._swapchainView;

    // Open a sampleCount=1 render pass directly on the swapchain. This keeps HUD
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
        const pipeline = getOrCreateSpritePipeline(rr._engine, rr._pipelineCache, rr._engine.format, sampleCount, layer.blendMode, false);
        if (lg.pipeline !== pipeline) {
            lg.pipeline = pipeline;
            lg.bindGroup = null;
            lg.renderBundle = null;
        }
        const bg = ensureBindGroup(rr, lg, pipeline);
        // (Re)record the bundle when count changes (drawIndexed instance count is baked in)
        // or when ensureLayerGpu reallocated the instance buffer (renderBundle was nulled).
        if (lg.renderBundle == null || lg.bundleCount !== layer.count) {
            const be = rr._engine.device.createRenderBundleEncoder({
                colorFormats: [rr._engine.format],
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
    const rr = sr as SpriteRendererInternal;
    if (rr._disposed) {
        throw new Error("SpriteRenderer has been disposed.");
    }
    assertSpriteRendererLayer(layer);
    if (rr.layers.includes(layer)) {
        return;
    }
    rr.layers.push(layer);
    getOrCreateSpritePipeline(rr._engine, rr._pipelineCache, rr._engine.format, 1, layer.blendMode, false);
}

/** Remove a layer from the renderer and destroy any GPU resources cached for it. */
export function removeSpriteRendererLayer(sr: SpriteRenderer, layer: Sprite2DLayer): boolean {
    const rr = sr as SpriteRendererInternal;
    const index = rr.layers.indexOf(layer);
    if (index < 0) {
        return false;
    }
    rr.layers.splice(index, 1);
    const lg = rr._layerGpu.get(layer);
    if (lg) {
        disposeLayerGpu(lg);
        rr._layerGpu.delete(layer);
    }
    return true;
}

/** Push the renderer onto its engine's `_renderingContexts`. Idempotent — a second call is a no-op. */
export function registerSpriteRenderer(sr: SpriteRenderer): void {
    registerRenderingContext((sr as SpriteRendererInternal)._engine, sr);
}

/** Splice the renderer out of its engine's `_renderingContexts`. No-op if not present. */
export function unregisterSpriteRenderer(sr: SpriteRenderer): void {
    unregisterRenderingContext((sr as SpriteRendererInternal)._engine, sr);
}

/**
 * Destroy all GPU resources owned by the renderer, unregister it from the engine, and clear `layers`.
 * Idempotent. To tie disposal to a scene, call
 * `onSceneDispose(scene, () => disposeSpriteRenderer(sr))` after `registerSpriteRenderer` —
 * see the `SpriteRenderer` doc-comment.
 */
export function disposeSpriteRenderer(sr: SpriteRenderer): void {
    const rr = sr as SpriteRendererInternal;
    if (rr._disposed) {
        return;
    }
    unregisterSpriteRenderer(rr);
    rr._disposed = true;
    for (const lg of rr._layerGpu.values()) {
        disposeLayerGpu(lg);
    }
    rr._layerGpu.clear();
    rr._visibleBundles.length = 0;
    rr._indexBuffer.destroy();
    clearSpritePipelineCache(rr._pipelineCache);
    rr.layers.length = 0;
}

/** @internal Test-only accessor for pipeline-cache size. */
export function _spriteRendererPipelineCacheSize(sr: SpriteRenderer): number {
    return getSpritePipelineCacheSize((sr as SpriteRendererInternal)._pipelineCache);
}
