/** PBR-owned MeshLoD renderable — coarse CPU-selected indirect rendering.
 *
 *  Owns every MeshLoD rendering decision for the guaranteed opaque metallic-roughness
 *  subset: material validation + feature detection, the storage-fetch vertex + PBR/
 *  unlit fragment pipeline (WGSL in `pbr-mesh-lod-compose.ts`), the fixed v1 group-1
 *  bind group, fallback textures for absent guaranteed channels, per-frame CPU
 *  selection + expansion of pinned clusters into a draw-vertex stream, and one
 *  `drawIndirect` per material/hierarchy batch. The generic renderer only ever sees
 *  an ordinary opaque `Renderable`; no WGSL, pipeline, or bind-group code leaks out
 *  of `material/pbr`. Imported only through the MeshLoD scene path — no module-level
 *  side effects, so non-MeshLoD scenes fetch none of it. */

import { BU } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { invalidateRenderBundles } from "../../mesh/mesh-factories.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { DrawBinding, DrawUpdateContext, Renderable } from "../../render/renderable.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { REVERSE_DEPTH_COMPARE } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target-signature.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../../resource/gpu-buffers.js";
import type { Camera } from "../../camera/camera.js";
import { getCameraPosition, getViewProjectionMatrix } from "../../camera/camera.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { createSolidTexture2D } from "../../texture/solid-texture.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import type { MeshLoDSceneBatch } from "../../mesh-lod/mesh-lod-scene.js";
import { driveMeshLoDStreaming, getMeshLoDSelectionCamera, selectMeshLoDBatch } from "../../mesh-lod/mesh-lod-scene.js";
import { queueMeshLoDFrame } from "../../mesh-lod/mesh-lod-runtime.js";
import { createMeshLoDError } from "../../mesh-lod/mesh-lod-errors.js";
import type { MeshLoDGpuBatchState, MeshLoDGpuFrameParams, MeshLoDGpuInstanceState, MeshLoDUpdateBatch } from "../../mesh-lod/mesh-lod-selection-gpu.js";
import { meshLoDConeCullMargin } from "../../mesh-lod/mesh-lod-selection-math.js";
import {
    INSTANCE_WORDS,
    createMeshLoDGpuBatchState,
    createMeshLoDGpuInstanceState,
    disposeMeshLoDGpuBatchState,
    disposeMeshLoDGpuInstanceState,
    getMeshLoDUpdateBatch,
    packInstanceRecord,
    queueMeshLoDGpuSelection,
} from "../../mesh-lod/mesh-lod-selection-gpu.js";
import type { MeshLoDShaderFeatures } from "./pbr-mesh-lod-compose.js";
import { composeMeshLoDWgsl, meshLoDShaderKey } from "./pbr-mesh-lod-compose.js";
import { StandardToneMapping } from "./tone-mapping.js";
import { meshLoDClusterDebugAttr, meshLoDConeDebugAttr, meshLoDDebugModeCode, meshLoDPageRequestCode, meshLoDPageResidencyCode } from "./pbr-mesh-lod-debug.js";

const DRAW_VERTEX_STRIDE = 16; // 4 × u32
const INSTANCE_STRIDE = 128; // world mat4 (64) + 3 normal-matrix vec4 (48) + pad (16)
const VERTEX_WORDS = 6; // 24-byte packed vertex / 4
const MATERIAL_UBO_BYTES = 80; // 5 × vec4
const MATERIAL_MISC_Y_BYTE = 68; // misc.y (data[17]) — debug-view mode selector

// ─── Fallback textures (device-keyed lazy cache, no module-level allocation) ──

interface MeshLoDFallbacks {
    readonly white: Texture2D;
    readonly normal: Texture2D;
    readonly black: Texture2D;
}

let _fallbacks: MeshLoDFallbacks | null = null;
let _fallbackDevice: GPUDevice | null = null;

function getFallbacks(engine: EngineContext): MeshLoDFallbacks {
    if (!_fallbacks || _fallbackDevice !== engine._device) {
        _fallbacks = {
            white: createSolidTexture2D(engine, 1, 1, 1, 1),
            normal: createSolidTexture2D(engine, 0.5, 0.5, 1, 1),
            black: createSolidTexture2D(engine, 0, 0, 0, 1),
        };
        _fallbackDevice = engine._device;
    }
    return _fallbacks;
}

