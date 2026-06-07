import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh, MeshGPU } from "../../mesh/mesh.js";
import type { MeshGroupBuildResult, Renderable, DrawUpdateContext } from "../../render/renderable.js";
import type { Material } from "../material.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { createEmptyUniformBuffer } from "../../resource/gpu-buffers.js";
import { acquireTexture, releaseTexture } from "../../resource/gpu-pool.js";
import { getEffectiveAspectRatio, getProjectionMatrix, getViewMatrix, getViewProjectionMatrix } from "../../camera/camera.js";
import type { Camera } from "../../camera/camera.js";
import { mat4MultiplyInto } from "../../math/mat4-multiply-into.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { ShaderAttributeName, ShaderMaterial, ShaderUniformType } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import { _isShaderSystemUniform } from "./shader-material.js";
import { getOrCreateShaderPipeline, getOrCreateShaderPipelineBindings } from "./shader-pipeline.js";

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
    /** @internal Set when the owning mesh is removed and this packet's GPU resources are
     *  destroyed. A combined (multi-mesh) renderable keeps every packet in its
     *  closure, so update()/draw() must skip disposed packets to avoid writing to
     *  or submitting an already-destroyed systemUBO / vertex buffer. */
    _disposed?: boolean;
    /** @internal Back-reference to the combined renderable's packet array, so disposal can
     *  splice this packet out and stop retaining/iterating dead chunk state every
     *  frame (set only for merged opaque renderables). */
    _owner?: ShaderPacket[];
}

interface ShaderMaterialRenderState extends ShaderMaterial {
    _shaderBindings?: ShaderPipelineBindings;
    _shaderCustomUbo?: GPUBuffer | null;
    _shaderCustomSpec?: UboSpec | null;
    _shaderCustomData?: ArrayBuffer | null;
    _shaderCustomVersion?: number;
}

/** @internal */
export type ShaderRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

export function buildShaderMaterialRenderables(scene: SceneContext, meshes: Mesh[]): MeshGroupBuildResult {
    const renderables: Renderable[] = [];

    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable =>
        buildSingleShaderRenderable(s, mesh, (materialOverride ?? mesh.material) as ShaderMaterial, materialOverride != null);

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
        const built = buildMaterialRenderables(scene, material, matMeshes);
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
    if (!meshes.some((m) => !!m.thinInstances)) {
        return buildShaderMaterialRenderables(scene, meshes);
    }
    const mod = await import("./shader-thin-instance.js");
    const cull = meshes.some((m) => !!m.thinInstances?._gpuCullingEnabled) ? await import("../../mesh/thin-instance-cull-binding.js") : undefined;
    return mod.buildShaderRenderablesWithInstancing(
        scene,
        meshes,
        buildShaderMaterialRenderables,
        createPacket,
        updatePacket,
        updateCustomUbo,
        getAttrBuffer,
        getOrCreateShaderPipeline,
        getOrCreateShaderPipelineBindings,
        cull
    );
}

function buildSingleShaderRenderable(scene: SceneContext, mesh: Mesh, material: ShaderMaterial, isOverride: boolean): Renderable {
    return buildMaterialRenderables(scene, material, [mesh], isOverride)[0]!;
}

function buildMaterialRenderables(scene: SceneContext, material: ShaderMaterial, meshes: readonly Mesh[], isOverride = false): Renderable[] {
    const engine = scene.engine;
    const bindings = getOrCreateShaderPipelineBindings(engine, material);
    ensureCustomUbo(engine, material, bindings.customSpec);
    const packets = meshes.map((mesh) => createPacket(scene, material, bindings.systemSpec, mesh));
    const isTransparent = material.needAlphaBlending;
    if (isTransparent) {
        return packets.map((packet) => createTransparentRenderable(scene, material, packet, isOverride));
    }
    return [createOpaqueRenderable(scene, material, packets, isOverride)];
}

function createPacket(scene: SceneContext, material: ShaderMaterial, systemSpec: UboSpec, mesh: Mesh): ShaderPacket {
    const engine = scene.engine;
    const systemUBO = createEmptyUniformBuffer(engine, systemSpec._totalBytes, "shader-system-ubo");
    const systemData = new Float32Array(systemSpec._totalBytes / 4);
    writeSystemUniforms(systemData, systemSpec, material, mesh, scene.camera, engine.canvas.width || 1, engine.canvas.height || 1);
    engine._device.queue.writeBuffer(systemUBO, 0, systemData);
    const packet: ShaderPacket = {
        mesh,
        systemUBO,
        systemData,
        _bindGroup: createShaderBindGroup(engine, material, systemUBO),
        _lastResourceVersion: material._resourceVersion,
        _boundTextures: collectShaderTextures(material),
    };
    for (const tex of packet._boundTextures) {
        acquireTexture(tex);
    }
    registerMeshTextureDisposer(scene, mesh, packet);
    return packet;
}

function createOpaqueRenderable(scene: SceneContext, material: ShaderMaterial, packets: readonly ShaderPacket[], isOverride: boolean): Renderable {
    // Only merged renderables (>1 mesh) can outlive an individual packet's mesh,
    // so give those packets a back-reference enabling disposal-time compaction.
    if (packets.length > 1) {
        for (const packet of packets) {
            packet._owner = packets as ShaderPacket[];
        }
    }
    const update = (context: DrawUpdateContext): void => {
        updateCustomUbo(scene.engine, material);
        for (const packet of packets) {
            if (packet._disposed) {
                continue;
            }
            if (!isOverride && packet.mesh.material !== material) {
                continue;
            }
            updatePacket(scene, material, packet, context);
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
            return { renderable: r, pipeline: getOrCreateShaderPipeline(eng, sig, material, bindings), update, draw: (pass) => draw(pass, eng) };
        },
    };
    return r;
}

