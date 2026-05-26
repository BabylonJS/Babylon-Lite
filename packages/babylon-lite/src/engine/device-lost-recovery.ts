import type { EngineContext, EngineContextInternal } from "./engine.js";
import { startEngine, stopEngine, resizeEngine } from "./engine.js";
import type { SceneContextInternal } from "../scene/scene-core.js";
import { isRenderingContextRegistered } from "./engine.js";
import type { MeshInternal, MeshGPU } from "../mesh/mesh.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import { clearSceneBGLCache, getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState } from "../render/lights-ubo.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { getBilinearSampler } from "../resource/samplers.js";
import type { createSkeleton } from "../skeleton/create-skeleton.js";
import type { createMorphTargets } from "../morph/create-morph-targets.js";

export interface DeviceLostRecoveryOptions {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onRecovered?: () => void;
    onRecoveryFailed?: (error: unknown) => void;
}

export interface DeviceLostRecoveryHandle {
    disable(): void;
}

interface MutableSkeleton {
    boneTexture: GPUTexture;
    jointsBuffer: GPUBuffer;
    weightsBuffer: GPUBuffer;
    joints1Buffer: GPUBuffer | null;
    weights1Buffer: GPUBuffer | null;
}

interface MutableMorphTargets {
    texture: GPUTexture;
    weightsBuffer: GPUBuffer;
}

interface RecoverableRenderTask {
    _sceneUBO: GPUBuffer;
    _sceneBG: GPUBindGroup;
    _lightsUBO: GPUBuffer;
    _opaqueBindings: unknown[];
    _directBindings: unknown[];
    _transparentBindings: unknown[];
    _opaqueBundles: unknown[];
    _lastVersion: number;
    _su: unknown[];
}

interface RecoveryState {
    enabled: boolean;
    recovering: boolean;
    forceNextLoss: boolean;
    requiredFeatures: GPUFeatureName[];
    armedDevice: GPUDevice | null;
    options: DeviceLostRecoveryOptions;
}

let _states: WeakMap<EngineContextInternal, RecoveryState> | null = null;

function states(): WeakMap<EngineContextInternal, RecoveryState> {
    if (!_states) {
        _states = new WeakMap();
    }
    return _states;
}

function getState(engine: EngineContextInternal): RecoveryState {
    let state = states().get(engine);
    if (!state) {
        state = {
            enabled: false,
            recovering: false,
            forceNextLoss: false,
            requiredFeatures: [],
            armedDevice: null,
            options: {},
        };
        states().set(engine, state);
    }
    return state;
}

export function enableDeviceLostRecovery(engine: EngineContext, options: DeviceLostRecoveryOptions = {}): DeviceLostRecoveryHandle {
    const eng = engine as EngineContextInternal;
    const state = getState(eng);
    state.enabled = true;
    state.options = options;
    state.requiredFeatures = Array.from(eng.device.features) as GPUFeatureName[];
    attachRecoveryCapture(eng);

    arm(eng, state);
    return {
        disable(): void {
            state.enabled = false;
            detachRecoveryCapture(eng);
        },
    };
}

function attachRecoveryCapture(engine: EngineContextInternal): void {
    engine._dlr = {
        u(tex, url, opts) {
            tex._recoverySource = { kind: "url", url, opts: { ...opts } };
        },
        s(tex, r, g, b, a) {
            tex._recoverySource = { kind: "solid", rgba: [r, g, b, a] };
        },
        b(tex, bitmap, srgb, mipMaps, fallback) {
            tex._recoverySource = {
                kind: "bitmap",
                bitmap,
                srgb,
                mipMaps,
                fallback,
                samplerDesc: { magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 4 },
            };
        },
        m(mesh, uv2s, tangents, colors, gpuIndices, indexFormat) {
            mesh._cpuUv2s = uv2s;
            mesh._cpuTangents = tangents;
            mesh._cpuColors = colors;
            mesh._cpuGpuIndices = gpuIndices;
            mesh._cpuIndexFormat = indexFormat;
        },
    };
}

