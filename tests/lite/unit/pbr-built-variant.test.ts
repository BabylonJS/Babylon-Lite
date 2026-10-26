import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { enableMaterialUvTransform } from "../../../packages/babylon-lite/src/material/enable-material-uv-transform";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { RuntimeSceneBuildHooks, SceneContext, SceneMeshGroup } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { _pbrRebuildsComposed } from "../../../packages/babylon-lite/src/material/pbr/pbr-built-variant";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

/**
 * `rebuildMaterial` rebuilds a PBR material's meshes on their own only when their group's closure already composed the
 * variant each will need; any other PBR material rebuild rebuilds the whole group, which loads whatever the new variant
 * needs. These tests run the REAL forward PBR group build (mocked device), so the variants are the ones its closure
 * actually composed.
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
            return { destroy: vi.fn(), getMappedRange: vi.fn(() => storage), unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

function makeScene(): SceneContext {
    clearPbrPipelineCache();
    clearSceneBGLCache();
    return createSceneContext(makeEngine(), { defaultRenderTask: false });
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return { material, receiveShadows: false, morphTargets: null, worldMatrix, worldMatrixVersion: 1, _gpu: {} } as unknown as Mesh;
}

/** A directional light that casts shadows, as far as the PBR group build is concerned. */
function makeShadowLight(): ReturnType<typeof createDirectionalLight> {
    const light = createDirectionalLight([0, -1, 0]);
    light.shadowGenerator = {
        _shadowType: "pcf",
        _depthTexture: { createView: vi.fn(() => ({}) as GPUTextureView) },
        _depthSampler: {} as GPUSampler,
        _shadowUBO: {} as GPUBuffer,
    } as unknown as ShadowGenerator;
    return light;
}

/** One complete forward PBR group build of `meshes`, committed the way the scene commits it. */
async function buildGroup(scene: SceneContext, meshes: Mesh[]): Promise<SceneMeshGroup> {
    const group = [...meshes] as SceneMeshGroup;
    scene._groups.set(meshes[0]!.material!._buildGroup, group);
    scene.meshes.push(...meshes);
    const result = await buildPbrRenderables(scene, meshes, undefined);
    group.r = result.rebuildSingle;
    scene._renderables.push(...result.renderables);
    return group;
}

/** Two meshes of one PBR group: `built` was built double-sided, `rebuilt`'s material was not. */
async function twoMaterials(scene = makeScene()) {
    const builtMaterial = createPbrMaterial();
    builtMaterial.doubleSided = true;
    const material = createPbrMaterial();
    const built = makeMesh(builtMaterial);
    const rebuilt = makeMesh(material);
    const group = await buildGroup(scene, [built, rebuilt]);
    return { scene, group, builtMaterial, material, built, rebuilt };
}

/** What `rebuildMaterial` does first: drop the features the material's output was built from. */
function requestRebuild(material: ReturnType<typeof createPbrMaterial>): void {
    material._renderFeatures = undefined;
}

describe("_pbrRebuildsComposed", () => {
    it("accepts a material whose rebuilt variant another mesh of the group was built with", async () => {
        const { scene, material, rebuilt } = await twoMaterials();

        material.doubleSided = true;
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(true);
    });

    it("accepts a rebuild that keeps the material's variant, though its own output is stale", async () => {
        const { scene, material, rebuilt } = await twoMaterials();

        // Same features as at the build: the composer still holds that variant, whose output no longer matters.
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(true);
    });

    it("composes nothing new when an accepted mesh is rebuilt through the group closure", async () => {
        const { scene, group, material, rebuilt } = await twoMaterials();
        material.doubleSided = true;
        requestRebuild(material);
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(true);
        const composer = (scene as unknown as { _pbrGeomContext: { _composePbr: { _c: ReadonlyMap<string, unknown> } } })._pbrGeomContext._composePbr;
        const variants = [...composer._c.values()];

        group.r!(scene, rebuilt);

        expect([...composer._c.values()]).toEqual(variants);
    });

    it("refuses a variant composed through the group closure after the build", async () => {
        const { scene, group, material, rebuilt } = await twoMaterials();
        // A runtime assignment of a variant the build never composed goes through the closure, which may lack something
        // that variant needs (here nothing is missing, but the closure cannot tell).
        material.enableSpecularAA = true;
        requestRebuild(material);
        group.r!(scene, rebuilt);
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
    });

    it("refuses a variant no mesh of the group was built with", async () => {
        const { scene, material, rebuilt } = await twoMaterials();

        material.enableSpecularAA = true;
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
    });

    it("refuses a UV2 use no mesh of the group was built with, also when another material changed its own in place", async () => {
        const { scene, builtMaterial, material, rebuilt } = await twoMaterials();

        // `setPbrLightmap` with coordIndex 1 sets the bit in place; neither variant was ever composed with it.
        builtMaterial._uv2Mask = 64;
        material.doubleSided = true;
        material._uv2Mask = 64;
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
    });

    it("refuses a mesh that started receiving shadows when the group only composed the single-light path", async () => {
        const scene = makeScene();
        scene.lights.push(makeShadowLight());
        const { material, rebuilt } = await twoMaterials(scene);

        rebuilt.receiveShadows = true;
        material.doubleSided = true;
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
    });

    it("refuses thin-instanced and transmissive meshes, a mesh outside its group and any mesh during a runtime build", async () => {
        const { scene, group, material, rebuilt } = await twoMaterials();
        material.doubleSided = true;
        requestRebuild(material);
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(true);

        (rebuilt as unknown as { thinInstances: unknown }).thinInstances = { count: 2, matrices: new Float32Array(32) };
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
        (rebuilt as unknown as { thinInstances: unknown }).thinInstances = null;

        material._transmissive = true;
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
        material._transmissive = false;

        group.splice(group.indexOf(rebuilt), 1);
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
        group.push(rebuilt);

        scene._runtimeBuilds = { w: true } as unknown as RuntimeSceneBuildHooks;
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
        scene._runtimeBuilds = undefined;
        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(true);
    });

    it("refuses a material that enabled UV transforms after the group was built", async () => {
        const { scene, material, rebuilt } = await twoMaterials();

        // The documented path: enable, then `rebuildMaterial`. The group closure has no template extension to compose it.
        material.doubleSided = true;
        enableMaterialUvTransform(material);
        requestRebuild(material);

        expect(_pbrRebuildsComposed(scene, [rebuilt])).toBe(false);
    });
});
