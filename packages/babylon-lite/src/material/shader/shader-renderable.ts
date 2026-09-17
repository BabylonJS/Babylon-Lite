import { F32, U32, I32, U8 } from "../../engine/typed-arrays.js";
import { BU } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh, MeshGPU } from "../../mesh/mesh.js";
import type { MeshGroupBuildResult, MeshRebuildResources, Renderable, DrawUpdateContext } from "../../render/renderable.js";
import type { Material } from "../material.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { createEmptyUniformBuffer } from "../../resource/empty-uniform-buffer.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix, getViewProjectionMatrix, _cameraChangeKey } from "../../camera/camera.js";
import type { Camera } from "../../camera/camera.js";
import { multiplyMat4IntoBuffer } from "../../math/multiply-mat4-into-buffer.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { ShaderAttributeName, ShaderMaterial, ShaderUniformType } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import { _isShaderSystemUniform } from "./shader-material.js";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "./shader-pipeline.js";
import type { UniformCopyBatch } from "../../render/uniform-copy-batch.js";
import { _getShaderVbSupport, type ShaderRenderPass, type ShaderVbLayout } from "./shader-vb-support.js";

type UniformBatchFactory = (signature: RenderTargetSignature) => UniformCopyBatch;

/** @internal Exported as a type only (zero runtime bytes) for the dynamically-imported
 *  thin-instance builder. */
export interface ShaderPacket {
    readonly mesh: Mesh;
    readonly systemUBO: GPUBuffer;
    readonly systemData: Float32Array;
    /** @internal Null only while `createPacket` is constructing the packet; a
     *  packet is never published unless bind-group creation succeeds. */
    _bindGroup: GPUBindGroup | null;
    /** @internal */
    _lastResourceVersion: number;
    /** @internal */
    _boundTextures: Texture2D[];
    /** @internal Missing constant vertex streams computed before allocating this packet. */
    _vertexMask?: number;
    /** @internal Set when the owning mesh is removed and this packet's GPU resources are
     *  destroyed. A combined (multi-mesh) renderable keeps every packet in its
     *  closure, so update()/draw() must skip disposed packets to avoid writing to
     *  or submitting an already-destroyed systemUBO / vertex buffer. */
    _disposed?: boolean;
    /** @internal Back-reference to the combined renderable's packet array, so disposal can
     *  splice this packet out and stop retaining/iterating dead chunk state every
     *  frame (set only for merged opaque renderables). */
    _owner?: ShaderPacket[];
    /** @internal Inputs of the last system-UBO write, used to skip redundant recompute + writeBuffer
     *  (see updatePacket). Undefined until the first per-pass update. */
    _lastCamera?: Camera | null;
    /** @internal */
    _lastCameraVersion?: number;
    /** @internal */
    _lastMeshWmVersion?: number;
    /** @internal */
    _lastTargetWidth?: number;
    /** @internal */
    _lastTargetHeight?: number;
    /** @internal Effective camera aspect (getEffectiveAspectRatio) at the last write — a `camera.viewport`
     *  change can alter the aspect (hence projection/viewProjection) while target size stays the same. */
    _lastAspect?: number;
    /** @internal */
    _lastAlphaCutoff?: number;
}

interface ShaderMaterialRenderState extends ShaderMaterial {
    _shaderBindings?: ShaderPipelineBindings;
    _shaderCustomUbo?: GPUBuffer | null;
    _shaderCustomSpec?: UboSpec | null;
    _shaderCustomData?: ArrayBuffer | null;
    _shaderCustomBytes?: Uint8Array<ArrayBuffer> | null;
    _shaderCustomVersion?: number;
}

/** @internal */
export type ShaderSystemUniformWriter = (
    data: Float32Array,
    spec: UboSpec,
    material: ShaderMaterial,
    mesh: Mesh,
    camera: Camera | null,
    targetWidth: number,
    targetHeight: number
) => void;

/** @internal */
export type ShaderCustomUniformWriter = (
    engine: EngineContext,
    material: ShaderMaterial,
    spec: UboSpec,
    data: ArrayBuffer,
    ubo: GPUBuffer,
    bytes: Uint8Array<ArrayBuffer>,
    uniformBatch?: UniformCopyBatch
) => void;

let systemUniformWriter: ShaderSystemUniformWriter = writeSystemUniforms;
let customUniformWriter: ShaderCustomUniformWriter = writeCustomUniforms;