function detachRecoveryCapture(engine: EngineContextInternal): void {
    engine._dlr = undefined;
}

export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = _states?.get(engine as EngineContextInternal);
    if (!state?.enabled) {
        return false;
    }
    state.forceNextLoss = true;
    return true;
}

function arm(engine: EngineContextInternal, state: RecoveryState): void {
    const device = engine.device;
    if (state.armedDevice === device) {
        return;
    }
    state.armedDevice = device;
    void device.lost.then(async (info) => {
        if (!state.enabled || state.armedDevice !== device) {
            return;
        }
        const forced = state.forceNextLoss;
        state.forceNextLoss = false;
        if (info.reason === "destroyed" && !forced) {
            return;
        }
        state.options.onLost?.(info);
        try {
            await recoverDevice(engine, state);
            if (state.enabled) {
                arm(engine, state);
            }
            state.options.onRecovered?.();
        } catch (error) {
            state.options.onRecoveryFailed?.(error);
        }
    });
}

async function recoverDevice(engine: EngineContextInternal, state: RecoveryState): Promise<void> {
    if (state.recovering) {
        return;
    }
    state.recovering = true;
    const wasRunning = engine._renderFn !== null;
    stopEngine(engine);

    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) {
            throw new Error("WebGPU adapter not available during device recovery");
        }
        const missingFeatures = state.requiredFeatures.filter((f) => !adapter.features.has(f));
        if (missingFeatures.length > 0) {
            throw new Error(`WebGPU device recovery missing required features: ${missingFeatures.join(", ")}`);
        }
        engine.device = await adapter.requestDevice({ requiredFeatures: state.requiredFeatures });
        engine.context.configure({ device: engine.device, format: engine.format, alphaMode: engine.alphaMode });
        clearSceneBGLCache();
        resizeEngine(engine);

        await rebuildRegisteredScenes(engine);
    } finally {
        state.recovering = false;
    }

    if (wasRunning) {
        await startEngine(engine);
    }
}

async function rebuildRegisteredScenes(engine: EngineContextInternal): Promise<void> {
    for (const ctx of engine._renderingContexts) {
        const scene = ctx as SceneContextInternal;
        if (!isRenderingContextRegistered(engine, scene)) {
            continue;
        }
        await rebuildSceneGpu(engine, scene);
    }
}

async function rebuildSceneGpu(engine: EngineContextInternal, scene: SceneContextInternal): Promise<void> {
    await rebuildSceneTextures(engine, scene);
    await rebuildMeshes(engine, scene);

    scene._renderables.length = 0;
    scene._uniformUpdaters.length = 0;
    scene._meshDisposables.clear();
    if (scene._lightGpuState) {
        scene._lightGpuState = undefined;
    }

    for (const [build, meshes] of scene._groups) {
        const result = await build(scene, meshes);
        scene._renderables.push(...result.renderables);
        if (result.updater) {
            scene._uniformUpdaters.push(result.updater);
        }
    }
    scene._renderables.sort((a, b) => a.order - b.order);
    scene._renderableVersion++;
    resetFrameGraphTasks(engine, scene);
    scene._frameGraph.build();
}

function resetFrameGraphTasks(engine: EngineContextInternal, scene: SceneContextInternal): void {
    for (const task of scene._frameGraph._tasks) {
        if (!("_sceneUBO" in task && "_sceneBG" in task && "_opaqueBindings" in task)) {
            continue;
        }
        const rt = task as unknown as RecoverableRenderTask;
        rt._sceneUBO = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
        rt._lightsUBO = ensureSceneLightState(engine, scene)._buffer;
        rt._sceneBG = engine.device.createBindGroup({
            layout: getSceneBindGroupLayout(engine),
            entries: [
                { binding: 0, resource: { buffer: rt._sceneUBO } },
                { binding: 1, resource: { buffer: rt._lightsUBO } },
            ],
        });
        rt._opaqueBindings.length = 0;
        rt._directBindings.length = 0;
        rt._transparentBindings.length = 0;
        rt._opaqueBundles.length = 0;
        rt._lastVersion = -1;
        rt._su.length = 0;
    }
}

