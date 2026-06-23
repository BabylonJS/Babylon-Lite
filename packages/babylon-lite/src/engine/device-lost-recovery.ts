import { U8 } from "./typed-arrays.js";
import { TU, BU } from "./gpu-flags.js";
import type { EngineContext } from "./engine.js";
import { startEngine, stopEngine, resizeEngine } from "./engine.js";
import { _refreshScRT } from "./surface.js";
import type { SceneContext } from "../scene/scene-core.js";
import { isRenderingContextRegistered } from "./engine.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
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
    deltasBuffer: GPUBuffer;
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

let _states: WeakMap<EngineContext, RecoveryState> | null = null;

function states(): WeakMap<EngineContext, RecoveryState> {
    if (!_states) {
        _states = new WeakMap();
    }
    return _states;
}

function getState(engine: EngineContext): RecoveryState {
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
    const state = getState(engine);
    state.enabled = true;
    state.options = options;
    state.requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];
    attachRecoveryCapture(engine);

    arm(engine, state);
    return {
        disable(): void {
            state.enabled = false;
            detachRecoveryCapture(engine);
        },
    };
}

function attachRecoveryCapture(engine: EngineContext): void {
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

function detachRecoveryCapture(engine: EngineContext): void {
    engine._dlr = undefined;
}

export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = _states?.get(engine as EngineContext);
    if (!state?.enabled) {
        return false;
    }
    state.forceNextLoss = true;
    return true;
}

function arm(engine: EngineContext, state: RecoveryState): void {
    const device = engine._device;
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

async function recoverDevice(engine: EngineContext, state: RecoveryState): Promise<void> {
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
        engine._device = await adapter.requestDevice({ requiredFeatures: state.requiredFeatures });
        // Reconfigure every surface's canvas context against the new device and re-acquire
        // its swapchain texture (the previous device's textures are invalid). The rebuilt
        // frame graphs need fresh color attachments. Per-surface `_swapchainCopySrc` is
        // honoured so surfaces that had been promoted to COPY_SRC for screenshot readback
        // keep that capability across recovery; surfaces that never captured stay
        // RENDER_ATTACHMENT-only.
        for (const surface of engine.surfaces) {
            const usage = surface._swapchainCopySrc ? TU.RENDER_ATTACHMENT | TU.COPY_SRC : TU.RENDER_ATTACHMENT;
            surface._context.configure({ device: engine._device, format: surface.format, alphaMode: surface._alphaMode, usage });
            _refreshScRT(surface);
        }
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

async function rebuildRegisteredScenes(engine: EngineContext): Promise<void> {
    for (const surface of engine.surfaces) {
        for (const ctx of surface._renderingContexts) {
            const scene = ctx as SceneContext;
            if (!isRenderingContextRegistered(surface, scene)) {
                continue;
            }
            await rebuildSceneGpu(engine, scene);
        }
    }
}

async function rebuildSceneGpu(engine: EngineContext, scene: SceneContext): Promise<void> {
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

function resetFrameGraphTasks(engine: EngineContext, scene: SceneContext): void {
    for (const task of scene._frameGraph._tasks) {
        if (!("_sceneUBO" in task && "_sceneBG" in task && "_opaqueBindings" in task)) {
            continue;
        }
        const rt = task as unknown as RecoverableRenderTask;
        rt._sceneUBO = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
        rt._lightsUBO = ensureSceneLightState(engine, scene)._buffer;
        rt._sceneBG = engine._device.createBindGroup({
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

async function rebuildMeshes(engine: EngineContext, scene: SceneContext): Promise<void> {
    let skeletonFactory: typeof createSkeleton | null = null;
    let morphFactory: typeof createMorphTargets | null = null;

    for (const mesh of scene.meshes) {
        if (mesh._cpuPositions && mesh._cpuNormals && mesh._cpuIndices) {
            mesh._gpu = uploadRetainedMesh(engine, mesh);
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
                mesh._cpuPositions ? mesh._cpuPositions.length / 3 : 0,
                Array.from(old.weights)
            );
            Object.assign(old as MutableMorphTargets, rebuilt);
        }
    }
}

function uploadRetainedMesh(engine: EngineContext, mesh: Mesh): MeshGPU {
    const positions = mesh._cpuPositions!;
    const normals = mesh._cpuNormals!;
    const uvs = mesh._cpuUvs;
    const indices = mesh._cpuGpuIndices ?? mesh._cpuIndices!;
    const device = engine._device;
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createMappedBuffer(engine, uvs, BU.VERTEX);
    } else {
        uvBuffer = device.createBuffer({ size: (positions.length / 3) * 8, usage: BU.VERTEX, mappedAtCreation: true });
        uvBuffer.unmap();
    }
    return {
        positionBuffer: createMappedBuffer(engine, positions, BU.VERTEX),
        normalBuffer: createMappedBuffer(engine, normals, BU.VERTEX),
        tangentBuffer: mesh._cpuTangents ? createMappedBuffer(engine, mesh._cpuTangents, BU.VERTEX) : null,
        uvBuffer,
        uv2Buffer: mesh._cpuUv2s ? createMappedBuffer(engine, mesh._cpuUv2s, BU.VERTEX) : null,
        colorBuffer: mesh._cpuColors ? createMappedBuffer(engine, mesh._cpuColors, BU.VERTEX) : null,
        hasUv: !!uvs && uvs.length > 0,
        hasUv2: !!mesh._cpuUv2s && mesh._cpuUv2s.length > 0,
        hasTangent: !!mesh._cpuTangents && mesh._cpuTangents.length > 0,
        hasColor: !!mesh._cpuColors && mesh._cpuColors.length > 0,
        indexBuffer: createMappedBuffer(engine, indices, BU.INDEX),
        indexCount: mesh._gpu.indexCount,
        indexFormat: mesh._cpuIndexFormat ?? mesh._gpu.indexFormat,
    };
}

async function rebuildTexture2D(engine: EngineContext, tex: Texture2D): Promise<void> {
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
        const texture = engine._device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: TU.TEXTURE_BINDING | TU.COPY_DST });
        const data = new U8(source.rgba.map((v) => Math.round(v * 255)));
        engine._device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });
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
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.COPY_SRC | TU.RENDER_ATTACHMENT,
    });
    if (source.bitmap) {
        engine._device.queue.copyExternalImageToTexture({ source: source.bitmap }, { texture, premultipliedAlpha: false }, { width, height });
        if (source.mipMaps && mipLevelCount > 1) {
            const { generateMipmaps } = await import("../texture/generate-mipmaps.js");
            generateMipmaps(engine, texture);
        }
    } else {
        engine._device.queue.writeTexture({ texture }, (source.fallback ?? new U8([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }
    tex.texture = texture;
    tex.view = texture.createView();
    tex.sampler = getOrCreateSampler(engine, source.samplerDesc);
    tex.width = width;
    tex.height = height;
}

async function rebuildUrlTexture2D(engine: EngineContext, url: string, opts: Texture2DOptions): Promise<Texture2D> {
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
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });
    engine._device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });
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

async function rebuildSceneTextures(engine: EngineContext, scene: SceneContext): Promise<void> {
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