/** @internal The default (uncached) system-uniform writer, exported so tests can
 *  exercise the writer that actually ships rather than a stand-in. Building a
 *  real renderable needs a GPU device; this needs nothing. Measured at zero
 *  bundle cost — Rollup drops it from every scene, since nothing the package
 *  entry reaches refers to it. */
export const _defaultShaderSystemUniformWriter: ShaderSystemUniformWriter = writeSystemUniforms;

/** @internal Install the optional cached ShaderMaterial uniform writers. */
export function _installShaderUniformWriters(systemWriter: ShaderSystemUniformWriter, customWriter: ShaderCustomUniformWriter): void {
    systemUniformWriter = systemWriter;
    customUniformWriter = customWriter;
}

/** @internal Mesh-specific base vertex layout captured for async pipeline preparation. */
export type ShaderAsyncVertexLayout = ShaderVbLayout;

export function buildShaderMaterialRenderables(scene: SceneContext, meshes: Mesh[], getUniformBatch?: UniformBatchFactory): MeshGroupBuildResult {
    const renderables: Renderable[] = [];

    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material, rebuildResources?: MeshRebuildResources): Renderable =>
        buildSingleShaderRenderable(s, mesh, (materialOverride ?? mesh.material) as ShaderMaterial, materialOverride != null, getUniformBatch, rebuildResources);

    const byMaterial = new Map<ShaderMaterial, Mesh[]>();
    for (const mesh of meshes) {
        const material = mesh.material as ShaderMaterial;
        let list = byMaterial.get(material);
        if (!list) {
            list = [];
            byMaterial.set(material, list);
        }
        list.push(mesh);
    }

    for (const [material, matMeshes] of byMaterial) {
        for (const renderable of buildMaterialRenderables(scene, material, matMeshes, false, getUniformBatch)) {
            renderables.push(renderable);
        }
    }

    return { renderables, rebuildSingle };
}

/** Async group entry point. Non-instanced ShaderMaterial scenes (the common case)
 *  take the synchronous fast path and pull in zero instancing code. When at least
 *  one mesh uses thin instances, the instancing module is dynamically imported and
 *  the renderable helpers it needs are handed to it as positional arguments — NOT
 *  module exports — so those helpers keep their mangled names in this chunk (an
 *  export would de-mangle them, growing every ShaderMaterial scene's bundle). */
export async function buildShaderGroup(scene: SceneContext, meshes: Mesh[]): Promise<MeshGroupBuildResult> {
    let getUniformBatch: UniformBatchFactory | undefined;
    if (meshes.length > 1) {
        const { getUniformCopyBatch } = await import("../../render/uniform-copy-batch.js");
        getUniformBatch = getUniformCopyBatch;
    }
    const firstMaterial = meshes[0]?.material;
    if (firstMaterial && meshes.some((mesh) => mesh.material !== firstMaterial)) {
        const { enableShaderPipelineCache } = await import("./shader-pipeline-cache.js");
        enableShaderPipelineCache(scene.surface.engine, meshes);
    }
    const buildPlain = (s: SceneContext, plainMeshes: Mesh[]): MeshGroupBuildResult => buildShaderMaterialRenderables(s, plainMeshes, getUniformBatch);
    if (!meshes.some((m) => !!m.thinInstances)) {
        return buildPlain(scene, meshes);
    }
    const mod = await import("./shader-thin-instance.js");
    const cull = meshes.some((m) => !!m.thinInstances?._gpuCullingEnabled) ? await import("../../mesh/thin-instance-cull-binding.js") : undefined;
    return mod.buildShaderRenderablesWithInstancing(
        scene,
        meshes,
        buildPlain,
        createPacket,
        updatePacket,
        updateCustomUbo,
        getAttrBuffer,
        getOrCreateShaderPipeline,
        getOrCreateShaderPipelineBindings,
        getUniformBatch,
        cull,
        _resolveShaderMeshVertexLayout,
        _asyncPipelineRegistrar
            ? (mesh, material, hasColor, vertexLayout) => _asyncPipelineRegistrar!(scene, material, mesh, hasColor ? "thin-instances-color" : "thin-instances", vertexLayout)
            : undefined
    );
}