async function rebuildMeshes(engine: EngineContextInternal, scene: SceneContextInternal): Promise<void> {
    let skeletonFactory: typeof createSkeleton | null = null;
    let morphFactory: typeof createMorphTargets | null = null;

    for (const mesh of scene.meshes) {
        const mi = mesh as MeshInternal;
        if (mi._cpuPositions && mi._cpuNormals && mi._cpuIndices) {
            mi._gpu = uploadRetainedMesh(engine, mi);
        }
        if (mesh.skeleton) {
            skeletonFactory ??= (await import("../skeleton/create-skeleton.js")).createSkeleton;
            const old = mesh.skeleton;
            const rebuilt = skeletonFactory(engine, old.joints, old.weights, old.boneCount, old.boneMatrices, old.joints1, old.weights1);
            Object.assign(old as MutableSkeleton, rebuilt);
        }
        if (mesh.morphTargets) {
            morphFactory ??= (await import("../morph/create-morph-targets.js")).createMorphTargets;
            const old = mesh.morphTargets;
            const rebuilt = morphFactory(
                engine,
                old.targets.map((t) => ({ positions: t.positions, normals: t.normals })),
                mi._cpuPositions ? mi._cpuPositions.length / 3 : 0,
                Array.from(old.weights)
            );
            Object.assign(old as MutableMorphTargets, rebuilt);
        }
    }
}