// ─── Feature detection + validation ──────────────────────────────────

function detectFeatures(material: PbrMaterialProps, hasEnvironment: boolean): MeshLoDShaderFeatures {
    // The PBR module owns supported-material validation (architecture 13.2). Reject
    // anything outside the guaranteed opaque metallic-roughness subset even though
    // the scene registry validated it — this module is the authoritative gate.
    const unsupported =
        material.alphaBlend === true ||
        material._alphaCutOff !== undefined ||
        !!material._transmissive ||
        !!material._clearCoat ||
        !!material._sheen ||
        !!material._iridescence ||
        !!material._anisotropy ||
        !!material._subsurface ||
        !!material.specGlossTexture ||
        !!material.plugins?.length ||
        material.occlusionTexCoord === 1 ||
        !!material._uv2Mask ||
        !!material._shadowOnly ||
        !!material._skyboxMode;
    if (unsupported) {
        throw createMeshLoDError("MLOD_UNSUPPORTED_MATERIAL", "MeshLoD material is outside the guaranteed opaque metallic-roughness subset");
    }
    return {
        hasNormalMap: !!material.normalTexture,
        hasEmissiveTexture: !!material.emissiveTexture,
        hasIbl: hasEnvironment && material._unlit !== true,
        doubleSided: material.doubleSided === true,
        unlit: material._unlit === true,
    };
}

// ─── Material UBO packing ────────────────────────────────────────────

function packMaterialUbo(material: PbrMaterialProps, features: MeshLoDShaderFeatures): Float32Array {
    const data = new Float32Array(MATERIAL_UBO_BYTES / 4);
    const bcf = material.baseColorFactor ?? [1, 1, 1, 1];
    const unlitColor = features.unlit ? (material._unlitColor ?? [1, 1, 1]) : [1, 1, 1];
    data[0] = bcf[0]! * unlitColor[0]!;
    data[1] = bcf[1]! * unlitColor[1]!;
    data[2] = bcf[2]! * unlitColor[2]!;
    data[3] = bcf[3]!;
    const emissive = material._emissiveColor ?? (features.hasEmissiveTexture ? [1, 1, 1] : [0, 0, 0]);
    data[4] = emissive[0]!;
    data[5] = emissive[1]!;
    data[6] = emissive[2]!;
    data[7] = 0;
    data[8] = material.metallicFactor ?? 1;
    data[9] = material.roughnessFactor ?? 1;
    data[10] = material.normalTextureScale ?? 1;
    data[11] = material.occlusionStrength ?? 1;
    data[12] = material.environmentIntensity ?? 1;
    data[13] = material.directIntensity ?? 1;
    data[14] = material.reflectance ?? 0.04;
    data[15] = material.alpha ?? 1;
    data[16] = material.usePhysicalLightFalloff === false ? 0 : 1;
    return data;
}

// ─── Per-batch GPU packet ────────────────────────────────────────────

interface MeshLoDBatchPacket {
    readonly features: MeshLoDShaderFeatures;
    readonly environment: EnvironmentTextures | null;
    shaderModule: GPUShaderModule;
    shaderKey: string;
    readonly bindGroupLayout: GPUBindGroupLayout;
    /** CPU-path group-1 bind group. Rebuilt make-before-break when the draw-vertex
     *  buffer grows to hold streamed refinement. */
    bindGroup: GPUBindGroup;
    readonly pipelines: Map<string, GPURenderPipeline>;
    /** Draw-vertex stream buffer. Grows (make-before-break) past the coarse bound as
     *  fine pages stream in and selection refines. */
    drawVertexBuffer: GPUBuffer;
    instanceBuffer: GPUBuffer;
    readonly indirectBuffer: GPUBuffer;
    readonly materialUbo: GPUBuffer;
    readonly arena: GPUBuffer;
    drawScratch: Uint32Array;
    instanceScratch: Float32Array;
    readonly indirectScratch: Uint32Array;
    maxDrawVertices: number;
    maxInstances: number;
    lastVertexCount: number;
    /** Debug-view mode (0 = off) last written into the material UBO's misc.y. */
    appliedDebugMode: number;
    /** True once a disposed asset has re-recorded the cached bundle to drop its draw. */
    disposedHandled: boolean;
    // ── GPU selection/expansion path (created lazily on first GPU-mode frame) ──
    gpuInstanceState: MeshLoDGpuInstanceState | null;
    gpuBatchState: MeshLoDGpuBatchState | null;
    gpuBindGroup: GPUBindGroup | null;
    gpuBoundDrawVertices: GPUBuffer | null;
    gpuBoundInstances: GPUBuffer | null;
    /** Per-frame resolved binding + indirect buffer the draw closure consumes. */
    activeBindGroup: GPUBindGroup | null;
    activeIndirectBuffer: GPUBuffer | null;
    dispose(): void;
}