/** @internal Resolve validated physical packing for explicit preparation and thin-instance builders. */
export function _resolveShaderMeshVertexLayout(material: ShaderMaterial, bindings: ShaderPipelineBindings, mesh?: Mesh): ShaderVbLayout | null {
    if (!mesh) {
        return null;
    }
    const support = _getShaderVbSupport();
    const missing = support?._validateMesh(material, mesh, _getShaderAttributeBuffer) ?? 0;
    return support?._forMesh(material, bindings, mesh, missing) ?? null;
}

export type ShaderAsyncPipelineRegistrar = (
    scene: SceneContext,
    material: ShaderMaterial,
    key: Renderable | Mesh,
    layout?: "thin-instances" | "thin-instances-color",
    vertexLayout?: ShaderAsyncVertexLayout
) => void;

let _asyncPipelineRegistrar: ShaderAsyncPipelineRegistrar | null = null;
/** @internal Install the optional async ShaderMaterial recipe registrar. */
export function _installAsyncShaderPipelineRegistrar(register: ShaderAsyncPipelineRegistrar): void {
    _asyncPipelineRegistrar = register;
}

function buildSingleShaderRenderable(
    scene: SceneContext,
    mesh: Mesh,
    material: ShaderMaterial,
    isOverride: boolean,
    getUniformBatch?: UniformBatchFactory,
    resources?: MeshRebuildResources
): Renderable {
    return buildMaterialRenderables(scene, material, [mesh], isOverride, getUniformBatch, resources)[0]!;
}

function buildMaterialRenderables(
    scene: SceneContext,
    material: ShaderMaterial,
    meshes: readonly Mesh[],
    isOverride = false,
    getUniformBatch?: UniformBatchFactory,
    resources?: MeshRebuildResources
): Renderable[] {
    const engine = scene.surface.engine;
    const vbRender = _getShaderVbSupport() ?? undefined;
    const missing = vbRender && meshes.map((mesh) => vbRender._validateMesh(material, mesh, _getShaderAttributeBuffer));
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    ensureCustomUbo(engine, material, bindings.customSpec);
    const packets = meshes.map((mesh, index) => createPacket(scene, material, bindings.systemSpec, mesh, resources, missing?.[index]));
    if (material.needAlphaBlending) {
        return packets.map((packet) =>
            createTransparentRenderable(
                scene,
                material,
                packet,
                isOverride,
                getUniformBatch,
                vbRender?._forMesh(material, bindings, packet.mesh, packet._vertexMask ?? 0) ?? undefined
            )
        );
    }
    // One opaque renderable resolves ONE pipeline for all its packets, so meshes that
    // describe their own vertex packing cannot share it with tightly-packed ones.
    const buildOpaque = (group: readonly ShaderPacket[]): Renderable =>
        createOpaqueRenderable(
            scene,
            material,
            group,
            isOverride,
            getUniformBatch,
            vbRender?._forMesh(material, bindings, group[0]!.mesh, group[0]!._vertexMask ?? 0) ?? undefined
        );
    const groups = vbRender?._group(packets);
    return groups ? Array.from(groups, buildOpaque) : [buildOpaque(packets)];
}

function createPacket(scene: SceneContext, material: ShaderMaterial, systemSpec: UboSpec, mesh: Mesh, resources?: MeshRebuildResources, vertexMask?: number): ShaderPacket {
    const engine = scene.surface.engine;
    const systemData = new F32(systemSpec._totalBytes / 4);
    systemUniformWriter(systemData, systemSpec, material, mesh, scene.camera, engine.canvas.width || 1, engine.canvas.height || 1);
    const systemUBO = createUniformBuffer(engine, systemData, "shader-system-ubo");
    const packet: ShaderPacket = {
        mesh,
        systemUBO,
        systemData,
        _bindGroup: null,
        _lastResourceVersion: material._resourceVersion,
        _boundTextures: [],
    };
    if (vertexMask) {
        packet._vertexMask = vertexMask;
    }
    registerMeshTextureDisposer(scene, mesh, packet, resources);
    packet._bindGroup = createShaderBindGroup(engine, material, systemUBO);
    for (const tex of collectShaderTextures(material)) {
        acquireTexture(tex);
        packet._boundTextures.push(tex);
    }
    return packet;
}

