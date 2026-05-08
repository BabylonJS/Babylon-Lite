import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, Renderable } from "../render/renderable.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import {
    BILLBOARD_INDEX_DATA,
    BILLBOARD_SYSTEM_UBO_BYTES,
    buildBillboardSystemUbo,
    clearBillboardPipelineCache,
    createBillboardInstanceBuffer,
    createBillboardPipelineCache,
    createBillboardSystemBindGroup,
    ensureBillboardInstanceBuffer,
    getOrCreateFacingBillboardPipeline,
    uploadBillboardInstances,
    writeBillboardSystemUboIfDirty,
} from "./billboard-pipeline.js";
import type { BillboardPipelineCache } from "./billboard-pipeline.js";

let _sharedPipelineCache: BillboardPipelineCache | null = null;
let _sharedPipelineCacheRefs = 0;

function acquireSharedPipelineCache(): BillboardPipelineCache {
    _sharedPipelineCache ??= createBillboardPipelineCache();
    _sharedPipelineCacheRefs++;
    return _sharedPipelineCache;
}

function releaseSharedPipelineCache(): void {
    if (_sharedPipelineCacheRefs === 0) {
        return;
    }
    _sharedPipelineCacheRefs--;
    if (_sharedPipelineCacheRefs === 0 && _sharedPipelineCache) {
        clearBillboardPipelineCache(_sharedPipelineCache);
        _sharedPipelineCache = null;
    }
}

interface BillboardRenderableInternal extends Renderable {
    _engine: EngineContextInternal;
    _system: BillboardSpriteSystem;
    _indexBuffer: GPUBuffer;
    _uniformBuffer: GPUBuffer;
    _instanceBuffer: GPUBuffer;
    _instanceBufferCapacity: number;
    _pipelineCache: BillboardPipelineCache;
    _bindGroups: Map<GPURenderPipeline, GPUBindGroup>;
    _uploadedVersion: number;
    _uboUploaded: boolean;
    _lastUbo: Float32Array;
    _scratchUbo: Float32Array;
    _disposed: boolean;
}

export function buildFacingBillboardRenderable(engine: EngineContextInternal, system: BillboardSpriteSystem): { renderable: Renderable; dispose: () => void } {
    const indexBuffer = createMappedBuffer(engine, BILLBOARD_INDEX_DATA, GPUBufferUsage.INDEX);
    const uniformBuffer = createEmptyUniformBuffer(engine, BILLBOARD_SYSTEM_UBO_BYTES, "facing-billboard-system-ubo");
    const instanceBuffer = createBillboardInstanceBuffer(engine.device, system, "facing-billboard-instances");
    const renderable: BillboardRenderableInternal = {
        order: system.order,
        isTransparent: true,
        isTransmissive: false,
        _engine: engine,
        _system: system,
        _indexBuffer: indexBuffer,
        _uniformBuffer: uniformBuffer,
        _instanceBuffer: instanceBuffer,
        _instanceBufferCapacity: system._capacity,
        _pipelineCache: acquireSharedPipelineCache(),
        _bindGroups: new Map(),
        _uploadedVersion: -1,
        _uboUploaded: false,
        _lastUbo: new Float32Array(BILLBOARD_SYSTEM_UBO_BYTES / 4),
        _scratchUbo: new Float32Array(BILLBOARD_SYSTEM_UBO_BYTES / 4),
        _disposed: false,
        bind(engine, target) {
            return bindSystem(renderable, engine as EngineContextInternal, target);
        },
    };
    return {
        renderable,
        dispose() {
            disposeRenderable(renderable);
        },
    };
}

function bindSystem(renderable: BillboardRenderableInternal, engine: EngineContextInternal, target: RenderTargetSignature): DrawBinding {
    if (!target.depthStencilFormat) {
        throw new Error("FacingBillboardSpriteSystem requires a depth-stencil render target.");
    }
    const sampleCount = target.sampleCount === 1 ? 1 : 4;
    const pipeline = getOrCreateFacingBillboardPipeline(
        engine,
        renderable._pipelineCache,
        target.colorFormat,
        sampleCount,
        renderable._system.blendMode,
        target.depthStencilFormat,
        getSceneBindGroupLayout(engine)
    );
    let bindGroup = renderable._bindGroups.get(pipeline);
    if (!bindGroup) {
        bindGroup = createBillboardSystemBindGroup(engine, pipeline, renderable._system, renderable._uniformBuffer);
        renderable._bindGroups.set(pipeline, bindGroup);
    }
    return {
        renderable,
        pipeline,
        update() {
            uploadSystem(renderable);
        },
        draw(pass) {
            return drawSystem(renderable, bindGroup, pass);
        },
    };
}

function uploadSystem(renderable: BillboardRenderableInternal): void {
    if (renderable._disposed || !renderable._system.visible || renderable._system.count === 0) {
        return;
    }
    const grown = ensureBillboardInstanceBuffer(
        renderable._engine.device,
        renderable._system,
        renderable._instanceBuffer,
        renderable._instanceBufferCapacity,
        "facing-billboard-instances"
    );
    if (grown.reallocated) {
        renderable._instanceBuffer = grown.buffer;
        renderable._instanceBufferCapacity = grown.capacity;
        renderable._uploadedVersion = -1;
    }
    renderable._uploadedVersion = uploadBillboardInstances(renderable._engine.device, renderable._system, renderable._instanceBuffer, renderable._uploadedVersion);
    buildBillboardSystemUbo(renderable._system, renderable._scratchUbo);
    renderable._uboUploaded = writeBillboardSystemUboIfDirty(
        renderable._engine.device,
        renderable._uniformBuffer,
        renderable._scratchUbo,
        renderable._lastUbo,
        renderable._uboUploaded
    );
}

function drawSystem(renderable: BillboardRenderableInternal, bindGroup: GPUBindGroup, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (renderable._disposed || !renderable._system.visible || renderable._system.count === 0) {
        return 0;
    }
    pass.setBindGroup(1, bindGroup);
    pass.setIndexBuffer(renderable._indexBuffer, "uint16");
    pass.setVertexBuffer(0, renderable._instanceBuffer);
    pass.drawIndexed(6, renderable._system.count, 0, 0, 0);
    return 1;
}

function disposeRenderable(renderable: BillboardRenderableInternal): void {
    if (renderable._disposed) {
        return;
    }
    renderable._disposed = true;
    renderable._instanceBuffer.destroy();
    renderable._uniformBuffer.destroy();
    renderable._indexBuffer.destroy();
    renderable._bindGroups.clear();
    (renderable as unknown as { _system: BillboardSpriteSystem | null })._system = null;
    releaseSharedPipelineCache();
}
