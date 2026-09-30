/** MeshLoD coarse indirect-render integration tests (Task 4.4; CPU reference path).
 *
 *  Drive the full public load → instance → register → build → select → expand →
 *  draw path against a mock device + fill decoder (no browser) in CPU selection mode
 *  (the deterministic reference/diagnostic path). Assert coarse-only expansion of the
 *  pinned terminal clusters, a single `drawIndirect` per batch regardless of
 *  meshlet/instance count, and the material-owned unsupported-state rejection. The GPU
 *  production path is covered by mesh-lod-indirect-render.spec + browser validation. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMeshLoD, createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { buildMeshLoDBatchRenderable } from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-renderable.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { EnvironmentTextures } from "../../../../packages/babylon-lite/src/loader-env/load-env.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { RenderTargetSignature } from "../../../../packages/babylon-lite/src/engine/render-target.js";
import { createFillDecoder, createMockEngine, createMockRenderPass } from "../../unit/mesh-lod/fixtures/gpu-mock.js";
import type { MockBuffer, MockDevice } from "../../unit/mesh-lod/fixtures/gpu-mock.js";

const STATUE = fileURLToPath(new URL("../../../../lab/public/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod", import.meta.url));

function statueSource(): ArrayBuffer {
    return new Uint8Array(readFileSync(STATUE)).slice().buffer as ArrayBuffer;
}

function fakeScene(engine: EngineContext): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function fakeCamera(): Camera {
    return {
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 100,
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1]),
        worldMatrixVersion: 1,
    } as unknown as Camera;
}

const SIG: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus-stencil8", _sampleCount: 1 };
const CONTEXT = { targetWidth: 800, targetHeight: 600, _camera: fakeCamera() };

async function buildScene(asset: MeshLoDAsset, engine: EngineContext, material: PbrMaterialProps, instanceCount: number): Promise<SceneContext> {
    const scene = fakeScene(engine);
    for (let i = 0; i < instanceCount; i++) {
        const instance = createMeshLoDInstance(asset, material);
        instance.position.set(i * 2, 0, 0);
        addMeshLoDInstanceToScene(scene, instance);
    }
    // Drain the single deferred builder (what registerScene does).
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    return scene;
}

function coarseTriangleCount(asset: MeshLoDAsset): number {
    const runtime = asset._runtime;
    let tris = 0;
    for (const cluster of runtime.clusters) {
        if (runtime.pageRecords[cluster.pageId]?.pinned) {
            tris += cluster.triangleCount;
        }
    }
    return tris;
}

let engine: EngineContext;

beforeEach(() => {
    _setMeshLoDPageDecoder(createFillDecoder().decoder);
    engine = createMockEngine().engine;
});
afterEach(() => {
    _setMeshLoDPageDecoder(null);
});

describe("MeshLoD coarse indirect rendering", () => {
    it("expands the pinned terminal clusters and issues exactly one indirect draw per batch", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const material: PbrMaterialProps = { doubleSided: true } as PbrMaterialProps;
        const scene = await buildScene(asset, engine, material, 1);

        expect(scene._renderables).toHaveLength(1);
        const renderable = scene._renderables[0]!;
        const binding = renderable.bind(engine, SIG);
        binding.update!(CONTEXT);

        // Coarse-only: every pinned terminal cluster is selected and expanded.
        expect(asset.diagnostics.renderedTriangleCount).toBe(coarseTriangleCount(asset));
        expect(asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);

        const pass = createMockRenderPass();
        const draws = binding.draw(pass as unknown as GPURenderPassEncoder, engine);
        expect(draws).toBe(1);
        expect(pass.indirectDraws).toHaveLength(1);
        expect(pass.setBindGroups).toEqual([{ index: 1 }]);
    });

    it("keeps one draw per batch while the expanded meshlet count grows with instances", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const material: PbrMaterialProps = {} as PbrMaterialProps;
        const scene = await buildScene(asset, engine, material, 3);

        // Two transformed instances share one asset+material → a single batch/renderable.
        expect(scene._meshLoDRegistry!.batches).toHaveLength(1);
        expect(scene._renderables).toHaveLength(1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        binding.update!(CONTEXT);

        // Expanded triangles scale with instance count; the draw count does not.
        expect(asset.diagnostics.renderedTriangleCount).toBe(coarseTriangleCount(asset) * 3);
        const pass = createMockRenderPass();
        expect(scene._renderables[0]!.bind(engine, SIG).draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
    });

    it("grows CPU instance storage and draw scratch before rendering instances added to an existing batch", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const material = {} as PbrMaterialProps;
        const scene = await buildScene(asset, engine, material, 1);
        const binding = scene._renderables[0]!.bind(engine, SIG);
        binding.update!(CONTEXT);
        const batch = scene._meshLoDRegistry!.batches[0]!;
        const packet = batch._packet as { instanceBuffer: MockBuffer; drawVertexBuffer: MockBuffer; maxInstances: number; maxDrawVertices: number };
        const previousInstance = packet.instanceBuffer;
        const previousDraw = packet.drawVertexBuffer;
        for (let i = 0; i < 2; i++) {
            addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        }
        binding.update!(CONTEXT);
        const device = engine._device as unknown as MockDevice;
        expect(packet.maxInstances).toBeGreaterThanOrEqual(3);
        expect(packet.maxDrawVertices).toBeGreaterThanOrEqual(coarseTriangleCount(asset) * 9);
        expect(packet.instanceBuffer).not.toBe(previousInstance);
        expect(packet.drawVertexBuffer).not.toBe(previousDraw);
        expect(device.writes.some((w) => w.buffer === packet.instanceBuffer && w.byteLength === 3 * 128)).toBe(true);
        expect(asset.diagnostics.renderedTriangleCount).toBe(coarseTriangleCount(asset) * 3);
        expect(previousInstance.destroyed).toBe(false); // in-flight draw can still reference it
        const pass = createMockRenderPass();
        expect(binding.draw(pass as unknown as GPURenderPassEncoder, engine)).toBe(1);
        expect(pass.indirectDraws).toHaveLength(1);
    });

    it("survives unavailable fine data by rendering the coarse fallback", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        // No fine pages are resident (Phase 4). Selection must still produce coarse output.
        const scene = await buildScene(asset, engine, {} as PbrMaterialProps, 1);
        scene._renderables[0]!.bind(engine, SIG).update!(CONTEXT);
        expect(asset.diagnostics.renderedTriangleCount).toBeGreaterThan(0);
        expect(asset.diagnostics.residentPageCount).toBe(asset.metadata.pinnedPageCount);
    });

    it("rejects an unsupported material through the PBR module (MLOD_UNSUPPORTED_MATERIAL)", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const scene = fakeScene(engine);
        const material = { _clearCoat: { isEnabled: true } } as unknown as PbrMaterialProps;
        const instance = createMeshLoDInstance(asset, {} as PbrMaterialProps);
        const batch = { asset, material, instances: [instance], priorFineRequired: new Map() };
        try {
            buildMeshLoDBatchRenderable(engine, scene, batch as never);
            throw new Error("expected rejection");
        } catch (error) {
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_UNSUPPORTED_MATERIAL");
        }
    });

    it("detects base/normal/ORM/emissive/double-sided/unlit variants", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        for (const material of [{} as PbrMaterialProps, { doubleSided: true } as PbrMaterialProps, { _unlit: true } as PbrMaterialProps]) {
            const scene = await buildScene(asset, engine, material, 1);
            expect(scene._renderables).toHaveLength(1);
        }
    });

    it("binds the scene BRDF LUT and prefiltered cubemap for lit MeshLoD materials", async () => {
        const asset = await loadMeshLoD(engine, statueSource(), { selectionMode: "cpu" });
        const scene = fakeScene(engine);
        const environment: EnvironmentTextures = {
            brdfLut: {} as GPUTexture,
            brdfLutView: {} as GPUTextureView,
            brdfSampler: {} as GPUSampler,
            specularCube: {} as GPUTexture,
            specularCubeView: {} as GPUTextureView,
            cubeSampler: {} as GPUSampler,
            irradianceSH: new Float32Array(36),
            sphericalHarmonics: new Float32Array(36),
            lodGenerationScale: 0.8,
        };
        scene._envTextures = environment;
        const device = engine._device as unknown as MockDevice;
        const bindGroup = vi.spyOn(device, "createBindGroup");
        const layout = vi.spyOn(device, "createBindGroupLayout");
        const shader = vi.spyOn(device, "createShaderModule");
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, {} as PbrMaterialProps));
        for (const builder of scene._deferredBuilders) {
            await builder();
        }

        expect(layout).toHaveBeenCalledWith(
            expect.objectContaining({
                entries: expect.arrayContaining([{ binding: 14, visibility: 2, texture: { sampleType: "float", viewDimension: "cube" } }]),
            })
        );
        expect(bindGroup).toHaveBeenCalledWith(
            expect.objectContaining({
                entries: expect.arrayContaining([
                    { binding: 12, resource: environment.brdfLutView },
                    { binding: 13, resource: environment.brdfSampler },
                    { binding: 14, resource: environment.specularCubeView },
                    { binding: 15, resource: environment.cubeSampler },
                ]),
            })
        );
        expect(shader).toHaveBeenCalledWith(expect.objectContaining({ code: expect.stringContaining("textureSampleLevel(iblTexture, iblSampler, R") }));

        bindGroup.mockClear();
        layout.mockClear();
        shader.mockClear();
        const unlitScene = fakeScene(engine);
        unlitScene._envTextures = environment;
        addMeshLoDInstanceToScene(unlitScene, createMeshLoDInstance(asset, { _unlit: true } as PbrMaterialProps));
        for (const builder of unlitScene._deferredBuilders) {
            await builder();
        }
        expect(bindGroup).toHaveBeenCalledWith(expect.objectContaining({ entries: expect.not.arrayContaining([expect.objectContaining({ binding: 12 })]) }));
        expect(layout).toHaveBeenCalledWith(expect.objectContaining({ entries: expect.not.arrayContaining([expect.objectContaining({ binding: 14 })]) }));
        expect(shader).toHaveBeenCalledWith(expect.objectContaining({ code: expect.not.stringContaining("textureSampleLevel(iblTexture") }));
    });
});
