import type { EngineContextInternal } from "../engine/engine.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { Camera } from "../camera/camera.js";
import { getViewMatrix } from "../camera/camera.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import type { BillboardSpriteSystem } from "./billboard-sprite.js";
import {
    BILLBOARD_INDEX_DATA,
    BILLBOARD_SYSTEM_UBO_BYTES,
    buildBillboardSystemUbo,
    createBillboardInstanceBuffer,
    createBillboardInstanceSortScratch,
    createBillboardPipelineCache,
    createBillboardSystemBindGroup,
    ensureBillboardInstanceBuffer,
    getOrCreateBillboardPipeline,
    resetBillboardPipelineCache,
    uploadBillboardInstances,
    uploadSortedBillboardInstances,
    writeBillboardSystemUboIfDirty,
} from "./billboard-pipeline.js";
import type { BillboardInstanceSortScratch, BillboardPipelineCache } from "./billboard-pipeline.js";

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
        resetBillboardPipelineCache(_sharedPipelineCache);
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
    _instanceSortScratch: BillboardInstanceSortScratch;
    _pipelineCache: BillboardPipelineCache;
    _bindGroups: Map<GPURenderPipeline, GPUBindGroup>;
    _uploadedVersion: number;
    _uploadedCamera: Camera | null;
    _uploadedCameraViewVersion: number;
    _uploadedSorted: boolean;
    _centerVersion: number;
    _drawableCount: number;
    _uboUploaded: boolean;
    _lastUbo: Float32Array;
    _scratchUbo: Float32Array;
    _disposed: boolean;
}

export function buildBillboardRenderable(engine: EngineContextInternal, system: BillboardSpriteSystem): { renderable: Renderable; dispose: () => void } {
    const indexBuffer = createMappedBuffer(engine, BILLBOARD_INDEX_DATA, GPUBufferUsage.INDEX);
    const uniformBuffer = createEmptyUniformBuffer(engine, BILLBOARD_SYSTEM_UBO_BYTES, `${system._orientation}-billboard-system-ubo`);
    const instanceBuffer = createBillboardInstanceBuffer(engine.device, system, `${system._orientation}-billboard-instances`);
    const isTransparent = system._depthMode === "transparent";
    const renderable: BillboardRenderableInternal = {
        order: system.order,
        isTransparent,
        _direct: !isTransparent,
        _engine: engine,
        _system: system,
        _indexBuffer: indexBuffer,
        _uniformBuffer: uniformBuffer,
        _instanceBuffer: instanceBuffer,
        _instanceBufferCapacity: system._capacity,
        _instanceSortScratch: createBillboardInstanceSortScratch(),
        _pipelineCache: acquireSharedPipelineCache(),
        _bindGroups: new Map(),
        _uploadedVersion: -1,
        _uploadedCamera: null,
        _uploadedCameraViewVersion: -1,
        _uploadedSorted: false,
        _centerVersion: -1,
        _drawableCount: 0,
        _uboUploaded: false,
        _lastUbo: new Float32Array(BILLBOARD_SYSTEM_UBO_BYTES / 4),
        _scratchUbo: new Float32Array(BILLBOARD_SYSTEM_UBO_BYTES / 4),
        _disposed: false,
        _worldCenter: [0, 0, 0],
        bind(engine, target) {
            return bindSystem(renderable, engine as EngineContextInternal, target);
        },
    };
    refreshBillboardWorldCenter(renderable);
    return {
        renderable,
        dispose() {
            disposeRenderable(renderable);
        },
    };
}

function bindSystem(renderable: BillboardRenderableInternal, engine: EngineContextInternal, target: RenderTargetSignature): DrawBinding {
    if (!target.depthStencilFormat) {
        throw new Error("BillboardSpriteSystem requires a depth-stencil render target.");
    }
    const sampleCount = target.sampleCount === 1 ? 1 : 4;
    const pipeline = getOrCreateBillboardPipeline(
        engine,
        renderable._pipelineCache,
        target.colorFormat!,
        sampleCount,
        renderable._system,
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
        update(context) {
            uploadSystem(renderable, context);
        },
        draw(pass) {
            return drawSystem(renderable, bindGroup, pass);
        },
    };
}