function createOpaqueRenderable(
    scene: SceneContext,
    material: ShaderMaterial,
    packets: readonly ShaderPacket[],
    isOverride: boolean,
    getUniformBatch?: UniformBatchFactory,
    asyncVertexLayout?: ShaderAsyncVertexLayout
): Renderable {
    let order = packets.length === 1 ? (packets[0]!.mesh.renderOrder ?? 100) : Infinity;
    // Only merged renderables (>1 mesh) can outlive an individual packet's mesh,
    // so give those packets a back-reference enabling disposal-time compaction.
    if (packets.length > 1) {
        for (const packet of packets) {
            packet._owner = packets as ShaderPacket[];
            order = Math.min(order, packet.mesh.renderOrder ?? 100);
        }
    }
    const update = (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void => {
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        for (const packet of packets) {
            if (packet._disposed || (!isOverride && packet.mesh.material !== material)) {
                continue;
            }
            updatePacket(scene, material, packet, context, uniformBatch);
        }
    };
    const draw = (pass: ShaderRenderPass, engine: EngineContext): number => {
        let draws = 0;
        for (const packet of packets) {
            if (packet._disposed || packet.mesh.visible === false || (!isOverride && packet.mesh.material !== material)) {
                continue;
            }
            drawPacket(pass, engine, material, packet);
            draws++;
        }
        return draws;
    };
    const r: Renderable = {
        order,
        isTransparent: false,
        mesh: packets.length === 1 ? packets[0]!.mesh : undefined,
        bind(eng, sig) {
            return createShaderBinding(eng, sig, material, r, update, draw, getUniformBatch, asyncVertexLayout);
        },
    };
    _asyncPipelineRegistrar?.(scene, material, r, undefined, asyncVertexLayout);
    return r;
}

function createTransparentRenderable(
    scene: SceneContext,
    material: ShaderMaterial,
    packet: ShaderPacket,
    isOverride: boolean,
    getUniformBatch?: UniformBatchFactory,
    asyncVertexLayout?: ShaderAsyncVertexLayout
): Renderable {
    const wm = packet.mesh.worldMatrix as unknown as ArrayLike<number>;
    const sortCenter: [number, number, number] = [wm[12]!, wm[13]!, wm[14]!];
    const update = (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void => {
        if (packet._disposed || (!isOverride && packet.mesh.material !== material)) {
            return;
        }
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        updatePacket(scene, material, packet, context, uniformBatch);
        const m = packet.mesh.worldMatrix as unknown as ArrayLike<number>;
        sortCenter[0] = m[12]!;
        sortCenter[1] = m[13]!;
        sortCenter[2] = m[14]!;
    };
    const draw = (pass: ShaderRenderPass, engine: EngineContext): number => {
        if (packet._disposed || (!isOverride && packet.mesh.material !== material)) {
            return 0;
        }
        drawPacket(pass, engine, material, packet);
        return 1;
    };
    const r: Renderable = {
        order: packet.mesh.renderOrder ?? 200,
        isTransparent: true,
        _transmissive: material.transmissive,
        mesh: packet.mesh,
        _worldCenter: sortCenter,
        bind(eng, sig) {
            return createShaderBinding(eng, sig, material, r, update, draw, getUniformBatch, asyncVertexLayout);
        },
    };
    _asyncPipelineRegistrar?.(scene, material, r, undefined, asyncVertexLayout);
    return r;
}

function createShaderBinding(
    engine: EngineContext,
    signature: RenderTargetSignature,
    material: ShaderMaterial,
    renderable: Renderable,
    update: (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch) => void,
    draw: (pass: ShaderRenderPass, engine: EngineContext) => number,
    getUniformBatch?: UniformBatchFactory,
    vertexLayout?: ShaderAsyncVertexLayout
): ReturnType<Renderable["bind"]> {
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    const uniformBatch = getUniformBatch?.(signature);
    return {
        renderable,
        pipeline: getOrCreateShaderPipeline(engine, signature, material, bindings, vertexLayout?._key, vertexLayout?._vbs),
        _updateBatches: uniformBatch ? [uniformBatch] : undefined,
        update: (context) => update(context, uniformBatch),
        draw: (pass) => draw(pass, engine),
    };
}

function updatePacket(scene: SceneContext, material: ShaderMaterial, packet: ShaderPacket, context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void {
    const engine = scene.surface.engine;
    const state = material as ShaderMaterialRenderState;
    // Skip the system-UBO recompute + writeBuffer when EVERY input is unchanged since this packet's last
    // write: same camera (identity + worldMatrixVersion — the same change key the view/projection caches
    // already rely on), same mesh world-matrix version, same target size and same material uniform version
    // (alphaCutoff). A packet is updated once per PASS per frame, and most packets are static meshes under
    // a camera that only moves some frames — these per-packet writeBuffers dominate CPU frame time in
    // large scenes, and the skipped ones are byte-identical rewrites of what the UBO already holds.
    const camera = context._camera ?? scene.camera;
    const cameraVersion = camera ? _cameraChangeKey(camera) : -1;
    const meshWmVersion = packet.mesh.worldMatrixVersion;
    // alphaCutoff is compared by VALUE, not by the material's uniform version: animated materials bump
    // that version every frame (time uniforms and the like live in the CUSTOM ubo, which has its own
    // version gate), and keying on it would defeat this skip for exactly the materials that dominate.
    const alphaCutoff = material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4;
    // Effective aspect keys the view/projection uniforms: getEffectiveAspectRatio folds in the camera's
    // normalized viewport, which can change (altering projection) with target size and worldMatrixVersion
    // both unchanged, so targetWidth/Height alone would not catch it.
    const aspect = camera ? getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight) : 1;
    if (
        packet._lastCamera !== camera ||
        packet._lastCameraVersion !== cameraVersion ||
        packet._lastMeshWmVersion !== meshWmVersion ||
        packet._lastTargetWidth !== context.targetWidth ||
        packet._lastTargetHeight !== context.targetHeight ||
        packet._lastAspect !== aspect ||
        packet._lastAlphaCutoff !== alphaCutoff
    ) {
        systemUniformWriter(packet.systemData, state._shaderBindings!.systemSpec, material, packet.mesh, camera, context.targetWidth, context.targetHeight);
        if (uniformBatch) {
            uniformBatch.queue(packet.systemUBO, packet.systemData);
        } else {
            engine._device.queue.writeBuffer(packet.systemUBO, 0, packet.systemData as Float32Array<ArrayBuffer>);
        }
        packet._lastCamera = camera;
        packet._lastCameraVersion = cameraVersion;
        packet._lastMeshWmVersion = meshWmVersion;
        packet._lastTargetWidth = context.targetWidth;
        packet._lastTargetHeight = context.targetHeight;
        packet._lastAspect = aspect;
        packet._lastAlphaCutoff = alphaCutoff;
    }
    if (packet._lastResourceVersion !== material._resourceVersion) {
        // Acquire the NEW bound textures BEFORE releasing the old set: a texture present in both (e.g. a material
        // that only swapped ONE of its textures) must never transiently drop to ref-count 0, or releaseTexture
        // would destroy a GPUTexture that the new bind group still uses. (Releasing first destroys a unique
        // ref-count-1 texture — exposed by a custom material binding a per-material texture nothing else shares.)
        const newTextures = collectShaderTextures(material);
        const acquiredTextures: Texture2D[] = [];
        let bindGroup: GPUBindGroup;
        try {
            bindGroup = createShaderBindGroup(engine, material, packet.systemUBO);
            for (const tex of newTextures) {
                acquireTexture(tex);
                acquiredTextures.push(tex);
            }
        } catch (error) {
            for (const tex of acquiredTextures) {
                releaseTexture(tex);
            }
            throw error;
        }
        const oldTextures = packet._boundTextures;
        packet._bindGroup = bindGroup;
        packet._boundTextures = acquiredTextures;
        packet._lastResourceVersion = material._resourceVersion;
        for (const tex of oldTextures) {
            releaseTexture(tex);
        }
    }
}

function _getShaderAttributeBuffer(mesh: Mesh, name: ShaderAttributeName): GPUBuffer | null {
    const gpu = mesh._gpu;
    switch (name) {
        case "position":
            return gpu.positionBuffer;
        case "normal":
            return gpu.normalBuffer ?? null;
        case "uv":
            return gpu.uvBuffer ?? null;
        case "uv2":
            return gpu.uv2Buffer ?? null;
        case "tangent":
            return gpu.tangentBuffer ?? null;
        case "color":
            return gpu.colorBuffer ?? null;
        case "joints":
            return getSkinBuffer(mesh, "jointsBuffer");
        case "weights":
            return getSkinBuffer(mesh, "weightsBuffer");
        case "joints1":
            return getSkinBuffer(mesh, "joints1Buffer");
        case "weights1":
            return getSkinBuffer(mesh, "weights1Buffer");
    }
}

function getSkinBuffer(mesh: Mesh, field: "jointsBuffer" | "weightsBuffer" | "joints1Buffer" | "weights1Buffer"): GPUBuffer | null {
    return mesh.vat?.[field] ?? mesh.skeleton?.[field] ?? null;
}

function drawPacket(pass: ShaderRenderPass, engine: EngineContext, material: ShaderMaterial, packet: ShaderPacket): void {
    const gpu = packet.mesh._gpu;
    const attributes = material.attributes;
    for (let i = 0; i < attributes.length; i++) {
        pass.setVertexBuffer(i, getAttrBuffer(engine, packet.mesh, attributes[i]!));
    }
    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
    pass.setBindGroup(1, packet._bindGroup!);
    pass.drawIndexed(gpu.indexCount, 1, 0, gpu._baseVertex);
}

function ensureCustomUbo(engine: EngineContext, material: ShaderMaterial, customSpec: UboSpec | null): void {
    const state = material as ShaderMaterialRenderState;
    if (!customSpec) {
        state._shaderCustomUbo = null;
        state._shaderCustomData = null;
        state._shaderCustomBytes = null;
        state._shaderCustomVersion = material._uniformVersion;
        return;
    }
    if (!state._shaderCustomUbo || !state._shaderCustomData) {
        state._shaderCustomUbo = createEmptyUniformBuffer(engine, customSpec._totalBytes, "shader-custom-ubo");
        state._shaderCustomData = new ArrayBuffer(customSpec._totalBytes);
        state._shaderCustomBytes = new U8(state._shaderCustomData);
        state._shaderCustomVersion = -1;
    }
    updateCustomUbo(engine, material);
}

function updateCustomUbo(engine: EngineContext, material: ShaderMaterial, uniformBatch?: UniformCopyBatch): void {
    const state = material as ShaderMaterialRenderState;
    const customSpec = state._shaderCustomSpec;
    const customUbo = state._shaderCustomUbo;
    const customData = state._shaderCustomData;
    if (!customSpec || !customUbo || !customData || state._shaderCustomVersion === material._uniformVersion) {
        return;
    }
    const bytes = state._shaderCustomBytes ?? (state._shaderCustomBytes = new U8(customData));
    customUniformWriter(engine, material, customSpec, customData, customUbo, bytes, uniformBatch);
    state._shaderCustomVersion = material._uniformVersion;
}

function writeCustomUniforms(
    engine: EngineContext,
    material: ShaderMaterial,
    spec: UboSpec,
    data: ArrayBuffer,
    ubo: GPUBuffer,
    bytes: Uint8Array<ArrayBuffer>,
    uniformBatch?: UniformCopyBatch
): void {
    bytes.fill(0);
    for (const [name, slot] of material._uniformValues) {
        if (_isShaderSystemUniform(name)) {
            continue;
        }
        const offset = spec._offsets.get(name);
        if (offset !== undefined) {
            writeTypedValue(data, offset, slot.decl.type, slot.value);
        }
    }
    if (uniformBatch) {
        uniformBatch.queue(ubo, bytes);
    } else {
        engine._device.queue.writeBuffer(ubo, 0, bytes);
    }
}

function writeTypedValue(data: ArrayBuffer, offset: number, type: ShaderUniformType, value: Float32Array): void {
    if (type === "u32") {
        new U32(data, offset, 1)[0] = value[0]!;
        return;
    }
    if (type === "i32") {
        new I32(data, offset, 1)[0] = value[0]!;
        return;
    }
    new F32(data, offset, value.length).set(value);
}

function createShaderBindGroup(engine: EngineContext, material: ShaderMaterial, systemUBO: GPUBuffer): GPUBindGroup {
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: systemUBO } }];
    let nextBinding = 1;
    if (bindings.customSpec) {
        ensureCustomUbo(engine, material, bindings.customSpec);
        entries.push({ binding: nextBinding++, resource: { buffer: (material as ShaderMaterialRenderState)._shaderCustomUbo! } });
    }
    for (const sampler of material.samplerDecls) {
        const slot = material._textureSlots.get(sampler.name);
        const tex = slot?.current;
        if (!tex) {
            throw new Error(`ShaderMaterial: sampler "${sampler.name}" has no Texture2D. Call setShaderTexture() before rendering.`);
        }
        entries.push({ binding: nextBinding++, resource: tex.view }, { binding: nextBinding++, resource: tex.sampler });
    }
    for (const storage of material.storageBufferDecls) {
        const slot = material._storageBufferSlots.get(storage.name);
        const storageBuffer = slot?.current;
        const buffer = storageBuffer?._buffer;
        if (!buffer || !engine._storageBuffers?.has(storageBuffer)) {
            throw new Error(`ShaderMaterial storage "${storage.name}" is invalid.`);
        }
        entries.push({ binding: nextBinding++, resource: { buffer } });
    }
    return engine._device.createBindGroup({ label: "shader-material-bg", layout: bindings.group1BGL, entries });
}

