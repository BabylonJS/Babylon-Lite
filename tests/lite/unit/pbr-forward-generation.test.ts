import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { isPbrForwardBuildCurrent } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";

/**
 * The PBR geometry renderer derives its renderables from the forward PBR context, so it may only bind a mesh
 * while the forward renderable the scene tracks for it was built for the mesh's CURRENT generation. Forward
 * rebuilds are asynchronous and make-before-break: while one is pending, the tracked renderable is the old
 * one. These tests run the REAL forward PBR group build (mocked device) and check the generation stamp it
 * leaves on its renderables against `isPbrForwardBuildCurrent`, the predicate the geometry task uses.
 */
function makeEngine(): EngineContext {
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({}) as GPUTextureView), destroy: vi.fn() }) as unknown as GPUTexture),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return { getMappedRange: vi.fn(() => storage), unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return { material, receiveShadows: false, morphTargets: null, worldMatrix, worldMatrixVersion: 1, _gpu: {} } as unknown as Mesh;
}

async function forwardBuild(material: ReturnType<typeof createPbrMaterial>, mesh: Mesh) {
    clearPbrPipelineCache();
    clearSceneBGLCache();
    const scene = createSceneContext(makeEngine(), { defaultRenderTask: false });
    scene._groups.set(material._buildGroup, [mesh]);
    return (await buildPbrRenderables(scene, [mesh], undefined)).renderables[0]!;
}

describe("PBR forward build generation", () => {
    it("stamps every forward renderable with the generation it was built for", async () => {
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const forward = await forwardBuild(material, mesh);

        expect(forward.mesh).toBe(mesh);
        expect(forward._gen?.[0]).toBe(material._renderFeatures);
        expect(isPbrForwardBuildCurrent(forward, mesh)).toBe(true);
        // A mesh that has not been forward-built yet has nothing to be current with.
        expect(isPbrForwardBuildCurrent(undefined, mesh)).toBe(false);
    });

    it("treats retained output as stale once the mesh gains a capability the build did not cover", async () => {
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(material, mesh);

        // First thin instances on an already-built mesh: the forward rebuild is pending and the scene still
        // tracks `retained`, whose context has no thin-instance helpers.
        (mesh as unknown as { thinInstances: unknown }).thinInstances = { count: 4, matrices: new Float32Array(64) };
        expect(isPbrForwardBuildCurrent(retained, mesh)).toBe(false);

        (mesh as unknown as { thinInstances: unknown }).thinInstances = null;
        expect(isPbrForwardBuildCurrent(retained, mesh)).toBe(true);
    });

    it("treats retained output as stale while a material rebuild is pending, and current again after it", async () => {
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(material, mesh);

        // `rebuildMaterial()` drops the render-feature object when the rebuild is requested...
        material._renderFeatures = undefined;
        expect(isPbrForwardBuildCurrent(retained, mesh)).toBe(false);

        // ...and the forward rebuild that completes later stamps its new renderable with the new one.
        const rebuilt = await forwardBuild(material, mesh);
        expect(material._renderFeatures).toBeDefined();
        expect(isPbrForwardBuildCurrent(rebuilt, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(retained, mesh)).toBe(false);
    });
});
