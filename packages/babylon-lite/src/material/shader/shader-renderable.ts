import { F32, U32, I32, U8 } from "../../engine/typed-arrays.js";
import { BU } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh, MeshGPU } from "../../mesh/mesh.js";
import type { MeshGroupBuildResult, Renderable, DrawUpdateContext } from "../../render/renderable.js";
import type { Material } from "../material.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { createEmptyUniformBuffer } from "../../resource/gpu-buffers.js";
import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix, getViewProjectionMatrix, _cameraChangeKey } from "../../camera/camera.js";
import type { Camera } from "../../camera/camera.js";
import { mat4MultiplyInto } from "../../math/mat4-multiply-into.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { ShaderAttributeName, ShaderMaterial, ShaderUniformSlot } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import { _isShaderSystemUniform } from "./shader-material.js";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "./shader-pipeline.js";
import type { UniformCopyBatch } from "../../render/uniform-copy-batch.js";

type UniformBatchFactory = (signature: import("../../engine/render-target.js").RenderTargetSignature) => UniformCopyBatch;

/** @internal Exported as a type only (zero runtime bytes) for the dynamically-imported
 *  thin-instance builder. */
export interface ShaderPacket {
    readonly mesh: Mesh;
    readonly systemUBO: GPUBuffer;
    readonly systemData: Float32Array;
    /** @internal */
    _bindGroup: GPUBindGroup;
    /** @internal */
    _lastResourceVersion: number;
    /** @internal */
    _boundTextures: Texture2D[];
    /** @internal */
    _boundStorageBuffers: GPUBuffer[];
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
    _shaderCustomPlan?: CustomWritePlan;
    _shaderSystemPlan?: SystemWritePlan;
}

/** @internal Per-material serialization plan for the CUSTOM uniform block, resolved once per UBO
 *  allocation instead of re-walking `_uniformValues` + `spec._offsets` on every frame.
 *
 *  `_lastV[i]` is the value of `slots[i]._v` at this material's last serialization, so a frame that
 *  bumped `_uniformVersion` rewrites ONLY the slots whose own counter moved. On the live game save a
 *  bumped material typically has 2-3 of ~40 slots actually changed, so this skips ~93% of the writes.
 *  The counter lives on the SLOT (not on a proxy over its array — the 2026-08-03 `?urange` experiment
 *  proved per-element interception costs far more than the serialization it saves), and it is set at
 *  the single choke point that already compares old vs new (`setUniformValue`), so marking is one
 *  integer increment on a branch that was taken anyway. */
interface CustomWritePlan {
    /** Material this plan was resolved for — a material VIEW inherits `_shaderCustomPlan` through its
     *  prototype chain, so identity must be checked, not just presence. */
    readonly owner: ShaderMaterial;
    /** Backing store identity: a new UBO allocation (device loss, HMR, shader rebuild) invalidates the plan. */
    readonly data: ArrayBuffer;
    readonly size: number;
    readonly f32: Float32Array;
    readonly u32: Uint32Array;
    readonly i32: Int32Array;
    readonly slots: readonly ShaderUniformSlot[];
    /** Element index (not byte offset) into the view selected by `_kinds`. */
    readonly _index: Int32Array;
    /** 0 = f32 (length elements), 1 = u32 (1 element), 2 = i32 (1 element). */
    readonly _kinds: Uint8Array;
    /** Element count per slot — fixed at slot creation, so the write loop never reloads `value.length`. */
    readonly _lens: Int32Array;
    readonly _lastV: Int32Array;
}

/** @internal System-uniform opcodes — a numeric switch replaces the per-uniform name lookup +
 *  string switch `writeSystemUniforms` used to run for every packet, every pass, every frame. */
const OP_WORLD = 0;
const OP_VIEW = 1;
const OP_PROJECTION = 2;
const OP_VIEW_PROJECTION = 3;
const OP_WORLD_VIEW = 4;
const OP_WORLD_VIEW_PROJECTION = 5;
const OP_CAMERA_POSITION = 6;
const OP_SCREEN_SIZE = 7;
const OP_ALPHA_CUTOFF = 8;