function collectShaderTextures(material: ShaderMaterial): Texture2D[] {
    const textures: Texture2D[] = [];
    for (const slot of material._textureSlots.values()) {
        if (slot.current) {
            textures.push(slot.current);
        }
    }
    return textures;
}

function registerMeshTextureDisposer(scene: SceneContext, mesh: Mesh, packet: ShaderPacket, resources?: MeshRebuildResources): void {
    const dispose = Object.assign(
        () => {
            packet._disposed = true;
            if (packet._owner) {
                const oi = packet._owner.indexOf(packet);
                if (oi >= 0) {
                    packet._owner.splice(oi, 1);
                }
                packet._owner = undefined;
            }
            packet.systemUBO.destroy();
            for (const tex of packet._boundTextures) {
                releaseTexture(tex);
            }
            packet._boundTextures = [];
        },
        { p: packet }
    );
    if (resources) {
        resources._lifetimeDisposers.push(dispose);
        return;
    }
    const list = scene._meshDisposables.get(mesh) ?? [];
    list.push(dispose);
    scene._meshDisposables.set(mesh, list);
}

/** @internal Scratch for the camera-relative mesh world matrix under floating
 *  origin. Module-scoped rather than per-packet: the writers are strictly
 *  synchronous and non-reentrant, and every read of the result completes before
 *  the next call can begin. Only used when the caller does not supply its own
 *  `out` destination — see `_shaderWorldMatrix`. */
