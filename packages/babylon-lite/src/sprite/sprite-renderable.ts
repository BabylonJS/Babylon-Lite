/**
 * `sprite-renderable.ts` — wraps a single depth-hosted `Sprite2DLayer`
 * (`depth: "test"` or `"test-write"`) as a scene `Renderable`. Drawn inside
 * the scene's main 3D pass alongside meshes, so it participates in the
 * engine's depth attachment and gets occluded by (or occludes) regular
 * geometry based on its `layerZ`.
 *
 * Reached through `addDepthHostedSpriteLayer` when a depth-hosted `Sprite2DLayer`
 * is added to a scene. Pure-2D scenes and mesh-only scenes pay zero runtime bytes
 * for this module when the depth-hosted sprite API is not imported.
 *
 * Per-layer GPU work (instance / UBO upload, capacity grow, change-detect)
 * is shared with `sprite-renderer.ts` via helpers in `sprite-pipeline.ts`.
 * Each renderable still owns its own GPU resources (one layer per renderable
 * vs. the renderer's many-layer Map) — only the per-frame sync logic is
 * shared.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { Sprite2DLayer } from "./sprite-2d.js";
import {
    LAYER_UBO_BYTES,
    SHARED_SPRITE_INDEX_DATA,
    buildSpriteLayerUbo,
    createSpriteInstanceBuffer,
    createSpriteLayerBindGroup,
    createSpritePipelineCache,
    ensureSpriteInstanceBuffer,
    getOrCreateSpritePipeline,
    resetSpritePipelineCache,
    uploadSpriteInstances,
    writeSpriteLayerUboIfDirty,
} from "./sprite-pipeline.js";
import type { SpritePipelineCache } from "./sprite-pipeline.js";

// Shared sprite pipeline cache across every depth-hosted Sprite2DLayer renderable
// in the process. Lazy-init on first acquire (per GUIDANCE §4 — module-level
// `null` initializer + `getCache()`-style helper, never a top-level `new Map()`).
// Refcounted so the cache (and its compiled GPUShaderModule + pipelines) is
// released exactly when the last depth-hosted renderable is disposed; device
// changes are handled inside `getOrCreateSpritePipeline` via its per-device cache.
// The SpriteRenderer (HUD) path uses its own per-renderer cache.
let _sharedPipelineCache: SpritePipelineCache | null = null;
let _sharedPipelineCacheRefs = 0;

function acquireSharedPipelineCache(): SpritePipelineCache {
    _sharedPipelineCache ??= createSpritePipelineCache();
    _sharedPipelineCacheRefs++;
    return _sharedPipelineCache;
}

function releaseSharedPipelineCache(): void {
    if (_sharedPipelineCacheRefs === 0) {
        return;
    }
    _sharedPipelineCacheRefs--;
    if (_sharedPipelineCacheRefs === 0 && _sharedPipelineCache) {
        resetSpritePipelineCache(_sharedPipelineCache);
        _sharedPipelineCache = null;
    }
}

interface SpriteRenderableInternal extends Renderable {
    _engine: EngineContextInternal;
    _layer: Sprite2DLayer;
    _indexBuffer: GPUBuffer;
    _uniformBuffer: GPUBuffer;
    _instanceBuffer: GPUBuffer;
    _instanceBufferCapacity: number;
    _pipelineCache: SpritePipelineCache;
    _bindGroups: Map<GPURenderPipeline, GPUBindGroup>;
    _uploadedVersion: number;
    _uboUploaded: boolean;
    _lastUbo: Float32Array;
    _scratchUbo: Float32Array;
    _disposed: boolean;
}

/**
 * Build a `Renderable` for a depth-hosted `Sprite2DLayer`. Returns the
 * renderable plus a `dispose` callback that destroys all per-layer GPU
 * resources and clears the pipeline cache.
 *
 * Throws if `layer.depth === "none"` — pure-2D HUD layers must be rendered
 * via `createSpriteRenderer + registerSpriteRenderer`, not as a scene
 * `Renderable`. The check lives here as a second line of defense; the public
 * opt-in scene add function also rejects pure HUD layers before registration.
 *
 * Caller is responsible for
 * pushing `renderable` into `_renderables` and `dispose` into `_disposables`.
 */
