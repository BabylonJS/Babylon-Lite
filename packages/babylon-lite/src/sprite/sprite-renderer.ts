/**
 * `SpriteRenderer` — owns the shared index buffer and per-layer GPU state
 * required to draw `Sprite2DLayer`s. Implements
 * `RenderingContext` directly, so it plugs into `engine._renderingContexts`
 * the same way a `SceneContext` does.
 *
 * PR 1 scope (intentionally minimal):
 *   - Pure-2D path only — no `SceneContext`, no camera, no lights.
 *   - One sprite-pipeline cache per renderer instance. PR 1 populates at
 *     most two keys (alpha + premultiplied), both with `hasDepth=0` and
 *     the engine's current format / MSAA sample count.
 *   - The renderer draws **into the engine's shared pass** — it does not
 *     own a render target. Off-screen / HUD-to-texture rendering and
 *     per-renderer MSAA / depth attachments are deferred to a later PR;
 *     the relevant fields will be re-added to `SpriteRendererOptions`
 *     when that work lands. See `docs/sprites/pr1-pure-2d-sprites-scope.md`.
 */
import { getRenderTargetSize, registerRenderingContext, unregisterRenderingContext } from "../engine/engine.js";
import type { EngineContext, EngineContextInternal, RenderingContext } from "../engine/engine.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import { INSTANCE_STRIDE_BYTES } from "./sprite-2d.js";
import {
    clearSpritePipelineCache,
    createSpriteLayerBindGroup,
    createSpritePipelineCache,
    getOrCreateSpritePipeline,
    getSpritePipelineCacheSize,
    isSpritePipelineEntryCurrent,
} from "./sprite-pipeline.js";
import type { SpritePipelineCache, SpritePipelineEntry } from "./sprite-pipeline.js";

/** Tag used by the engine and by tests to identify a sprite renderer. */
const KIND = "sprite-renderer" as const;

/** Options accepted by `createSpriteRenderer`. */
export interface SpriteRendererOptions {
    /** Layers to draw, in registration order. The renderer also re-sorts internally each frame. */
    layers: Sprite2DLayer[];
    /** Default `{ r: 0, g: 0, b: 0, a: 1 }`. */
    clearValue?: GPUColorDict;
}

/**
 * A `SpriteRenderer` — pure data, plugs into `engine._renderingContexts`.
 * Inherits `clearColor`, `_drawCallsPre`, `_update`, `_record` from `RenderingContext`;
 * adds only its discriminator tag and the mutable layer list.
 */
export interface SpriteRenderer extends RenderingContext {
    readonly _kind: typeof KIND;
    /** Mutable: callers may push / splice layers between frames. */
    layers: Sprite2DLayer[];
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
    /** Cached pipeline entry. Built lazily on first frame; never invalidated because blend mode
     *  is immutable on a `Sprite2DLayer`. Lets `_record` skip the per-frame pipeline-cache lookup. */
    pipelineEntry: SpritePipelineEntry | null;
    /** Snapshot of the last UBO bytes written to `uniformBuffer`. We rebuild the UBO into
     *  `_scratchUbo` each frame, then `writeBuffer` only if the contents actually changed.
     *  For static scenes (steady-state) this skips one `queue.writeBuffer` per layer per frame. */
    lastUbo: Float32Array;
    /** False until the first UBO upload. Forces an unconditional first write so `lastUbo` is real. */
    uboUploaded: boolean;
    /** Pre-recorded GPU command bundle: `setIndexBuffer` + `setPipeline` + `setBindGroup` +
     *  `setVertexBuffer` + `drawIndexed`. Replayed via `pass.executeBundles([bundle])` for
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
    /** Captured each `_update`, read in `_record`. */
    _targetWidth: number;
    _targetHeight: number;
    _disposed: boolean;
}