const _foWorldScratch = new F32(16);

/** @internal The world matrix a ShaderMaterial's system uniforms must see.
 *
 *  Under floating origin `getViewMatrix` forces the view translation to zero,
 *  so nothing downstream re-centres the scene on the camera — establishing the
 *  eye-relative frame is the mesh-world pack's job. `standard`, `pbr` and
 *  `node` renderables do it by resolving `engine._makePackMeshWorld` once at
 *  construction; ShaderMaterial's writers are free functions handed only the
 *  camera, so the same offset (the camera's own world translation, which is
 *  exactly what `makePackMeshWorld` derives) is subtracted here.
 *
 *  Without this the mesh keeps its absolute world translation while the view
 *  matrix has none, and every ShaderMaterial mesh draws as though the camera
 *  sat at the world origin: its apparent position and size then depend only on
 *  where it is, never on where the viewer is. A distant object never gets any
 *  closer no matter how far you travel toward it.
 *
 *  Precision: when the mesh matrix is F64-backed (`useHighPrecisionMatrix`) the
 *  `large - large = small` subtraction happens at full F64 precision, and only
 *  the small remainder takes the F32 store — the same recovery trick as
 *  `packMat4IntoF32WithOffset`, which cannot be reused here because it lives in
 *  the LWR-only bundle this module must not statically import.
 *
 *  Keyed on `camera._useFloatingOrigin` rather than the engine flag so the test
 *  is bit-for-bit the one `getViewMatrix` applies to the same camera: a
 *  render-target task drawing through a non-scene camera gets an untranslated
 *  view AND an absolute world, which is consistent. Returns `mesh.worldMatrix`
 *  untouched when FO is off and no `out` is given, keeping the non-LWR path
 *  copy-free.
 *
 *  `out`: optional caller-owned destination. Omitted (the shipping renderable
 *  writers' only call shape), the function reuses the shared module-scratch
 *  buffer under FO and returns `mesh.worldMatrix` by reference when FO is off —
 *  zero allocation either way, but the result aliases module state that the
 *  NEXT call overwrites. Callers that need to hold two results at once (tests
 *  comparing this against another packer's output, for instance) pass their
 *  own `Float32Array(16)` and get a value that is theirs alone; the FO-off
 *  path then copies into it too, so `out` always means "the answer is here,"
 *  never "the answer is here, except sometimes." */