/** @internal Per-material plan for the SYSTEM uniform block (see `CustomWritePlan` for the ownership rules). */
interface SystemWritePlan {
    readonly owner: ShaderMaterial;
    readonly spec: UboSpec;
    readonly ops: Uint8Array;
    /** Float index into the packet's `systemData` for each op. */
    readonly _at: Int32Array;
    /** The `alphaCutoff` slot resolved once, for both the system write and `updatePacket`'s skip test. */
    readonly alphaSlot: ShaderUniformSlot | undefined;
}

const SYS_OPS: Record<string, number> = {
    world: OP_WORLD,
    view: OP_VIEW,
    projection: OP_PROJECTION,
    viewProjection: OP_VIEW_PROJECTION,
    worldView: OP_WORLD_VIEW,
    worldViewProjection: OP_WORLD_VIEW_PROJECTION,
    cameraPosition: OP_CAMERA_POSITION,
    screenSize: OP_SCREEN_SIZE,
    alphaCutoff: OP_ALPHA_CUTOFF,
};

function getSystemPlan(material: ShaderMaterial, spec: UboSpec): SystemWritePlan {
    const state = material as ShaderMaterialRenderState;
    const cached = state._shaderSystemPlan;
    if (cached && cached.owner === material && cached.spec === spec) {
        return cached;
    }
    const ops: number[] = [];
    const at: number[] = [];
    for (const uniform of material.uniformDecls) {
        if (!_isShaderSystemUniform(uniform.name)) {
            continue;
        }
        const offset = spec._offsets.get(uniform.name);
        if (offset === undefined) {
            continue;
        }
        ops.push(SYS_OPS[uniform.name]!);
        at.push(offset / 4);
    }
    const plan: SystemWritePlan = {
        owner: material,
        spec,
        ops: new U8(ops),
        _at: new I32(at),
        alphaSlot: material._uniformValues.get("alphaCutoff"),
    };
    state._shaderSystemPlan = plan;
    return plan;
}

function getCustomPlan(material: ShaderMaterial, spec: UboSpec, data: ArrayBuffer): CustomWritePlan {
    const state = material as ShaderMaterialRenderState;
    const cached = state._shaderCustomPlan;
    if (cached && cached.owner === material && cached.data === data && cached.size === material._uniformValues.size) {
        return cached;
    }
    const slots: ShaderUniformSlot[] = [];
    const index: number[] = [];
    const kinds: number[] = [];
    const lens: number[] = [];
    for (const [name, slot] of material._uniformValues) {
        if (_isShaderSystemUniform(name)) {
            continue;
        }
        const offset = spec._offsets.get(name);
        if (offset === undefined) {
            continue;
        }
        // Give the counter a numeric identity up front. Slots cloned by a material view may arrive without
        // one; leaving it `undefined` would both make the hot compare polymorphic and, more importantly,
        // never compare equal to a stored counter — a correct but permanently-rewriting slot.
        if (typeof slot._v !== "number") {
            slot._v = 0;
        }
        slots.push(slot);
        const type = slot.decl.type;
        kinds.push(type === "u32" ? 1 : type === "i32" ? 2 : 0);
        index.push(offset / 4);
        lens.push(slot.value.length);
    }
    const plan: CustomWritePlan = {
        owner: material,
        data,
        size: material._uniformValues.size,
        f32: new F32(data),
        u32: new U32(data),
        i32: new I32(data),
        slots,
        _index: new I32(index),
        _kinds: new U8(kinds),
        _lens: new I32(lens),
        // -1 can never equal a slot counter (they start at 0 and only increment), so the first pass over a
        // fresh plan writes every slot — the full initialization the old unconditional loop performed.
        _lastV: new I32(slots.length).fill(-1),
    };
    state._shaderCustomPlan = plan;
    return plan;
}

/** @internal */
export type ShaderRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

