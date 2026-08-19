import { afterEach, describe, expect, it } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import { clearStandardPipelineCache } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createThinInstanceFragment } from "../../../packages/babylon-lite/src/shader/fragments/thin-instance-fragment";

const gpuGlobals = globalThis as typeof globalThis & { GPUBufferUsage?: unknown; GPUShaderStage?: unknown; GPUTextureUsage?: unknown };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8, STORAGE: 0x80 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeMockEngine(): EngineContext {
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createSampler: (descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler,
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;
    const engine = {
        canvas: {},
        msaaSamples: 1,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        format: "bgra8unorm",
        _disposables: [],
    } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

type StandardMesh = Mesh & { material: StandardMaterialProps };

function makeMesh(withInstanceColors: boolean): StandardMesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material: createStandardMaterial(),
        receiveShadows: false,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        thinInstances: {
            count: 1,
            matrices: new Float32Array(16),
            ...(withInstanceColors ? { colors: new Float32Array([1, 1, 1, 0.5]) } : {}),
        },
        _gpu: {},
    } as unknown as StandardMesh;
}

afterEach(() => {
    clearStandardPipelineCache();
});

describe("Standard thin-instance alpha classification", () => {
    it("keeps instance colors opaque without opt-in and matrix-only instances opaque with opt-in", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const colorsWithoutOptIn = makeMesh(true);
        const matricesWithOptIn = makeMesh(false);
        matricesWithOptIn.hasVertexAlpha = true;

        const { renderables } = buildStandardMeshRenderables(scene, [colorsWithoutOptIn, matricesWithOptIn], {
            tiFragment: createThinInstanceFragment,
        });

        expect(renderables.map((renderable) => renderable.isTransparent)).toEqual([false, false]);
        expect(renderables.map((renderable) => renderable.order)).toEqual([100, 100]);
    });

    it("reuses the material-alpha pipeline when thin-instance alpha opt-in adds no vertex-color shader feature", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const mesh = makeMesh(true);
        mesh.material.alpha = 0.5;
        const signature = { _colorFormat: "bgra8unorm", _sampleCount: 1 } as RenderTargetSignature;

        const withoutOptIn = buildStandardMeshRenderables(scene, [mesh], { tiFragment: createThinInstanceFragment }).renderables[0]!.bind(engine, signature).pipeline;
        mesh.hasVertexAlpha = true;
        const withOptIn = buildStandardMeshRenderables(scene, [mesh], { tiFragment: createThinInstanceFragment }).renderables[0]!.bind(engine, signature).pipeline;

        expect(withOptIn).toBe(withoutOptIn);
    });
});