export function buildSpriteRenderable(engine: EngineContextInternal, layer: Sprite2DLayer): { renderable: Renderable; dispose: () => void } {
    if (layer.depth === "none") {
        throw new Error('Sprite2DLayer with depth: "none" must be rendered via createSpriteRenderer, not addDepthHostedSpriteLayer.');
    }
    const indexBuffer = createMappedBuffer(engine, SHARED_SPRITE_INDEX_DATA, GPUBufferUsage.INDEX);
    const uniformBuffer = createEmptyUniformBuffer(engine, LAYER_UBO_BYTES, "sprite-depth-hosted-ubo");
    const cap = layer._capacity;
    const instanceBuffer = createSpriteInstanceBuffer(engine.device, layer, "sprite-depth-hosted-instances");

    const isTransparent = layer.depth === "test";
    const isDirect = layer.depth === "test-write";
    const renderable: SpriteRenderableInternal = {
        // Depth-write sprite layers are mutable instanced batches, so route them through
        // the direct-draw phase after cached opaque meshes and before transparent draws.
        order: isTransparent ? 200 : 100,
        isTransparent,
        _direct: isDirect,
        _engine: engine,
        _layer: layer,
        _indexBuffer: indexBuffer,
        _uniformBuffer: uniformBuffer,
        _instanceBuffer: instanceBuffer,
        _instanceBufferCapacity: cap,
        _pipelineCache: acquireSharedPipelineCache(),
        _bindGroups: new Map(),
        _uploadedVersion: -1,
        _uboUploaded: false,
        _lastUbo: new Float32Array(LAYER_UBO_BYTES / 4),
        _scratchUbo: new Float32Array(LAYER_UBO_BYTES / 4),
        _disposed: false,
        bind(engine, target) {
            return bindLayer(renderable, engine as EngineContextInternal, target);
        },
    };

    return {
        renderable,
        dispose() {
            disposeRenderable(renderable);
        },
    };
}

/** Resolve this sprite layer against a render-pass target and return the per-frame draw binding. */
function bindLayer(r: SpriteRenderableInternal, engine: EngineContextInternal, target: RenderTargetSignature): DrawBinding {
    if (!target.depthStencilFormat) {
        throw new Error("Depth-hosted Sprite2DLayer requires a depth-stencil render target.");
    }
    const sampleCount = target.sampleCount === 1 ? 1 : 4;
    const depthWrite = r._layer.depth === "test-write";
    const pipeline = getOrCreateSpritePipeline(
        engine,
        r._pipelineCache,
        target.colorFormat!,
        sampleCount,
        r._layer.blendMode,
        true,
        depthWrite,
        target.depthStencilFormat,
        getSceneBindGroupLayout(engine)
    );
    let bindGroup = r._bindGroups.get(pipeline);
    if (!bindGroup) {
        bindGroup = createSpriteLayerBindGroup(engine, pipeline, 1, r._layer, r._uniformBuffer);
        r._bindGroups.set(pipeline, bindGroup);
    }
    return {
        renderable: r,
        pipeline,
        update(context) {
            uploadLayer(r, context);
        },
        draw(pass) {
            return drawLayer(r, bindGroup, pass);
        },
    };
}

/** Sync per-instance vertex data and the per-layer UBO via the shared pipeline helpers. */
function uploadLayer(r: SpriteRenderableInternal, target: DrawUpdateContext): void {
    if (r._disposed || !r._layer.visible || r._layer.count === 0) {
        return;
    }
    const grown = ensureSpriteInstanceBuffer(r._engine.device, r._layer, r._instanceBuffer, r._instanceBufferCapacity, "sprite-depth-hosted-instances");
    if (grown.reallocated) {
        r._instanceBuffer = grown.buffer;
        r._instanceBufferCapacity = grown.capacity;
        r._uploadedVersion = -1;
    }
    r._uploadedVersion = uploadSpriteInstances(r._engine.device, r._layer, r._instanceBuffer, r._uploadedVersion);
    buildSpriteLayerUbo(r._layer, target.targetWidth, target.targetHeight, r._scratchUbo);
    r._uboUploaded = writeSpriteLayerUboIfDirty(r._engine.device, r._uniformBuffer, r._scratchUbo, r._lastUbo, r._uboUploaded);
}

/** Issue the indexed instanced draw for this depth-hosted sprite layer. */
function drawLayer(r: SpriteRenderableInternal, bindGroup: GPUBindGroup, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (r._disposed || !r._layer.visible || r._layer.count === 0) {
        return 0;
    }
    pass.setBindGroup(1, bindGroup);
    pass.setIndexBuffer(r._indexBuffer, "uint16");
    pass.setVertexBuffer(0, r._instanceBuffer);
    pass.drawIndexed(6, r._layer.count, 0, 0, 0);
    return 1;
}

function disposeRenderable(r: SpriteRenderableInternal): void {
    if (r._disposed) {
        return;
    }
    r._disposed = true;
    r._instanceBuffer.destroy();
    r._uniformBuffer.destroy();
    r._indexBuffer.destroy();
    r._bindGroups.clear();
    // Drop the layer back-reference so a disposed renderable doesn't keep the
    // user's Sprite2DLayer (and its CPU instance/savedSize buffers) alive.
    // Cast through unknown — the field is non-null in the live path; only
    // disposed renderables (no longer touched by render code) ever see null.
    (r as unknown as { _layer: Sprite2DLayer | null })._layer = null;
    releaseSharedPipelineCache();
}
