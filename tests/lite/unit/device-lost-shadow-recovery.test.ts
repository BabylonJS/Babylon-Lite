import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { rebuildRegisteredScenes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { createEsmDirectionalShadowGenerator, getEsmShadowTaskResources } from "../../../packages/babylon-lite/src/shadow/esm-directional-shadow-generator.js";
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
            _meshAuxDisposables: new Map(),
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