export function buildShaderMaterialRenderables(scene: SceneContext, meshes: Mesh[], getUniformBatch?: UniformBatchFactory): MeshGroupBuildResult {
    const renderables: Renderable[] = [];

    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable =>
        buildSingleShaderRenderable(s, mesh, (materialOverride ?? mesh.material) as ShaderMaterial, materialOverride != null, getUniformBatch);

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
        const built = buildMaterialRenderables(scene, material, matMeshes, false, getUniformBatch);
        renderables.push(...built);
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
        cull
    );
}

function buildSingleShaderRenderable(scene: SceneContext, mesh: Mesh, material: ShaderMaterial, isOverride: boolean, getUniformBatch?: UniformBatchFactory): Renderable {
    return buildMaterialRenderables(scene, material, [mesh], isOverride, getUniformBatch)[0]!;
}

function buildMaterialRenderables(scene: SceneContext, material: ShaderMaterial, meshes: readonly Mesh[], isOverride = false, getUniformBatch?: UniformBatchFactory): Renderable[] {
    const engine = scene.surface.engine;
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    ensureCustomUbo(engine, material, bindings.customSpec);
    // `isOverride` marks an AUX view packet (a material-override registered into an explicit task, e.g. a
    // depth/SSAO no-colour view) — route its disposer to `_meshAuxDisposables` so a MAIN-material swap of this
    // same mesh does not tear it down out from under that task.
    const packets = meshes.map((mesh) => createPacket(scene, material, bindings.systemSpec, mesh, isOverride));
    const isTransparent = material.needAlphaBlending;
    if (isTransparent) {
        return packets.map((packet) => createTransparentRenderable(scene, material, packet, isOverride, getUniformBatch));
    }
    return [createOpaqueRenderable(scene, material, packets, isOverride, getUniformBatch)];
}

function createPacket(scene: SceneContext, material: ShaderMaterial, systemSpec: UboSpec, mesh: Mesh, aux = false): ShaderPacket {
    const engine = scene.surface.engine;
    const systemUBO = createEmptyUniformBuffer(engine, systemSpec._totalBytes, "shader-system-ubo");
    const systemData = new F32(systemSpec._totalBytes / 4);
    writeSystemUniforms(systemData, getSystemPlan(material, systemSpec), mesh, scene.camera, engine.canvas.width || 1, engine.canvas.height || 1);
    engine._device.queue.writeBuffer(systemUBO, 0, systemData);
    const packet: ShaderPacket = {
        mesh,
        systemUBO,
        systemData,
        _bindGroup: createShaderBindGroup(engine, material, systemUBO),
        _lastResourceVersion: material._resourceVersion,
        _boundTextures: collectShaderTextures(material),
        _boundStorageBuffers: collectShaderStorageBuffers(material),
    };
    for (const tex of packet._boundTextures) {
        acquireTexture(tex);
    }
    registerMeshTextureDisposer(scene, mesh, packet, aux);
    return packet;
}

