/**
 * `sprite-renderable.ts` — wraps a single depth-hosted `Sprite2DLayer`
 * (`depth: "test"` or `"test-write"`) as a scene `Renderable`. Drawn inside
 * the scene's main 3D pass alongside meshes, so it participates in the
 * engine's depth attachment and gets occluded by (or occludes) regular
 * geometry based on its `layerZ`.
 *
 * Loaded only by `addToScene` when a `Sprite2DLayer` is added to a scene.
 * Pure-2D scenes and mesh-only scenes pay zero runtime bytes for this module.
 *
 * Per-layer GPU work (instance / UBO upload, capacity grow, change-detect)
 * is shared with `sprite-renderer.ts` via helpers in `sprite-pipeline.ts`.
 * Each renderable still owns its own GPU resources (one layer per renderable
 * vs. the renderer's many-layer Map) — only the per-frame sync logic is
 * shared.
 */

import type { EngineContextInternal } from "../engine/engine.js";
import { getRenderTargetSize } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, Renderable } from "../render/renderable.js";
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
    isSpritePipelineEntryCurrent,
    uploadSpriteInstances,
    writeSpriteLayerUboIfDirty,
} from "./sprite-pipeline.js";
import type { SpritePipelineCache, SpritePipelineEntry } from "./sprite-pipeline.js";

interface SpriteRenderableInternal extends Renderable {
    _engine: EngineContextInternal;
    _layer: Sprite2DLayer;
    _indexBuffer: GPUBuffer;
    _uniformBuffer: GPUBuffer;
    _instanceBuffer: GPUBuffer;
    _instanceBufferCapacity: number;
    _pipelineCache: SpritePipelineCache;
    _pipelineEntry: SpritePipelineEntry | null;
    _bindGroup: GPUBindGroup | null;
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
 * `Renderable`. The check lives here so `addToScene` only admits the entity;
 * renderable construction owns the rule that scene renderables require depth.
 *
 * Caller (currently only `scene-core.addToScene`) is responsible for
 * pushing `renderable` into `_renderables` and `dispose` into `_disposables`.
 */
export function buildSpriteRenderable(engine: EngineContextInternal, layer: Sprite2DLayer): { renderable: Renderable; dispose: () => void } {
    if (layer.depth === "none") {
        throw new Error('Sprite2DLayer with depth: "none" must be rendered via createSpriteRenderer, not addToScene.');
    }
    const indexBuffer = createMappedBuffer(engine, SHARED_SPRITE_INDEX_DATA, GPUBufferUsage.INDEX);
    const uniformBuffer = createEmptyUniformBuffer(engine, LAYER_UBO_BYTES, "sprite-depth-hosted-ubo");
    const cap = layer._capacity;
    const instanceBuffer = createSpriteInstanceBuffer(engine.device, cap, "sprite-depth-hosted-instances");

    const isTransparent = layer.depth === "test";
    const isDirectDepthWrite = layer.depth === "test-write";
    const renderable: SpriteRenderableInternal = {
        // Depth-write sprite layers are mutable instanced batches, so route them through
        // the direct-draw phase after cached opaque meshes and before transparent draws.
        order: isTransparent ? 200 : 100,
        isTransparent,
        isTransmissive: isDirectDepthWrite,
        _engine: engine,
        _layer: layer,
        _indexBuffer: indexBuffer,
        _uniformBuffer: uniformBuffer,
        _instanceBuffer: instanceBuffer,
        _instanceBufferCapacity: cap,
        _pipelineCache: createSpritePipelineCache(),
        _pipelineEntry: null,
        _bindGroup: null,
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
    let entry = r._pipelineEntry;
    if (!entry || !isSpritePipelineEntryCurrent(engine, entry, target.colorFormat, sampleCount, true, depthWrite, target.depthStencilFormat)) {
        entry = getOrCreateSpritePipeline(engine, r._pipelineCache, target.colorFormat, sampleCount, r._layer.blendMode, true, depthWrite, target.depthStencilFormat);
        r._pipelineEntry = entry;
        r._bindGroup = null;
    }
    return {
        renderable: r,
        pipeline: entry.pipeline,
        updateUBOs() {
            uploadLayer(r);
        },
        draw(pass) {
            return drawLayer(r, entry, pass);
        },
    };
}

/** Sync per-instance vertex data and the per-layer UBO via the shared pipeline helpers. */
function uploadLayer(r: SpriteRenderableInternal): void {
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
    const targetSize = getRenderTargetSize(r._engine);
    buildSpriteLayerUbo(r._layer, targetSize.width, targetSize.height, r._scratchUbo);
    r._uboUploaded = writeSpriteLayerUboIfDirty(r._engine.device, r._uniformBuffer, r._scratchUbo, r._lastUbo, r._uboUploaded);
}

/** Issue the indexed instanced draw for this depth-hosted sprite layer. */
function drawLayer(r: SpriteRenderableInternal, entry: SpritePipelineEntry, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (r._disposed || !r._layer.visible || r._layer.count === 0) {
        return 0;
    }
    if (!r._bindGroup) {
        r._bindGroup = createSpriteLayerBindGroup(r._engine, entry, r._layer, r._uniformBuffer);
    }
    pass.setBindGroup(entry.spriteBindGroupIndex, r._bindGroup);
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
    clearSpritePipelineCache(r._pipelineCache);
    r._bindGroup = null;
    r._pipelineEntry = null;
}