function buildBindGroup(
    engine: EngineContext,
    layout: GPUBindGroupLayout,
    material: PbrMaterialProps,
    drawVertexBuffer: GPUBuffer,
    instanceBuffer: GPUBuffer,
    arena: GPUBuffer,
    materialUbo: GPUBuffer,
    environment: EnvironmentTextures | null
): GPUBindGroup {
    const fb = getFallbacks(engine);
    const base = material.baseColorTexture ?? fb.white;
    const normal = material.normalTexture ?? fb.normal;
    const orm = material.ormTexture ?? fb.white;
    const emissive = material.emissiveTexture ?? fb.black;
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: materialUbo } },
        { binding: 1, resource: base.view },
        { binding: 2, resource: base.sampler },
        { binding: 3, resource: normal.view },
        { binding: 4, resource: normal.sampler },
        { binding: 5, resource: orm.view },
        { binding: 6, resource: orm.sampler },
        { binding: 7, resource: emissive.view },
        { binding: 8, resource: emissive.sampler },
        { binding: 9, resource: { buffer: arena } },
        { binding: 10, resource: { buffer: drawVertexBuffer } },
        { binding: 11, resource: { buffer: instanceBuffer } },
    ];
    if (environment) {
        entries.push(
            { binding: 12, resource: environment.brdfLutView },
            { binding: 13, resource: environment.brdfSampler },
            { binding: 14, resource: environment.specularCubeView },
            { binding: 15, resource: environment.cubeSampler }
        );
    }
    return engine._device.createBindGroup({
        layout,
        entries,
    });
}

function meshLoDBindGroupLayout(engine: EngineContext, hasIbl: boolean): GPUBindGroupLayout {
    const V = 0x1;
    const F = 0x2;
    const tex = (binding: number): GPUBindGroupLayoutEntry[] => [
        { binding, visibility: F, texture: { sampleType: "float" } },
        { binding: binding + 1, visibility: F, sampler: { type: "filtering" } },
    ];
    return engine._device.createBindGroupLayout({
        label: "mesh-lod-material",
        entries: [
            { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
            ...tex(1),
            ...tex(3),
            ...tex(5),
            ...tex(7),
            { binding: 9, visibility: V, buffer: { type: "read-only-storage" } },
            { binding: 10, visibility: V, buffer: { type: "read-only-storage" } },
            { binding: 11, visibility: V, buffer: { type: "read-only-storage" } },
            ...(hasIbl
                ? [
                      ...tex(12),
                      { binding: 14, visibility: F, texture: { sampleType: "float" as const, viewDimension: "cube" as const } },
                      { binding: 15, visibility: F, sampler: { type: "filtering" as const } },
                  ]
                : []),
        ],
    });
}

function getPipeline(engine: EngineContext, packet: MeshLoDBatchPacket, sig: RenderTargetSignature, scene: SceneContext): GPURenderPipeline {
    const toneMapping = scene.imageProcessing?.toneMappingEnabled ? (scene.imageProcessing.toneMapping ?? StandardToneMapping) : undefined;
    const shaderKey = meshLoDShaderKey(packet.features, toneMapping);
    if (packet.shaderKey !== shaderKey) {
        packet.shaderModule = engine._device.createShaderModule({ label: `mesh-lod-${shaderKey}`, code: composeMeshLoDWgsl(packet.features, toneMapping) });
        packet.shaderKey = shaderKey;
    }
    const key = `${targetSignatureKey(sig)}:${shaderKey}`;
    const cached = packet.pipelines.get(key);
    if (cached) {
        return cached;
    }
    const device = engine._device;
    const layout = device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(engine), packet.bindGroupLayout] });
    const pipeline = device.createRenderPipeline({
        label: "mesh-lod",
        layout,
        vertex: { module: packet.shaderModule, entryPoint: "vs", buffers: [] },
        fragment: sig._colorFormat ? { module: packet.shaderModule, entryPoint: "fs", targets: [{ format: sig._colorFormat }] } : undefined,
        depthStencil: sig._depthStencilFormat ? { format: sig._depthStencilFormat, depthCompare: sig._depthCompare ?? REVERSE_DEPTH_COMPARE, depthWriteEnabled: true } : undefined,
        multisample: { count: sig._sampleCount },
        primitive: { topology: "triangle-list", cullMode: packet.features.doubleSided ? "none" : "back", frontFace: "ccw" },
    });
    packet.pipelines.set(key, pipeline);
    return pipeline;
}