function uploadRetainedMesh(engine: EngineContextInternal, mesh: MeshInternal): MeshGPU {
    const positions = mesh._cpuPositions!;
    const normals = mesh._cpuNormals!;
    const uvs = mesh._cpuUvs;
    const indices = mesh._cpuGpuIndices ?? mesh._cpuIndices!;
    const device = engine.device;
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createMappedBuffer(engine, uvs, GPUBufferUsage.VERTEX);
    } else {
        uvBuffer = device.createBuffer({ size: (positions.length / 3) * 8, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
        uvBuffer.unmap();
    }
    return {
        positionBuffer: createMappedBuffer(engine, positions, GPUBufferUsage.VERTEX),
        normalBuffer: createMappedBuffer(engine, normals, GPUBufferUsage.VERTEX),
        tangentBuffer: mesh._cpuTangents ? createMappedBuffer(engine, mesh._cpuTangents, GPUBufferUsage.VERTEX) : null,
        uvBuffer,
        uv2Buffer: mesh._cpuUv2s ? createMappedBuffer(engine, mesh._cpuUv2s, GPUBufferUsage.VERTEX) : null,
        colorBuffer: mesh._cpuColors ? createMappedBuffer(engine, mesh._cpuColors, GPUBufferUsage.VERTEX) : null,
        hasUv: !!uvs && uvs.length > 0,
        hasUv2: !!mesh._cpuUv2s && mesh._cpuUv2s.length > 0,
        hasTangent: !!mesh._cpuTangents && mesh._cpuTangents.length > 0,
        hasColor: !!mesh._cpuColors && mesh._cpuColors.length > 0,
        indexBuffer: createMappedBuffer(engine, indices, GPUBufferUsage.INDEX),
        indexCount: mesh._gpu.indexCount,
        indexFormat: mesh._cpuIndexFormat ?? mesh._gpu.indexFormat,
    };
}

async function rebuildTexture2D(engine: EngineContextInternal, tex: Texture2D): Promise<void> {
    const source = tex._recoverySource;
    if (!source) {
        return;
    }
    if (source.kind === "url") {
        const rebuilt = await rebuildUrlTexture2D(engine, source.url, source.opts);
        tex.texture = rebuilt.texture;
        tex.view = rebuilt.view;
        tex.sampler = rebuilt.sampler;
        tex.width = rebuilt.width;
        tex.height = rebuilt.height;
        tex._recoverySource = source;
        return;
    }
    if (source.kind === "solid") {
        const texture = engine.device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const data = new Uint8Array(source.rgba.map((v) => Math.round(v * 255)));
        engine.device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });
        tex.texture = texture;
        tex.view = texture.createView();
        tex.sampler = getBilinearSampler(engine);
        tex.width = 1;
        tex.height = 1;
        return;
    }
    const width = source.bitmap?.width ?? 1;
    const height = source.bitmap?.height ?? 1;
    const format: GPUTextureFormat = source.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mipLevelCount = source.mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine.device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    if (source.bitmap) {
        engine.device.queue.copyExternalImageToTexture({ source: source.bitmap }, { texture, premultipliedAlpha: false }, { width, height });
        if (source.mipMaps && mipLevelCount > 1) {
            const { generateMipmaps } = await import("../texture/generate-mipmaps.js");
            generateMipmaps(engine, texture);
        }
    } else {
        engine.device.queue.writeTexture(
            { texture },
            (source.fallback ?? new Uint8Array([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>,
            { bytesPerRow: 4 },
            { width: 1, height: 1 }
        );
    }
    tex.texture = texture;
    tex.view = texture.createView();
    tex.sampler = getOrCreateSampler(engine, source.samplerDesc);
    tex.width = width;
    tex.height = height;
}

async function rebuildUrlTexture2D(engine: EngineContextInternal, url: string, opts: Texture2DOptions): Promise<Texture2D> {
    const mipMaps = opts.mipMaps ?? true;
    const addressModeU = opts.addressModeU ?? "repeat";
    const addressModeV = opts.addressModeV ?? "repeat";
    const invertY = opts.invertY ?? true;
    const srgb = opts.srgb ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";

    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob, {
        premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
        colorSpaceConversion: "none",
    });

    const width = imageBitmap.width;
    const height = imageBitmap.height;
    const mipLevelCount = mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine.device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    engine.device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });
    imageBitmap.close();

    if (mipMaps && mipLevelCount > 1) {
        const { generateMipmaps } = await import("../texture/generate-mipmaps.js");
        generateMipmaps(engine, texture);
    }

    const minF = opts.minFilter ?? "linear";
    const magF = opts.magFilter ?? "linear";
    const mipF: GPUMipmapFilterMode = mipMaps ? "linear" : "nearest";
    const allLinear = minF === "linear" && magF === "linear" && mipF === "linear";
    const sampler = getOrCreateSampler(engine, {
        addressModeU,
        addressModeV,
        minFilter: minF,
        magFilter: magF,
        mipmapFilter: mipF,
        maxAnisotropy: allLinear ? 4 : 1,
    });

    return { texture, view: texture.createView(), sampler, width, height };
}

async function rebuildSceneTextures(engine: EngineContextInternal, scene: SceneContextInternal): Promise<void> {
    const seen = new Set<Texture2D>();
    const visited = new WeakSet<object>();
    const promises: Promise<void>[] = [];
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") {
            return;
        }
        const obj = value as Record<string, unknown>;
        if (obj.texture && obj.view && obj.sampler && typeof obj.width === "number" && typeof obj.height === "number") {
            const tex = obj as unknown as Texture2D;
            if (!seen.has(tex)) {
                seen.add(tex);
                promises.push(rebuildTexture2D(engine, tex));
            }
            return;
        }
        if (visited.has(value)) {
            return;
        }
        visited.add(value);
        for (const child of Object.values(obj)) {
            visit(child);
        }
    };
    for (const mesh of scene.meshes) {
        visit(mesh.material);
    }
    await Promise.all(promises);
}
