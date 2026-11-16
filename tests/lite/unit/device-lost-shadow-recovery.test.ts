import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { rebuildRegisteredScenes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light.js";
import { acquireTexture } from "../../../packages/babylon-lite/src/resource/texture-acquire.js";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-release.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { createCsmDirectionalShadowGenerator, getCsmReceiverTexture, onCsmReceiverUpdate } from "../../../packages/babylon-lite/src/shadow/csm-directional-shadow-generator.js";
import { enableCsmStaticCache } from "../../../packages/babylon-lite/src/shadow/enable-csm-static-cache.js";
import { createEsmDirectionalShadowGenerator, getEsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator.js";
import { setShadowGeneratorEnabled } from "../../../packages/babylon-lite/src/shadow/shadow-enabled.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";

interface FakeResource {
    readonly id: number;
    readonly deviceId: number;
}

let nextResourceId = 1;

function makeDevice(deviceId: number): GPUDevice {
    const resource = (): FakeResource => ({ id: nextResourceId++, deviceId });
    return {
        createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
            const data = new ArrayBuffer(Number(descriptor.size));
            return {
                ...resource(),
                size: Number(descriptor.size),
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => data),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        },
        createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
            const size = descriptor.size as GPUExtent3DDict;
            const texture = {
                ...resource(),
                width: size.width,
                height: size.height,
                depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
                format: descriptor.format,
                usage: descriptor.usage,
                createView: vi.fn(() => resource() as unknown as GPUTextureView),
                destroy: vi.fn(),
            };
            return texture as unknown as GPUTexture;
        },
        createSampler: vi.fn(() => resource() as unknown as GPUSampler),
        createShaderModule: vi.fn(() => resource() as unknown as GPUShaderModule),
        createBindGroupLayout: vi.fn(() => resource() as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn(() => resource() as unknown as GPUPipelineLayout),
        createRenderPipeline: vi.fn(() => resource() as unknown as GPURenderPipeline),
        createBindGroup: vi.fn(() => resource() as unknown as GPUBindGroup),
        queue: {
            writeBuffer: vi.fn(),
        },
    } as unknown as GPUDevice;
}

function makeEngine(device: GPUDevice): EngineContext {
    return {
        _device: device,
        surfaces: [],
    } as unknown as EngineContext;
}

describe("device-lost shadow recovery", () => {
    it.each([false, true])("rebuilds CSM resources in place and preserves the borrowed receiver texture before rebuilding the scene (static cache: %s)", async (staticCache) => {
        const engine = makeEngine(makeDevice(1));
        const light = createDirectionalLight([0, -1, 0], 1);
        const generator = createCsmDirectionalShadowGenerator(engine, light, {
            mapSize: 256,
            numCascades: 3,
            lambda: 0.7,
            cascadeBlendPercentage: 0.2,
            stabilizeCascades: true,
            shadowMaxZ: 250,
            bias: 0.0002,
            worldSpaceBias: 0.08,
            darkness: 0.25,
            frustumEdgeFalloff: 0.15,
            forceRefreshEveryFrame: true,
        });
        light.shadowGenerator = generator;
        setShadowGeneratorEnabled(generator, false);
        if (staticCache) {
            await enableCsmStaticCache(engine, generator, { refitAngle: 0.05, refitMaxIntervalMs: 250, staticCascadesPerFrame: 1 });
        }
        const receiverUpdate = vi.fn();
        onCsmReceiverUpdate(generator, receiverUpdate);
        const oldCallbacks = generator._onReceiverData;
        const oldEnabledState = generator._runtimeEnabledState;
        const oldCache = generator._csmCache;
        const oldHooks = [generator._preloadShadowTask, generator._ensureShadowTaskState, generator._renderShadowMap, generator._replaceShadowTaskHooks];
        const oldCpuState = [generator._lightMatrix, generator._shadowsInfo, generator._depthValues];
        const disposeTask = vi.fn();
        generator._shadowTaskState = {
            _task: { record: vi.fn(), dispose: disposeTask },
            _casterMeshes: [],
        };
        generator._preloadPending = [];
        const receiverTexture = getCsmReceiverTexture(generator);
        const oldReceiverView = receiverTexture.view;
        const oldResources = [generator._depthTexture, generator._depthSampler, generator._shadowParamsUBO, generator._shadowUBO];
        const oldConfig = generator._config;
        const oldConfigValues = { ...oldConfig };
        const oldShadowsInfo = [...generator._shadowsInfo];
        const oldVersion = generator._version;
        const rebuildGroup = vi.fn(async () => {
            expect((generator._depthTexture as unknown as FakeResource).deviceId).toBe(2);
            expect(receiverTexture.texture).toBe(generator._depthTexture);
            acquireTexture(receiverTexture);
            return { rebuildSingle: vi.fn(), renderables: [] };
        });
        const frameGraphBuild = vi.fn();
        const scene = {
            _kind: "scene",
            lights: [light],
            shadowGenerators: [generator],
            meshes: [],
            _groups: new Map([[rebuildGroup, []]]),
            _renderables: [],
            _uniformUpdaters: [],
            _meshDisposables: new Map(),
            _renderableVersion: 0,
            _frameGraph: { _tasks: [], build: frameGraphBuild },
        } as unknown as SceneContext;
        const surface = { _renderingContexts: [scene] } as unknown as SurfaceContext;
        (engine as { surfaces: readonly SurfaceContext[] }).surfaces = [surface];

        engine._device = makeDevice(2);
        await rebuildRegisteredScenes(engine);

        expect(light.shadowGenerator).toBe(generator);
        expect(scene.shadowGenerators[0]).toBe(generator);
        const newResources = [generator._depthTexture, generator._depthSampler, generator._shadowParamsUBO, generator._shadowUBO];
        for (let i = 0; i < newResources.length; i++) {
            expect(newResources[i]).not.toBe(oldResources[i]);
            expect((newResources[i] as unknown as FakeResource).deviceId).toBe(2);
        }
        expect(generator._depthTexture.width).toBe(256);
        expect(generator._depthTexture.height).toBe(256);
        expect(generator._depthTexture.depthOrArrayLayers).toBe(3);
        expect(generator._depthTexture.format).toBe("depth32float");
        expect(generator._depthTexture.usage).toBe(GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | (staticCache ? GPUTextureUsage.COPY_DST : 0));
        expect(engine._device.createSampler).toHaveBeenCalledWith({ compare: "less", magFilter: "linear", minFilter: "linear" });
        expect(generator._shadowParamsUBO.size).toBe(32);
        expect(generator._shadowUBO.size).toBe(320);
        expect(generator._csmCascadeCount).toBe(3);
        expect(generator._config).toBe(oldConfig);
        expect(generator._config).toEqual(oldConfigValues);
        const newCpuState = [generator._lightMatrix, generator._shadowsInfo, generator._depthValues];
        for (let i = 0; i < newCpuState.length; i++) {
            expect(newCpuState[i]).toBe(oldCpuState[i]);
        }
        expect([generator._preloadShadowTask, generator._ensureShadowTaskState, generator._renderShadowMap, generator._replaceShadowTaskHooks]).toEqual(oldHooks);
        expect(generator._onReceiverData).toBe(oldCallbacks);
        expect(generator._onReceiverData).toEqual([receiverUpdate]);
        expect(generator._runtimeEnabledState).toBe(oldEnabledState);
        expect(generator._runtimeEnabledState!.enabled).toBe(false);
        expect(generator._csmCache).toBe(oldCache);
        expect([...generator._shadowsInfo]).toEqual(oldShadowsInfo);
        expect(generator._version).toBeGreaterThan(oldVersion);
        expect(getCsmReceiverTexture(generator)).toBe(receiverTexture);
        expect(receiverTexture.texture).toBe(generator._depthTexture);
        expect(receiverTexture.view).not.toBe(oldReceiverView);
        expect((receiverTexture.view as unknown as FakeResource).deviceId).toBe(2);
        expect(receiverTexture.sampler).toBe(generator._depthSampler);
        expect(receiverTexture.width).toBe(256);
        expect(receiverTexture.height).toBe(256);
        expect(receiverTexture._sampleType).toBe("depth");
        expect(generator._depthTexture.createView).toHaveBeenCalledWith({ dimension: "2d-array" });
        expect(generator._shadowTaskState).toBeUndefined();
        expect(generator._preloadPending).toBeUndefined();
        expect(disposeTask).toHaveBeenCalledOnce();
        expect(rebuildGroup).toHaveBeenCalledOnce();
        expect(frameGraphBuild).toHaveBeenCalledOnce();
        expect(releaseTexture(receiverTexture)).toBe(false);
        expect(generator._depthTexture.destroy).not.toHaveBeenCalled();
    });

    it("rebuilds ESM resources and nested task state in place before rebuilding the scene", async () => {
        const engine = makeEngine(makeDevice(1));
        const light = createDirectionalLight([0, -1, 0], 1);
        const generator = createEsmDirectionalShadowGenerator(engine, light, {
            mapSize: 256,
            depthScale: 37,
            blurKernel: 7,
            blurScale: 4,
            darkness: 0.25,
            frustumEdgeFalloff: 0.15,
            orthoMinZ: 0,
            orthoMaxZ: 500,
        });
        light.shadowGenerator = generator;
        const disposeTask = vi.fn();
        generator._shadowTaskState = {
            _task: {
                record: vi.fn(),
                dispose: disposeTask,
            },
            _casterMeshes: [],
        };
        const oldFallback = { texture: { deviceId: 1 } as unknown as GPUTexture } as Texture2D;
        engine._pbrFallbackTex = oldFallback;
        const rebuildGroup = vi.fn(async () => {
            expect(engine._pbrFallbackTex).toBeUndefined();
            engine._pbrFallbackTex = {
                texture: { deviceId: 2 } as unknown as GPUTexture,
            } as Texture2D;
            return { rebuildSingle: vi.fn(), renderables: [] };
        });

        const frameGraphBuild = vi.fn();
        const scene = {
            _kind: "scene",
            lights: [light],
            shadowGenerators: [],
            meshes: [],
            _groups: new Map([[rebuildGroup, []]]),
            _renderables: [],
            _uniformUpdaters: [],
            _meshDisposables: new Map(),
            _renderableVersion: 0,
            _frameGraph: {
                _tasks: [],
                build: frameGraphBuild,
            },
        } as unknown as SceneContext;
        const surface = { _renderingContexts: [scene] } as unknown as SurfaceContext;
        (engine as { surfaces: readonly SurfaceContext[] }).surfaces = [surface];

        const oldDepthTexture = generator._depthTexture;
        const oldDepthSampler = generator._depthSampler;
        const oldShadowParamsUbo = generator._shadowParamsUBO;
        const oldShadowUbo = generator._shadowUBO;
        const oldResources = getEsmShadowTaskResources(generator)!;
        const oldShadowsInfo = [...generator._shadowsInfo];
        expect(oldResources._blurKernel).toBe(7);
        const identity = generator;

        engine._device = makeDevice(2);
        await rebuildRegisteredScenes(engine);

        expect(generator).toBe(identity);
        expect(generator._depthTexture).not.toBe(oldDepthTexture);
        expect(generator._depthSampler).not.toBe(oldDepthSampler);
        expect(generator._shadowParamsUBO).not.toBe(oldShadowParamsUbo);
        expect(generator._shadowUBO).not.toBe(oldShadowUbo);
        const newResources = getEsmShadowTaskResources(generator)!;
        expect(newResources._esmTexture).not.toBe(oldResources._esmTexture);
        expect(newResources._depthBuffer).not.toBe(oldResources._depthBuffer);
        expect(newResources._blurTexH).not.toBe(oldResources._blurTexH);
        expect(newResources._blurPipeline).not.toBe(oldResources._blurPipeline);
        expect(newResources._blurHBG).not.toBe(oldResources._blurHBG);
        expect(newResources._blurVBG).not.toBe(oldResources._blurVBG);
        expect(newResources._blurKernel).toBe(7);
        expect(newResources._blurScale).toBe(oldResources._blurScale);
        expect(newResources._blurTexH.width).toBe(64);
        expect([...generator._shadowsInfo]).toEqual(oldShadowsInfo);
        for (const resource of [
            newResources._esmTexture,
            newResources._depthBuffer,
            newResources._blurTexH,
            newResources._blurPipeline,
            newResources._blurHBG,
            newResources._blurVBG,
        ]) {
            expect((resource as unknown as FakeResource).deviceId).toBe(2);
        }
        expect((generator._depthTexture as unknown as FakeResource).deviceId).toBe(2);
        expect(rebuildGroup).toHaveBeenCalledOnce();
        expect(engine._pbrFallbackTex).not.toBe(oldFallback);
        expect((engine._pbrFallbackTex!.texture as unknown as FakeResource).deviceId).toBe(2);
        expect(generator._shadowTaskState).toBeUndefined();
        expect(disposeTask).toHaveBeenCalledOnce();
        expect(frameGraphBuild).toHaveBeenCalledOnce();
    });
});