/** Grow the CPU draw-vertex buffer + scratch (make-before-break) so the streamed
 *  refinement's expanded vertices fit. Rebuilds the group-1 bind group against the new
 *  buffer and retires the old one after the next submitted frame drains. No-op while the
 *  selection fits the current capacity (the coarse-only case never grows). */
function ensureCpuDrawCapacity(engine: EngineContext, batch: MeshLoDSceneBatch, packet: MeshLoDBatchPacket, neededVertices: number): void {
    if (neededVertices <= packet.maxDrawVertices) {
        return;
    }
    let capacity = packet.maxDrawVertices;
    while (capacity < neededVertices) {
        capacity *= 2;
    }
    const runtime = batch.asset._runtime;
    const oldBuffer = packet.drawVertexBuffer;
    packet.drawVertexBuffer = engine._device.createBuffer({ label: "mesh-lod-draw-vertices", size: capacity * DRAW_VERTEX_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    packet.drawScratch = new Uint32Array(capacity * 4);
    packet.maxDrawVertices = capacity;
    packet.bindGroup = buildBindGroup(
        engine,
        packet.bindGroupLayout,
        batch.material,
        packet.drawVertexBuffer,
        packet.instanceBuffer,
        runtime.gpu.arena.buffer,
        packet.materialUbo,
        packet.environment
    );
    retireGpuResources(engine, () => oldBuffer.destroy());
}

/** Grow CPU instance storage without invalidating the in-flight render bundle. */
function ensureCpuInstanceCapacity(engine: EngineContext, batch: MeshLoDSceneBatch, packet: MeshLoDBatchPacket, neededInstances: number): void {
    if (neededInstances <= packet.maxInstances) {
        return;
    }
    let capacity = packet.maxInstances;
    while (capacity < neededInstances) {
        capacity *= 2;
    }
    const oldBuffer = packet.instanceBuffer;
    packet.instanceBuffer = engine._device.createBuffer({ label: "mesh-lod-instances", size: capacity * INSTANCE_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    packet.instanceScratch = new Float32Array(capacity * (INSTANCE_STRIDE / 4));
    packet.maxInstances = capacity;
    packet.bindGroup = buildBindGroup(
        engine,
        packet.bindGroupLayout,
        batch.material,
        packet.drawVertexBuffer,
        packet.instanceBuffer,
        batch.asset._runtime.gpu.arena.buffer,
        packet.materialUbo,
        packet.environment
    );
    retireGpuResources(engine, () => oldBuffer.destroy());
}

/** The opaque render bundle bakes both resources, so a mode switch or buffer
 *  replacement must re-record it before the next draw. */
function setActiveDraw(engine: EngineContext, packet: MeshLoDBatchPacket, bindGroup: GPUBindGroup | null, indirectBuffer: GPUBuffer | null): void {
    if (packet.activeBindGroup !== bindGroup || packet.activeIndirectBuffer !== indirectBuffer) {
        packet.activeBindGroup = bindGroup;
        packet.activeIndirectBuffer = indirectBuffer;
        invalidateRenderBundles(engine);
    }
}

/** Sync the debug-view mode into the material UBO's misc.y on change (a 4-byte
 *  write). Observational only — never affects selection/residency/demand. */
function syncDebugMode(engine: EngineContext, packet: MeshLoDBatchPacket, mode: number): void {
    if (packet.appliedDebugMode === mode) {
        return;
    }
    packet.appliedDebugMode = mode;
    engine._device.queue.writeBuffer(packet.materialUbo, MATERIAL_MISC_Y_BYTE, new Float32Array([mode]));
}

/** Per-frame CPU selection + expansion (reference/diagnostic mode): run the oracle for
 *  each visible instance, write its world/normal matrices, and flatten selected pinned
 *  clusters into the draw-vertex stream, then publish the single indirect vertex count. */
function updatePacketCpu(engine: EngineContext, batch: MeshLoDSceneBatch, packet: MeshLoDBatchPacket, context: DrawUpdateContext): void {
    const runtime = batch.asset._runtime;
    const debugMode = meshLoDDebugModeCode(runtime.debugView);
    syncDebugMode(engine, packet, debugMode);
    const selections = selectMeshLoDBatch(batch, context);
    // Feed this frame's fine-page demand + frame references to the streaming engine.
    driveMeshLoDStreaming(batch, selections);
    ensureCpuInstanceCapacity(engine, batch, packet, selections.length);
    // Grow the draw-vertex buffer if streamed refinement expands past the coarse bound.
    let neededVertices = 0;
    for (const selection of selections) {
        for (const clusterId of selection.result.selectedClusterIds) {
            neededVertices += runtime.clusters[clusterId]!.triangleCount * 3;
        }
    }
    ensureCpuDrawCapacity(engine, batch, packet, neededVertices);
    const draw = packet.drawScratch;
    const inst = packet.instanceScratch;
    let vertexCount = 0;
    let instanceIndex = 0;
    let selectedMeshlets = 0;

    for (const selection of selections) {
        const localInstance = instanceIndex;
        packInstanceRecord(
            inst,
            new Uint32Array(inst.buffer),
            localInstance * (INSTANCE_STRIDE / 4),
            selection.instance.worldMatrix,
            selection.instance.visible,
            selection.instance._instanceId,
            selection.instance.screenSpaceError
        );
        instanceIndex++;
        for (const clusterId of selection.result.selectedClusterIds) {
            const cluster = runtime.clusters[clusterId]!;
            const page = runtime.gpu.pages[cluster.pageId];
            if (!page || page.state !== "gpu-resident" || !page.indices || page.arenaOffset < 0) {
                continue;
            }
            // Per-cluster debug attribute for the active view (0 when off). Purely
            // observational — packed into the reserved draw-vertex word.
            let debugAttr = 0;
            if (debugMode === 6) {
                const camera = context._camera;
                const position = camera ? getCameraPosition(camera) : null;
                const margin =
                    position && batch.material.doubleSided !== true
                        ? meshLoDConeCullMargin(selection.instance.worldMatrix, [position.x, position.y, position.z], cluster.center, cluster.radius, cluster.normalCone)
                        : Number.POSITIVE_INFINITY;
                debugAttr = meshLoDConeDebugAttr(margin);
            } else if (debugMode !== 0) {
                const record = runtime.pageRecords[cluster.pageId]!;
                const depth = runtime.groups[cluster.groupId]?.depth ?? 0;
                const residency = meshLoDPageResidencyCode(record.pinned, page.state);
                const request = meshLoDPageRequestCode(record.pinned, page.state);
                debugAttr = meshLoDClusterDebugAttr(debugMode, cluster.groupId, depth, residency, request);
            }
            const arenaWordBase = (page.arenaOffset + page.vertexByteOffset) / 4;
            const indices = page.indices;
            const start = cluster.indexOffset;
            const count = cluster.triangleCount * 3;
            selectedMeshlets++;
            for (let k = 0; k < count; k++) {
                const localVertex = indices[start + k]!;
                const o = vertexCount * 4;
                draw[o] = arenaWordBase + localVertex * VERTEX_WORDS;
                draw[o + 1] = clusterId;
                draw[o + 2] = localInstance;
                draw[o + 3] = debugAttr;
                vertexCount++;
            }
        }
    }

    if (instanceIndex > 0) {
        engine._device.queue.writeBuffer(packet.instanceBuffer, 0, inst.buffer, inst.byteOffset, instanceIndex * INSTANCE_STRIDE);
    }
    if (vertexCount > 0) {
        engine._device.queue.writeBuffer(packet.drawVertexBuffer, 0, draw.buffer, draw.byteOffset, vertexCount * DRAW_VERTEX_STRIDE);
    }
    packet.indirectScratch[0] = vertexCount;
    packet.indirectScratch[1] = 1;
    packet.indirectScratch[2] = 0;
    packet.indirectScratch[3] = 0;
    engine._device.queue.writeBuffer(packet.indirectBuffer, 0, packet.indirectScratch.buffer, packet.indirectScratch.byteOffset, 16);
    packet.lastVertexCount = vertexCount;
    // An empty batch (no visible instances / no expanded vertices) is non-drawable, so the
    // draw closure issues zero draw calls — matching the GPU path and architecture §13.4.
    setActiveDraw(engine, packet, vertexCount > 0 ? packet.bindGroup : null, vertexCount > 0 ? packet.indirectBuffer : null);

    const diag = runtime.diagnostics as { renderedTriangleCount: number; selectedMeshletCount: number };
    diag.renderedTriangleCount = vertexCount / 3;
    diag.selectedMeshletCount = selectedMeshlets;
}

function buildGpuFrame(batch: MeshLoDSceneBatch, camera: Camera, context: DrawUpdateContext): MeshLoDGpuFrameParams {
    const runtime = batch.asset._runtime;
    const selectionCamera = getMeshLoDSelectionCamera(camera, context);
    const v = camera.viewport;
    const aspect = (context.targetWidth / context.targetHeight) * (v ? v.width / v.height : 1);
    return {
        cameraPos: selectionCamera.position,
        verticalFov: selectionCamera.verticalFov,
        near: selectionCamera.near,
        targetWidth: selectionCamera.targetWidth,
        targetHeight: selectionCamera.targetHeight,
        orthographicHeight: selectionCamera.orthographicHeight,
        viewProjection: getViewProjectionMatrix(camera, aspect),
        frustumCull: true, // GPU render path culls; CPU diagnostic mode keeps every cluster
        coneCull: batch.material.doubleSided !== true,
        screenSpaceError: runtime.settings.screenSpaceError,
        lodHysteresis: runtime.settings.lodHysteresis,
        levelCount: runtime.header.levelCount,
        debugMode: meshLoDDebugModeCode(runtime.debugView),
    };
}

/** Per-frame GPU selection + expansion (production mode): queue the compute work into
 *  the shared MeshLoD update batch (flushed before the render pass) and resolve the
 *  binding + indirect buffer the GPU-filled draw stream consumes. */
function updatePacketGpu(engine: EngineContext, batch: MeshLoDSceneBatch, packet: MeshLoDBatchPacket, context: DrawUpdateContext, updateBatch: MeshLoDUpdateBatch): void {
    const camera = context._camera;
    if (!camera || batch.instances.length === 0) {
        if (packet.gpuBatchState) {
            queueMeshLoDFrame(batch.asset._runtime, packet.gpuBatchState, "gpu", [], {
                visibleGroupCount: 0,
                fallbackGroupCount: 0,
                maximumSelectedErrorPixels: 0,
                maximumUnmetErrorPixels: 0,
            });
        }
        setActiveDraw(engine, packet, null, null);
        return;
    }
    const runtime = batch.asset._runtime;
    syncDebugMode(engine, packet, meshLoDDebugModeCode(runtime.debugView));
    packet.gpuInstanceState ??= createMeshLoDGpuInstanceState(runtime.groups.length);
    packet.gpuBatchState ??= createMeshLoDGpuBatchState();
    const handles = queueMeshLoDGpuSelection(engine, updateBatch, runtime, packet.gpuInstanceState, packet.gpuBatchState, batch.instances, buildGpuFrame(batch, camera, context));
    if (!handles) {
        setActiveDraw(engine, packet, null, null);
        return;
    }
    if (!packet.gpuBindGroup || packet.gpuBoundDrawVertices !== handles.drawVertexBuffer || packet.gpuBoundInstances !== handles.instanceBuffer) {
        packet.gpuBindGroup = buildBindGroup(
            engine,
            packet.bindGroupLayout,
            batch.material,
            handles.drawVertexBuffer,
            handles.instanceBuffer,
            packet.arena,
            packet.materialUbo,
            packet.environment
        );
        packet.gpuBoundDrawVertices = handles.drawVertexBuffer;
        packet.gpuBoundInstances = handles.instanceBuffer;
    }
    setActiveDraw(engine, packet, packet.gpuBindGroup, handles.drawArgsBuffer);
}

/** Dispatch the per-frame update to the CPU reference or GPU production path. A disposed
 *  asset is non-drawable immediately; the cached render bundle must not replay retired
 *  arena/draw buffers (§14.2). */
function updatePacket(engine: EngineContext, batch: MeshLoDSceneBatch, packet: MeshLoDBatchPacket, context: DrawUpdateContext, updateBatch: MeshLoDUpdateBatch): void {
    const runtime = batch.asset._runtime;
    if (runtime.disposed) {
        setActiveDraw(engine, packet, null, null);
        if (!packet.disposedHandled) {
            packet.disposedHandled = true;
            invalidateRenderBundles(engine);
        }
        return;
    }
    if (runtime.selectionMode === "gpu") {
        updatePacketGpu(engine, batch, packet, context, updateBatch);
    } else {
        updatePacketCpu(engine, batch, packet, context);
    }
}

/** Build the single indirect-draw `Renderable` for one MeshLoD batch, or `null`
 *  when the batch has no instances. */
export function buildMeshLoDBatchRenderable(engine: EngineContext, _scene: SceneContext, batch: MeshLoDSceneBatch): Renderable | null {
    if (batch.instances.length === 0) {
        return null;
    }
    const runtime = batch.asset._runtime;
    const environment = batch.material._unlit === true ? null : (_scene._envTextures ?? null);
    const features = detectFeatures(batch.material, environment !== null);

    const maxInstances = Math.max(batch.instances.length, 1);
    let maxDrawVertices = 3;
    if (runtime.selectionMode === "cpu") {
        let coarseVertices = 0;
        for (const cluster of runtime.clusters) {
            if (runtime.pageRecords[cluster.pageId]?.pinned) {
                coarseVertices += cluster.triangleCount * 3;
            }
        }
        maxDrawVertices = Math.max(coarseVertices * maxInstances, 3);
    }

    const device = engine._device;
    const materialUbo = createEmptyUniformBuffer(engine, MATERIAL_UBO_BYTES, "mesh-lod-material");
    device.queue.writeBuffer(materialUbo, 0, packMaterialUbo(batch.material, features) as Float32Array<ArrayBuffer>);

    const drawVertexBuffer = device.createBuffer({ label: "mesh-lod-draw-vertices", size: maxDrawVertices * DRAW_VERTEX_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    const instanceBuffer = device.createBuffer({ label: "mesh-lod-instances", size: maxInstances * INSTANCE_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    const indirectBuffer = device.createBuffer({ label: "mesh-lod-indirect", size: 16, usage: BU.INDIRECT | BU.COPY_DST });

    const bindGroupLayout = meshLoDBindGroupLayout(engine, features.hasIbl);
    const toneMapping = _scene.imageProcessing?.toneMappingEnabled ? (_scene.imageProcessing.toneMapping ?? StandardToneMapping) : undefined;
    const shaderKey = meshLoDShaderKey(features, toneMapping);
    const shaderModule = device.createShaderModule({ label: `mesh-lod-${shaderKey}`, code: composeMeshLoDWgsl(features, toneMapping) });

    const packet: MeshLoDBatchPacket = {
        features,
        environment,
        shaderModule,
        shaderKey,
        bindGroupLayout,
        bindGroup: buildBindGroup(engine, bindGroupLayout, batch.material, drawVertexBuffer, instanceBuffer, runtime.gpu.arena.buffer, materialUbo, environment),
        pipelines: new Map(),
        drawVertexBuffer,
        instanceBuffer,
        indirectBuffer,
        materialUbo,
        arena: runtime.gpu.arena.buffer,
        drawScratch: new Uint32Array(maxDrawVertices * 4),
        instanceScratch: new Float32Array(maxInstances * (INSTANCE_STRIDE / 4)),
        indirectScratch: new Uint32Array(4),
        maxDrawVertices,
        maxInstances,
        lastVertexCount: 0,
        appliedDebugMode: 0,
        disposedHandled: false,
        gpuInstanceState: null,
        gpuBatchState: null,
        gpuBindGroup: null,
        gpuBoundDrawVertices: null,
        gpuBoundInstances: null,
        activeBindGroup: null,
        activeIndirectBuffer: null,
        dispose: () => {
            runtime._frameSnapshots.delete(batch);
            if (packet.gpuBatchState) {
                runtime._frameSnapshots.delete(packet.gpuBatchState);
            }
            materialUbo.destroy();
            packet.drawVertexBuffer.destroy();
            packet.instanceBuffer.destroy();
            indirectBuffer.destroy();
            if (packet.gpuInstanceState) {
                disposeMeshLoDGpuInstanceState(packet.gpuInstanceState);
            }
            if (packet.gpuBatchState) {
                disposeMeshLoDGpuBatchState(packet.gpuBatchState);
            }
            for (const bindingPacket of bindingPackets) {
                bindingPacket.dispose();
            }
        },
    };
    const bindingPackets: MeshLoDBatchPacket[] = [];
    const packetByTarget = new WeakMap<RenderTargetSignature, MeshLoDBatchPacket>();
    let firstBinding = true;
    (batch as { _packet?: unknown })._packet = packet;

    const renderable: Renderable = {
        order: 100,
        isTransparent: false,
        bind(eng: EngineContext, sig: RenderTargetSignature): DrawBinding {
            // A binding is a render pass/camera (including an XR eye). Never let a
            // later recorded view overwrite an earlier view's uniforms or draw state.
            let drawPacket = packetByTarget.get(sig);
            if (!drawPacket) {
                drawPacket = firstBinding ? packet : createBindingPacket(eng, batch, packet);
                firstBinding = false;
                packetByTarget.set(sig, drawPacket);
                if (drawPacket !== packet) {
                    bindingPackets.push(drawPacket);
                }
            }
            const passPacket = drawPacket;
            let pipeline = getPipeline(eng, passPacket, sig, _scene);
            const updateBatch = getMeshLoDUpdateBatch(sig);
            return {
                renderable,
                get pipeline() {
                    return pipeline;
                },
                update: (context: DrawUpdateContext) => {
                    const nextPipeline = getPipeline(eng, passPacket, sig, _scene);
                    if (pipeline !== nextPipeline) {
                        pipeline = nextPipeline;
                        invalidateRenderBundles(eng);
                    }
                    updatePacket(eng, batch, passPacket, context, updateBatch);
                },
                draw: (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
                    if (batch.asset._runtime.disposed || !passPacket.activeBindGroup || !passPacket.activeIndirectBuffer) {
                        return 0;
                    }
                    pass.setBindGroup(1, passPacket.activeBindGroup);
                    pass.drawIndirect(passPacket.activeIndirectBuffer, 0);
                    return 1;
                },
                _updateBatches: [updateBatch],
            };
        },
    };
    return renderable;
}

function createBindingPacket(engine: EngineContext, batch: MeshLoDSceneBatch, shared: MeshLoDBatchPacket): MeshLoDBatchPacket {
    const device = engine._device;
    const drawVertexBuffer = device.createBuffer({ label: "mesh-lod-draw-vertices", size: shared.maxDrawVertices * DRAW_VERTEX_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    const instanceBuffer = device.createBuffer({ label: "mesh-lod-instances", size: shared.maxInstances * INSTANCE_STRIDE, usage: BU.STORAGE | BU.COPY_DST });
    const indirectBuffer = device.createBuffer({ label: "mesh-lod-indirect", size: 16, usage: BU.INDIRECT | BU.COPY_DST });
    const packet: MeshLoDBatchPacket = {
        ...shared,
        drawVertexBuffer,
        instanceBuffer,
        indirectBuffer,
        bindGroup: buildBindGroup(engine, shared.bindGroupLayout, batch.material, drawVertexBuffer, instanceBuffer, shared.arena, shared.materialUbo, shared.environment),
        drawScratch: new Uint32Array(shared.maxDrawVertices * 4),
        instanceScratch: new Float32Array(shared.maxInstances * INSTANCE_WORDS),
        indirectScratch: new Uint32Array(4),
        gpuInstanceState: null,
        gpuBatchState: null,
        gpuBindGroup: null,
        gpuBoundDrawVertices: null,
        gpuBoundInstances: null,
        activeBindGroup: null,
        activeIndirectBuffer: null,
        dispose: () => {
            if (packet.gpuBatchState) {
                batch.asset._runtime._frameSnapshots.delete(packet.gpuBatchState);
                disposeMeshLoDGpuBatchState(packet.gpuBatchState);
            }
            if (packet.gpuInstanceState) {
                disposeMeshLoDGpuInstanceState(packet.gpuInstanceState);
            }
            packet.drawVertexBuffer.destroy();
            packet.instanceBuffer.destroy();
            indirectBuffer.destroy();
        },
    };
    return packet;
}