function createOpaqueRenderable(
    scene: SceneContext,
    material: ShaderMaterial,
    packets: readonly ShaderPacket[],
    isOverride: boolean,
    getUniformBatch?: UniformBatchFactory
): Renderable {
    // Only merged renderables (>1 mesh) can outlive an individual packet's mesh,
    // so give those packets a back-reference enabling disposal-time compaction.
    if (packets.length > 1) {
        for (const packet of packets) {
            packet._owner = packets as ShaderPacket[];
        }
    }
    const update = (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void => {
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        for (const packet of packets) {
            if (packet._disposed) {
                continue;
            }
            if (!isOverride && packet.mesh.material !== material) {
                continue;
            }
            updatePacket(scene, material, packet, context, uniformBatch);
        }
    };
    const draw = (pass: ShaderRenderPass, engine: EngineContext): number => {
        let draws = 0;
        for (const packet of packets) {
            if (packet._disposed) {
                continue;
            }
            if (!isOverride && packet.mesh.material !== material) {
                continue;
            }
            drawPacket(pass, engine, material, packet);
            draws++;
        }
        return draws;
    };
    const r: Renderable = {
        order: packets.length === 1 ? (packets[0]!.mesh.renderOrder ?? 100) : Math.min(...packets.map((p) => p.mesh.renderOrder ?? 100)),
        isTransparent: false,
        mesh: packets.length === 1 ? packets[0]!.mesh : undefined,
        bind(eng, sig) {
            const bindings = getOrCreateShaderPipelineBindings(eng, material);
            const uniformBatch = getUniformBatch?.(sig);
            return {
                renderable: r,
                pipeline: getOrCreateShaderPipeline(eng, sig, material, bindings),
                _updateBatches: uniformBatch ? [uniformBatch] : undefined,
                update: (context) => update(context, uniformBatch),
                draw: (pass) => draw(pass, eng),
            };
        },
    };
    return r;
}

function createTransparentRenderable(scene: SceneContext, material: ShaderMaterial, packet: ShaderPacket, isOverride: boolean, getUniformBatch?: UniformBatchFactory): Renderable {
    const wm = packet.mesh.worldMatrix as unknown as ArrayLike<number>;
    const sortCenter: [number, number, number] = [wm[12]!, wm[13]!, wm[14]!];
    const update = (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void => {
        if (packet._disposed) {
            return;
        }
        if (!isOverride && packet.mesh.material !== material) {
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
        if (packet._disposed) {
            return 0;
        }
        if (!isOverride && packet.mesh.material !== material) {
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
            const bindings = getOrCreateShaderPipelineBindings(eng, material);
            const uniformBatch = getUniformBatch?.(sig);
            return {
                renderable: r,
                pipeline: getOrCreateShaderPipeline(eng, sig, material, bindings),
                _updateBatches: uniformBatch ? [uniformBatch] : undefined,
                update: (context) => update(context, uniformBatch),
                draw: (pass) => draw(pass, eng),
            };
        },
    };
    return r;
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
    // The plan resolves the system layout AND the alphaCutoff slot once per material, so neither this skip
    // test nor the write below re-walks `_uniformValues` for every packet of every pass.
    const plan = getSystemPlan(material, state._shaderBindings!.systemSpec);
    // alphaCutoff is compared by VALUE, not by the material's uniform version: animated materials bump
    // that version every frame (time uniforms and the like live in the CUSTOM ubo, which has its own
    // version gate), and keying on it would defeat this skip for exactly the materials that dominate.
    const alphaCutoff = plan.alphaSlot?.value[0] ?? 0.4;
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
        writeSystemUniforms(packet.systemData, plan, packet.mesh, camera, context.targetWidth, context.targetHeight);
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
        for (const tex of newTextures) {
            acquireTexture(tex);
        }
        for (const tex of packet._boundTextures) {
            releaseTexture(tex);
        }
        packet._bindGroup = createShaderBindGroup(engine, material, packet.systemUBO);
        packet._boundTextures = newTextures;
        packet._boundStorageBuffers = collectShaderStorageBuffers(material);
        packet._lastResourceVersion = material._resourceVersion;
    }
}

function drawPacket(pass: ShaderRenderPass, engine: EngineContext, material: ShaderMaterial, packet: ShaderPacket): void {
    const gpu = packet.mesh._gpu;
    for (let i = 0; i < material.attributes.length; i++) {
        pass.setVertexBuffer(i, getAttrBuffer(engine, packet.mesh, material.attributes[i]!));
    }
    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
    pass.setBindGroup(1, packet._bindGroup);
    pass.drawIndexed(gpu.indexCount);
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
    if (state._shaderCustomUbo && state._shaderCustomData) {
        updateCustomUbo(engine, material);
        return;
    }
    state._shaderCustomUbo = createEmptyUniformBuffer(engine, customSpec._totalBytes, "shader-custom-ubo");
    state._shaderCustomData = new ArrayBuffer(customSpec._totalBytes);
    state._shaderCustomBytes = new U8(state._shaderCustomData);
    state._shaderCustomVersion = -1;
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
    // Serialize only the slots whose own counter moved since THIS material last wrote them. The material's
    // `_uniformVersion` says "something changed"; the per-slot counters say WHAT — and on the live game save a
    // bumped material has ~4-8% of its slots actually moving (one shared per-frame scene value such as time or
    // sun direction bumps every material's version). The old loop re-walked the whole `_uniformValues` map,
    // re-resolved each offset, and allocated a fresh typed-array view per value; the plan's cached views and
    // counters remove all three. The staged bytes remain a full, always-valid image of the UBO, so the upload
    // stays a whole-buffer copy — no partial ranges, and the GPU sees byte-identical contents.
    const plan = getCustomPlan(material, customSpec, customData);
    const slots = plan.slots;
    const lastV = plan._lastV;
    const index = plan._index;
    const kinds = plan._kinds;
    const lens = plan._lens;
    const f32 = plan.f32;
    const count = slots.length;
    let wrote = false;
    for (let i = 0; i < count; i++) {
        const slot = slots[i]!;
        const v = slot._v!;
        if (v === lastV[i]) {
            continue;
        }
        lastV[i] = v;
        wrote = true;
        const at = index[i]!;
        const value = slot.value;
        const kind = kinds[i]!;
        if (kind === 1) {
            plan.u32[at] = value[0]!;
        } else if (kind === 2) {
            plan.i32[at] = value[0]!;
        } else {
            const n = lens[i]!;
            if (n === 1) {
                f32[at] = value[0]!;
            } else {
                // Typed-array `set` is a memcpy for the mat4/vec4 slots that dominate byte volume.
                f32.set(value, at);
            }
        }
    }
    // A version bump with no custom slot behind it (an `alphaCutoff`-only write, or a slot this material's
    // block does not carry) leaves the staged bytes untouched, so the upload would be a byte-identical rewrite.
    if (!wrote) {
        state._shaderCustomVersion = material._uniformVersion;
        return;
    }
    if (uniformBatch) {
        uniformBatch.queue(customUbo, bytes);
    } else {
        engine._device.queue.writeBuffer(customUbo, 0, bytes);
    }
    state._shaderCustomVersion = material._uniformVersion;
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

function collectShaderStorageBuffers(material: ShaderMaterial): GPUBuffer[] {
    const buffers: GPUBuffer[] = [];
    for (const slot of material._storageBufferSlots.values()) {
        if (slot.current) {
            const buffer = slot.current._buffer;
            if (buffer) {
                buffers.push(buffer);
            }
        }
    }
    return buffers;
}

function registerMeshTextureDisposer(scene: SceneContext, mesh: Mesh, packet: ShaderPacket, aux = false): void {
    // Aux (override) view packets go in `_meshAuxDisposables` so a main-material swap leaves them alone; main
    // packets stay in `_meshDisposables` (torn down + rebuilt by the swap drain). Both are drained on real removal.
    const map = aux ? scene._meshAuxDisposables : scene._meshDisposables;
    const list = map.get(mesh) ?? [];
    list.push(
        Object.assign(
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
                packet._boundStorageBuffers = [];
            },
            { p: packet }
        )
    );
    map.set(mesh, list);
}

/** Fill one packet's system block. Driven by the material's cached `SystemWritePlan` (opcodes + float
 *  indices resolved once) rather than re-walking `uniformDecls` and `spec._offsets` per packet per pass:
 *  during a camera move EVERY packet rewrites this block, so the per-uniform map lookup and string switch
 *  were pure per-frame overhead.
 *
 *  The old `data.fill(0)` is gone: `data` is allocated zeroed and every declared uniform below writes its
 *  full slot on every call (matrix slots explicitly zero themselves when there is no camera, exactly as the
 *  clear-then-skip pair used to), so padding bytes are untouched and the block is byte-identical. */
function writeSystemUniforms(data: Float32Array, plan: SystemWritePlan, mesh: Mesh, camera: Camera | null, targetWidth: number, targetHeight: number): void {
    const world = mesh.worldMatrix as unknown as Float32Array;
    const aspect = camera ? getEffectiveAspectRatio(camera, targetWidth, targetHeight) : 1;
    const view = camera ? (getViewMatrix(camera) as unknown as Float32Array) : null;
    const projection = camera ? (getProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    const viewProjection = camera ? (getViewProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
    const ops = plan.ops;
    const at = plan._at;
    for (let i = 0; i < ops.length; i++) {
        const f = at[i]!;
        switch (ops[i]!) {
            case OP_WORLD:
                data.set(world, f);
                break;
            case OP_VIEW:
                view ? data.set(view, f) : data.fill(0, f, f + 16);
                break;
            case OP_PROJECTION:
                projection ? data.set(projection, f) : data.fill(0, f, f + 16);
                break;
            case OP_VIEW_PROJECTION:
                viewProjection ? data.set(viewProjection, f) : data.fill(0, f, f + 16);
                break;
            case OP_WORLD_VIEW:
                view ? mat4MultiplyInto(data, f, view, 0, world, 0) : data.fill(0, f, f + 16);
                break;
            case OP_WORLD_VIEW_PROJECTION:
                viewProjection ? mat4MultiplyInto(data, f, viewProjection, 0, world, 0) : data.fill(0, f, f + 16);
                break;
            case OP_CAMERA_POSITION:
                if (camera) {
                    const wm = camera.worldMatrix as unknown as ArrayLike<number>;
                    data[f] = wm[12]!;
                    data[f + 1] = wm[13]!;
                    data[f + 2] = wm[14]!;
                } else {
                    data[f] = data[f + 1] = data[f + 2] = 0;
                }
                break;
            case OP_SCREEN_SIZE:
                data[f] = targetWidth;
                data[f + 1] = targetHeight;
                break;
            case OP_ALPHA_CUTOFF:
                data[f] = plan.alphaSlot?.value[0] ?? 0.4;
                break;
        }
    }
}

let zeroAttrCache: WeakMap<object, Map<string, GPUBuffer>> | null = null;

function getZeroAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
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

/** Skinning vertex buffers live on the mesh's `skeleton` (live skinning) or `vat` (baked vertex
 *  animation, which moves them off the dropped skeleton) — not on `MeshGPU`. */
function getSkinBuffer(mesh: Mesh, field: "jointsBuffer" | "weightsBuffer" | "joints1Buffer" | "weights1Buffer"): GPUBuffer | null {
    return mesh.vat?.[field] ?? mesh.skeleton?.[field] ?? null;
}

function getAttrBuffer(engine: EngineContext, mesh: Mesh, name: ShaderAttributeName): GPUBuffer {
    const gpu = mesh._gpu;
    switch (name) {
        case "position":
            return gpu.positionBuffer;
        case "normal":
            return gpu.normalBuffer ?? getZeroAttrBuffer(engine, gpu, "normal");
        case "uv":
            return gpu.uvBuffer ?? getZeroAttrBuffer(engine, gpu, "uv");
        case "uv2":
            return gpu.uv2Buffer ?? getZeroAttrBuffer(engine, gpu, "uv2");
        case "tangent":
            return gpu.tangentBuffer ?? getZeroAttrBuffer(engine, gpu, "tangent");
        case "color":
            return gpu.colorBuffer ?? getZeroAttrBuffer(engine, gpu, "color");
        case "joints":
            return getSkinBuffer(mesh, "jointsBuffer") ?? getZeroAttrBuffer(engine, gpu, "joints");
        case "weights":
            return getSkinBuffer(mesh, "weightsBuffer") ?? getZeroAttrBuffer(engine, gpu, "weights");
        case "joints1":
            return getSkinBuffer(mesh, "joints1Buffer") ?? getZeroAttrBuffer(engine, gpu, "joints1");
        case "weights1":
            return getSkinBuffer(mesh, "weights1Buffer") ?? getZeroAttrBuffer(engine, gpu, "weights1");
    }
}