function createTransparentRenderable(scene: SceneContext, material: ShaderMaterial, packet: ShaderPacket, isOverride: boolean): Renderable {
    const wm = packet.mesh.worldMatrix as unknown as ArrayLike<number>;
    const sortCenter: [number, number, number] = [wm[12]!, wm[13]!, wm[14]!];
    const update = (context: DrawUpdateContext): void => {
        if (packet._disposed) {
            return;
        }
        if (!isOverride && packet.mesh.material !== material) {
            return;
        }
        updateCustomUbo(scene.engine, material);
        updatePacket(scene, material, packet, context);
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
        mesh: packet.mesh,
        _worldCenter: sortCenter,
        bind(eng, sig) {
            const bindings = getOrCreateShaderPipelineBindings(eng, material);
            return { renderable: r, pipeline: getOrCreateShaderPipeline(eng, sig, material, bindings), update, draw: (pass) => draw(pass, eng) };
        },
    };
    return r;
}

function updatePacket(scene: SceneContext, material: ShaderMaterial, packet: ShaderPacket, context: DrawUpdateContext): void {
    const engine = scene.engine;
    const state = material as ShaderMaterialRenderState;
    writeSystemUniforms(packet.systemData, state._shaderBindings!.systemSpec, material, packet.mesh, context._camera ?? scene.camera, context.targetWidth, context.targetHeight);
    engine._device.queue.writeBuffer(packet.systemUBO, 0, packet.systemData as Float32Array<ArrayBuffer>);
    if (packet._lastResourceVersion !== material._resourceVersion) {
        for (const tex of packet._boundTextures) {
            releaseTexture(tex);
        }
        packet._bindGroup = createShaderBindGroup(engine, material, packet.systemUBO);
        packet._boundTextures = collectShaderTextures(material);
        for (const tex of packet._boundTextures) {
            acquireTexture(tex);
        }
        packet._lastResourceVersion = material._resourceVersion;
    }
}

function drawPacket(pass: ShaderRenderPass, engine: EngineContext, material: ShaderMaterial, packet: ShaderPacket): void {
    const gpu = packet.mesh._gpu;
    for (let i = 0; i < material.attributes.length; i++) {
        pass.setVertexBuffer(i, getAttrBuffer(engine, gpu, material.attributes[i]!));
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
        state._shaderCustomVersion = material._uniformVersion;
        return;
    }
    if (state._shaderCustomUbo && state._shaderCustomData) {
        updateCustomUbo(engine, material);
        return;
    }
    state._shaderCustomUbo = createEmptyUniformBuffer(engine, customSpec._totalBytes, "shader-custom-ubo");
    state._shaderCustomData = new ArrayBuffer(customSpec._totalBytes);
    state._shaderCustomVersion = -1;
    updateCustomUbo(engine, material);
}

function updateCustomUbo(engine: EngineContext, material: ShaderMaterial): void {
    const state = material as ShaderMaterialRenderState;
    const customSpec = state._shaderCustomSpec;
    const customUbo = state._shaderCustomUbo;
    const customData = state._shaderCustomData;
    if (!customSpec || !customUbo || !customData || state._shaderCustomVersion === material._uniformVersion) {
        return;
    }
    const bytes = new Uint8Array(customData);
    bytes.fill(0);
    for (const [name, slot] of material._uniformValues) {
        if (_isShaderSystemUniform(name)) {
            continue;
        }
        const offset = customSpec._offsets.get(name);
        if (offset !== undefined) {
            writeTypedValue(customData, offset, slot.decl.type, slot.value);
        }
    }
    engine._device.queue.writeBuffer(customUbo, 0, bytes);
    state._shaderCustomVersion = material._uniformVersion;
}

function writeTypedValue(data: ArrayBuffer, offset: number, type: ShaderUniformType, value: Float32Array): void {
    if (type === "u32") {
        new Uint32Array(data, offset, 1)[0] = value[0]!;
        return;
    }
    if (type === "i32") {
        new Int32Array(data, offset, 1)[0] = value[0]!;
        return;
    }
    new Float32Array(data, offset, value.length).set(value);
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

function registerMeshTextureDisposer(scene: SceneContext, mesh: Mesh, packet: ShaderPacket): void {
    const list = scene._meshDisposables.get(mesh) ?? [];
    list.push(() => {
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
    });
    scene._meshDisposables.set(mesh, list);
}

function writeSystemUniforms(data: Float32Array, spec: UboSpec, material: ShaderMaterial, mesh: Mesh, camera: Camera | null, targetWidth: number, targetHeight: number): void {
    data.fill(0);
    const world = mesh.worldMatrix as unknown as Float32Array;
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
                    mat4MultiplyInto(data, f, view, 0, world, 0);
                }
                break;
            case "worldViewProjection":
                if (viewProjection) {
                    mat4MultiplyInto(data, f, viewProjection, 0, world, 0);
                }
                break;
            case "cameraPosition":
                if (camera) {
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
    const buffer = engine._device.createBuffer({ label: `shader-zero-${name}`, size: vertexCount * stride, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    cache.set(name, buffer);
    return buffer;
}

function getAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: ShaderAttributeName): GPUBuffer {
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
    }
}