function uploadSystem(renderable: BillboardRenderableInternal, context: DrawUpdateContext): void {
    if (renderable._disposed) {
        return;
    }
    refreshBillboardWorldCenter(renderable);
    if (!renderable._system.visible || renderable._system.count === 0) {
        if (renderable._system.count === 0) {
            renderable._system._dirtyMin = 0;
            renderable._system._dirtyMax = 0;
            renderable._uploadedVersion = renderable._system._version;
            renderable._uploadedSorted = false;
        }
        return;
    }
    const grown = ensureBillboardInstanceBuffer(
        renderable._engine.device,
        renderable._system,
        renderable._instanceBuffer,
        renderable._instanceBufferCapacity,
        `${renderable._system._orientation}-billboard-instances`
    );
    if (grown.reallocated) {
        renderable._instanceBuffer = grown.buffer;
        renderable._instanceBufferCapacity = grown.capacity;
        renderable._uploadedVersion = -1;
        renderable._uploadedCamera = null;
        renderable._uploadedCameraViewVersion = -1;
        renderable._uploadedSorted = false;
    }
    const camera = context._camera;
    if (renderable._system._depthMode === "transparent" && camera) {
        const cameraViewMatrix = getViewMatrix(camera);
        if (
            !renderable._uploadedSorted ||
            renderable._uploadedVersion !== renderable._system._version ||
            renderable._uploadedCamera !== camera ||
            renderable._uploadedCameraViewVersion !== camera.worldMatrixVersion
        ) {
            uploadSortedBillboardInstances(renderable._engine.device, renderable._system, renderable._instanceBuffer, renderable._instanceSortScratch, cameraViewMatrix);
            renderable._uploadedVersion = renderable._system._version;
            renderable._uploadedCamera = camera;
            renderable._uploadedCameraViewVersion = camera.worldMatrixVersion;
            renderable._uploadedSorted = true;
        }
    } else {
        const uploadedVersion = renderable._uploadedSorted ? -1 : renderable._uploadedVersion;
        renderable._uploadedVersion = uploadBillboardInstances(renderable._engine.device, renderable._system, renderable._instanceBuffer, uploadedVersion);
        renderable._uploadedCamera = null;
        renderable._uploadedCameraViewVersion = -1;
        renderable._uploadedSorted = false;
    }
    buildBillboardSystemUbo(renderable._system, renderable._scratchUbo);
    writeBillboardSystemUboIfDirty(renderable._engine.device, renderable._uniformBuffer, renderable._scratchUbo, renderable._lastUbo, !renderable._uboUploaded);
    renderable._uboUploaded = true;
}

function refreshBillboardWorldCenter(renderable: BillboardRenderableInternal): void {
    const system = renderable._system;
    if (renderable._centerVersion === system._version) {
        return;
    }
    const center = renderable._worldCenter!;
    if (system.count === 0) {
        center[0] = 0;
        center[1] = 0;
        center[2] = 0;
        renderable._drawableCount = 0;
        renderable._centerVersion = system._version;
        return;
    }
    const data = system._instanceData;
    const stride = system._instanceFloatsPerSprite;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let drawableCount = 0;
    for (let index = 0; index < system.count; index++) {
        const base = index * stride;
        const width = data[base + 3]!;
        const height = data[base + 4]!;
        if (width === 0 || height === 0) {
            continue;
        }
        const x = data[base]!;
        const y = data[base + 1]!;
        const z = data[base + 2]!;
        if (x < minX) {
            minX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z > maxZ) {
            maxZ = z;
        }
        drawableCount++;
    }
    if (drawableCount === 0) {
        center[0] = 0;
        center[1] = 0;
        center[2] = 0;
    } else {
        center[0] = (minX + maxX) * 0.5;
        center[1] = (minY + maxY) * 0.5;
        center[2] = (minZ + maxZ) * 0.5;
    }
    renderable._drawableCount = drawableCount;
    renderable._centerVersion = system._version;
}

function drawSystem(renderable: BillboardRenderableInternal, bindGroup: GPUBindGroup, pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
    if (renderable._disposed) {
        return 0;
    }
    refreshBillboardWorldCenter(renderable);
    if (!renderable._system.visible || renderable._system.count === 0 || renderable._drawableCount === 0) {
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
    releaseSharedPipelineCache();
}