const LAYER_UBO_BYTES = 48;
const SHARED_INDEX_DATA: Readonly<Uint16Array> = new Uint16Array([0, 1, 2, 0, 2, 3]);

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
        const instanceBuffer = rr._engine.device.createBuffer({
            size: cap * INSTANCE_STRIDE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        const uniformBuffer = createEmptyUniformBuffer(rr._engine, LAYER_UBO_BYTES, "sprite-layer-ubo");
        lg = {
            layer,
            instanceBuffer,
            instanceBufferCapacity: cap,
            uniformBuffer,
            bindGroup: null,
            uploadedVersion: -1,
            pipelineEntry: null,
            lastUbo: new Float32Array(LAYER_UBO_BYTES / 4),
            uboUploaded: false,
            renderBundle: null,
            bundleCount: -1,
        };
        rr._layerGpu.set(layer, lg);
    }
    if (lg.instanceBufferCapacity < layer._capacity) {
        lg.instanceBuffer.destroy();
        lg.instanceBuffer = rr._engine.device.createBuffer({
            size: layer._capacity * INSTANCE_STRIDE_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        lg.instanceBufferCapacity = layer._capacity;
        lg.uploadedVersion = -1;
        // Bundle baked a reference to the *old* GPUBuffer; the new buffer needs a re-record.
        lg.renderBundle = null;
    }
    return lg;
}

/**
 * Sync one layer's GPU state to its CPU state. Two uploads, two strategies:
 *  1. **Per-instance vertex data** — version-gated and incremental: skip if `_version`
 *     unchanged; otherwise upload `[0, count)` on first sight (`uploadedVersion === -1`)
 *     or just `[_dirtyMin, min(_dirtyMax, count))` on subsequent edits. Resets the dirty
 *     range and bumps `uploadedVersion` after upload.
 *  2. **Per-layer UBO** — always rewrites all 48 B. The view (camera) and target dims
 *     can change without going through any setter, so version-tracking would buy nothing.
 *     Tiny (one `writeBuffer`), so unconditional is simpler than dirty-tracking.
 */
function uploadLayer(rr: SpriteRendererInternal, lg: LayerGpu): void {
    const layer = lg.layer;
    if (lg.uploadedVersion !== layer._version && layer.count > 0) {
        // First sight (or post-grow `uploadedVersion = -1`): upload the whole live range.
        // Subsequent: upload only the dirty span, clamped to live count (a `remove` may have
        // marked a slot beyond `count` as dirty; that data is no longer live).
        let lo: number;
        let hi: number;
        if (lg.uploadedVersion === -1) {
            lo = 0;
            hi = layer.count;
        } else {
            lo = layer._dirtyMin;
            hi = Math.min(layer._dirtyMax, layer.count);
        }
        if (hi > lo) {
            const offsetBytes = lo * INSTANCE_STRIDE_BYTES;
            const bytes = (hi - lo) * INSTANCE_STRIDE_BYTES;
            rr._engine.device.queue.writeBuffer(lg.instanceBuffer, offsetBytes, layer._instanceData.buffer, layer._instanceData.byteOffset + offsetBytes, bytes);
        }
        layer._dirtyMin = 0;
        layer._dirtyMax = 0;
        lg.uploadedVersion = layer._version;
    }

    // Layer UBO — small + cheap, but every `queue.writeBuffer` walks the WebGPU validation
    // layer, so we change-detect: build into `_scratchUbo`, compare to the per-layer
    // `lastUbo` snapshot, and only upload when something actually changed. For static
    // layers (steady-state) this skips one `queue.writeBuffer` per layer per frame.
    // Float layout matches the WGSL `Layer` struct (48 B total, 12 floats):
    //   [0..1]  viewPos.xy   [2] viewScale   [3] viewRot
    //   [4..5]  screenSize.xy   [6..7] pivot.xy
    //   [8..11] opacityMul.rgba  (per-blend-mode pre-shaped, see WGSL `Layer` struct)
    const ubo = _scratchUbo;
    ubo[0] = layer.view.positionPx[0];
    ubo[1] = layer.view.positionPx[1];
    ubo[2] = layer.view.zoom;
    ubo[3] = layer.view.rotation;
    ubo[4] = rr._targetWidth;
    ubo[5] = rr._targetHeight;
    ubo[6] = layer.pivot[0];
    ubo[7] = layer.pivot[1];
    // Premultiplied sources need RGB *and* A scaled by opacity for a correct fade;
    // straight-alpha needs only A scaled (the blend stage already uses src.a as the factor).
    const op = layer.opacity;
    if (layer.blendMode === "premultiplied") {
        ubo[8] = op;
        ubo[9] = op;
        ubo[10] = op;
        ubo[11] = op;
    } else {
        ubo[8] = 1;
        ubo[9] = 1;
        ubo[10] = 1;
        ubo[11] = op;
    }
    const last = lg.lastUbo;
    let dirty = !lg.uboUploaded;
    if (!dirty) {
        for (let i = 0; i < 12; i++) {
            if (last[i] !== ubo[i]) {
                dirty = true;
                break;
            }
        }
    }
    if (dirty) {
        rr._engine.device.queue.writeBuffer(lg.uniformBuffer, 0, ubo.buffer, ubo.byteOffset, LAYER_UBO_BYTES);
        last.set(ubo);
        lg.uboUploaded = true;
    }
}

const _scratchUbo = new Float32Array(LAYER_UBO_BYTES / 4);

/**
 * Build (and cache) the bind group that attaches `lg.uniformBuffer` + atlas texture +
 * sampler to the pipeline's `@group(0)` schema. All three resources are immutable for
 * the layer's lifetime, so this runs at most once per layer; subsequent calls return
 * the cached group. The instance buffer is **not** in the bind group — it's a vertex
 * buffer, bound separately at draw time — which is why instance-buffer growth in
 * `ensureLayerGpu` doesn't invalidate this cache.
 */
function ensureBindGroup(rr: SpriteRendererInternal, lg: LayerGpu, entry: SpritePipelineEntry): GPUBindGroup {
    if (lg.bindGroup) {
        return lg.bindGroup;
    }
    lg.bindGroup = createSpriteLayerBindGroup(rr._engine, entry, lg.layer, lg.uniformBuffer);
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
    const eng = engine as EngineContextInternal;
    const indexBuffer = createMappedBuffer(eng, SHARED_INDEX_DATA, GPUBufferUsage.INDEX);
    const targetSize = getRenderTargetSize(eng);

    const rr: SpriteRendererInternal = {
        _kind: KIND,
        _engine: eng,
        _indexBuffer: indexBuffer,
        _pipelineCache: createSpritePipelineCache(),
        _layerGpu: new Map(),
        _targetWidth: targetSize.width,
        _targetHeight: targetSize.height,
        _disposed: false,
        layers: opts.layers.slice(),
        clearColor: opts.clearValue ?? { r: 0, g: 0, b: 0, a: 1 },
        _drawCallsPre: 0,
        _update(encoder: GPUCommandEncoder, _deltaMs: number): GPUCommandEncoder {
            spriteRendererUpdate(rr, encoder);
            return encoder;
        },
        _record(pass: GPURenderPassEncoder): number {
            return spriteRendererRecord(rr, pass);
        },
    };

    // Pre-warm pipelines currently in use, so the first frame doesn't pay compile cost.
    for (const layer of rr.layers) {
        getOrCreateSpritePipeline(rr._engine, rr._pipelineCache, layer.blendMode, false);
    }

    return rr;
}

/**
 * Per-frame **update** pass (called by the engine before the render pass opens).
 * Refreshes target dims (canvas may have resized), sorts `rr.layers` in place by
 * `order` (TimSort is O(n) on already-sorted input — effectively free in steady state),
 * then walks every visible non-empty layer and runs `ensureLayerGpu` + `uploadLayer`.
 * No GPU draw work here — only buffer uploads via `writeBuffer`.
 */
function spriteRendererUpdate(rr: SpriteRendererInternal, _encoder: GPUCommandEncoder): void {
    if (rr._disposed) {
        return;
    }
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
 * Per-frame **record** pass (called by the engine inside the open render pass).
 * For each visible non-empty layer: builds (or reuses) a `GPURenderBundle` that bakes
 * `setIndexBuffer` + `setPipeline` + `setBindGroup` + `setVertexBuffer` + `drawIndexed`,
 * then replays it via `pass.executeBundles([bundle])`. The bundle is the per-frame
 * fast path — it skips Chromium's per-call WebGPU validation and IPC, which dominates
 * CPU cost for static scenes at multi-kHz framerates. Bundle is rebuilt only when
 * `layer.count` changes or the instance buffer was reallocated.
 * Returns one draw call per visible non-empty layer (1000 sprites in a layer = 1 draw
 * call thanks to instancing).
 */
function spriteRendererRecord(rr: SpriteRendererInternal, pass: GPURenderPassEncoder): number {
    if (rr._disposed) {
        return 0;
    }
    let drawCalls = 0;

    for (const layer of rr.layers) {
        if (!layer.visible || layer.count === 0) {
            continue;
        }
        const lg = rr._layerGpu.get(layer);
        if (!lg) {
            continue;
        }
        // Cache on the `LayerGpu` so `_record` does no Map lookup or hash-key compute
        // in the steady state; refresh if the engine's pipeline-defining GPU state changes.
        let entry = lg.pipelineEntry;
        if (!entry || !isSpritePipelineEntryCurrent(rr._engine, entry)) {
            entry = getOrCreateSpritePipeline(rr._engine, rr._pipelineCache, layer.blendMode, false);
            lg.pipelineEntry = entry;
            lg.bindGroup = null;
            lg.renderBundle = null;
        }
        const bg = ensureBindGroup(rr, lg, entry);
        // (Re)record the bundle when count changes (drawIndexed instance count is baked in)
        // or when ensureLayerGpu reallocated the instance buffer (renderBundle was nulled).
        if (lg.renderBundle == null || lg.bundleCount !== layer.count) {
            const be = rr._engine.device.createRenderBundleEncoder({
                colorFormats: [rr._engine.format],
                depthStencilFormat: "depth24plus-stencil8",
                sampleCount: rr._engine.msaaSamples,
            });
            be.setIndexBuffer(rr._indexBuffer, "uint16");
            be.setPipeline(entry.pipeline);
            be.setBindGroup(0, bg);
            be.setVertexBuffer(0, lg.instanceBuffer);
            be.drawIndexed(6, layer.count, 0, 0, 0);
            lg.renderBundle = be.finish();
            lg.bundleCount = layer.count;
        }
        pass.executeBundles([lg.renderBundle]);
        drawCalls++;
    }

    return drawCalls;
}

/** Push the renderer onto its engine's `_renderingContexts`. Idempotent — a second call is a no-op. */
export function registerSpriteRenderer(sr: SpriteRenderer): void {
    registerRenderingContext((sr as SpriteRendererInternal)._engine, sr);
}

/** Splice the renderer out of its engine's `_renderingContexts`. No-op if not present. */
export function unregisterSpriteRenderer(sr: SpriteRenderer): void {
    unregisterRenderingContext((sr as SpriteRendererInternal)._engine, sr);
}

/** Destroy all GPU resources owned by the renderer, unregister it from the engine, and clear `layers`. */
export function disposeSpriteRenderer(sr: SpriteRenderer): void {
    const rr = sr as SpriteRendererInternal;
    if (rr._disposed) {
        return;
    }
    unregisterSpriteRenderer(rr);
    rr._disposed = true;
    for (const lg of rr._layerGpu.values()) {
        lg.instanceBuffer.destroy();
        lg.uniformBuffer.destroy();
    }
    rr._layerGpu.clear();
    rr._indexBuffer.destroy();
    clearSpritePipelineCache(rr._pipelineCache);
    rr.layers.length = 0;
}

/** @internal Test-only accessor for pipeline-cache size. */
export function _spriteRendererPipelineCacheSize(sr: SpriteRenderer): number {
    return getSpritePipelineCacheSize((sr as SpriteRendererInternal)._pipelineCache);
}