export function _shaderWorldMatrix(mesh: Mesh, camera: Camera | null, out?: Float32Array): Float32Array {
    const world = mesh.worldMatrix as unknown as Float32Array;
    if (!camera?._useFloatingOrigin) {
        if (!out) {
            return world;
        }
        out.set(world);
        return out;
    }
    const cw = camera.worldMatrix;
    const dst = out ?? _foWorldScratch;
    for (let i = 0; i < 12; i++) {
        dst[i] = world[i]!;
    }
    dst[12] = world[12]! - cw[12]!;
    dst[13] = world[13]! - cw[13]!;
    dst[14] = world[14]! - cw[14]!;
    dst[15] = world[15]!;
    return dst;
}

function writeSystemUniforms(data: Float32Array, spec: UboSpec, material: ShaderMaterial, mesh: Mesh, camera: Camera | null, targetWidth: number, targetHeight: number): void {
    data.fill(0);
    const world = _shaderWorldMatrix(mesh, camera);
    const aspect = camera ? getEffectiveAspectRatio(camera, targetWidth, targetHeight) : 1;
    const view = camera ? (getViewMatrix(camera) as unknown as Float32Array) : null;
    const projection = camera ? (getProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    const viewProjection = camera ? (getViewProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    for (const uniform of material.uniformDecls) {
        if (!_isShaderSystemUniform(uniform.name)) {
            continue;
        }
        const offset = spec._offsets.get(uniform.name);
        if (offset === undefined) {
            continue;
        }
        const f = offset / 4;
        switch (uniform.name) {
            case "world":
                data.set(world, f);
                break;
            case "view":
                if (view) {
                    data.set(view, f);
                }
                break;
            case "projection":
                if (projection) {
                    data.set(projection, f);
                }
                break;
            case "viewProjection":
                if (viewProjection) {
                    data.set(viewProjection, f);
                }
                break;
            case "worldView":
                if (view) {
                    multiplyMat4IntoBuffer(data, f, view, 0, world, 0);
                }
                break;
            case "worldViewProjection":
                if (viewProjection) {
                    multiplyMat4IntoBuffer(data, f, viewProjection, 0, world, 0);
                }
                break;
            case "cameraPosition":
                // Zero under floating origin, matching `_packSceneUniforms`'
                // `vEyePosition`: `world` above is camera-relative, so in the
                // frame the shader actually works in the camera IS the origin.
                // Writing the absolute position here would put the eye and the
                // geometry in two different frames.
                if (camera && !camera._useFloatingOrigin) {
                    const wm = camera.worldMatrix as unknown as ArrayLike<number>;
                    data[f] = wm[12]!;
                    data[f + 1] = wm[13]!;
                    data[f + 2] = wm[14]!;
                }
                break;
            case "screenSize":
                data[f] = targetWidth;
                data[f + 1] = targetHeight;
                break;
            case "alphaCutoff":
                data[f] = material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4;
                break;
        }
    }
}

let zeroAttrCache: WeakMap<object, Map<string, GPUBuffer>> | null = null;

function getZeroAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
    const constant = engine._getVertexDefaultBuffer?.(gpu);
    if (constant) {
        return constant;
    }
    if (!zeroAttrCache) {
        zeroAttrCache = new WeakMap();
    }
    let cache = zeroAttrCache.get(gpu as unknown as object);
    if (!cache) {
        cache = new Map();
        zeroAttrCache.set(gpu as unknown as object, cache);
    }
    const existing = cache.get(name);
    if (existing) {
        return existing;
    }
    const vertexCount = gpu.positionBuffer.size / 12;
    const stride = name === "uv" || name === "uv2" ? 8 : name === "normal" ? 12 : 16;
    const buffer = engine._device.createBuffer({ label: `shader-zero-${name}`, size: vertexCount * stride, usage: BU.VERTEX | BU.COPY_DST });
    cache.set(name, buffer);
    return buffer;
}

function getAttrBuffer(engine: EngineContext, mesh: Mesh, name: ShaderAttributeName): GPUBuffer {
    return _getShaderAttributeBuffer(mesh, name) ?? getZeroAttrBuffer(engine, mesh._gpu, name);
}
