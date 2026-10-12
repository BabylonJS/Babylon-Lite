import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createDirectionalLight } from "../../../packages/babylon-lite/src/light/directional-light";
import { createHemisphericLight } from "../../../packages/babylon-lite/src/light/hemispheric";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { MSH_RECEIVE_SHADOWS } from "../../../packages/babylon-lite/src/material/mesh-features";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { _pbrMeshRequest } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import { isPbrForwardBuildCurrent } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

/**
 * The PBR geometry renderer derives its renderables from the forward PBR context, so it may only bind a mesh
 * while the forward renderable the scene tracks for it was built for the mesh's CURRENT generation. Forward
 * rebuilds are asynchronous and make-before-break: while one is pending, the tracked renderable is the old
 * one and the published context is the old one. These tests run the REAL forward PBR group build (mocked
 * device) and check the generation stamp it leaves on its renderables against `isPbrForwardBuildCurrent`,
 * the predicate the geometry task uses.
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

/** One complete forward PBR group build of `mesh`: returns the renderable the scene would now track for it. */
async function forwardBuild(scene: SceneContext, mesh: Mesh) {
    scene._groups.set(mesh.material!._buildGroup, [mesh]);
    return (await buildPbrRenderables(scene, [mesh], undefined)).renderables[0]!;
}

const publishedContext = (scene: SceneContext): unknown => (scene as unknown as { _pbrGeomContext?: unknown })._pbrGeomContext;

describe("PBR forward build generation", () => {
    it("stamps every forward renderable with the generation it was built for", async () => {
        const scene = makeScene();
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const forward = await forwardBuild(scene, mesh);

        expect(forward.mesh).toBe(mesh);
        // The context it was composed against is the one the build published, and the rest of the stamp is
        // exactly the request the geometry pass derives for the mesh from the live scene.
        expect(publishedContext(scene)).toBeDefined();
        expect(forward._gen?.[0]).toBe(publishedContext(scene));
        expect(forward._gen?.[4]).toBe(material._renderFeatures);
        expect(forward._gen?.slice(0, 4)).toEqual([..._pbrMeshRequest(scene, mesh, 0)]);
        expect(isPbrForwardBuildCurrent(scene, forward, mesh)).toBe(true);
        // A mesh that has not been forward-built yet has nothing to be current with.
        expect(isPbrForwardBuildCurrent(scene, undefined, mesh)).toBe(false);
    });

    it("treats retained output as stale once the mesh gains a capability the build did not cover", async () => {
        const scene = makeScene();
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(scene, mesh);

        // First thin instances on an already-built mesh: the forward rebuild is pending and the scene still
        // tracks `retained`, whose context has no thin-instance helpers.
        (mesh as unknown as { thinInstances: unknown }).thinInstances = { count: 4, matrices: new Float32Array(64) };
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        (mesh as unknown as { thinInstances: unknown }).thinInstances = null;
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(true);
    });

    it("treats retained output as stale while a material rebuild is pending, and current again after it", async () => {
        const scene = makeScene();
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(scene, mesh);

        // `rebuildMaterial()` drops the render-feature object when the rebuild is requested...
        material._renderFeatures = undefined;
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        // ...and the forward rebuild that completes later stamps its new renderable with the new one.
        const rebuilt = await forwardBuild(scene, mesh);
        expect(material._renderFeatures).toBeDefined();
        expect(isPbrForwardBuildCurrent(scene, rebuilt, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);
    });

    it("treats retained output as stale once a single-light mesh starts receiving shadows", async () => {
        // One shadow-casting light, a mesh that does not receive shadows: the build takes the single-light
        // path, and its composer carries nothing else.
        const scene = makeScene();
        scene.lights.push(makeShadowLight());
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(scene, mesh);
        expect(retained._gen?.slice(1, 4)).toEqual([retained._gen![1] & ~MSH_RECEIVE_SHADOWS, 1, "directional"]);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(true);

        // `receiveShadows` is enabled while the rebuild is pending. A mono-light shadow receiver uses the
        // multi-light path: that is what the geometry pass would now ask of the retained single-light
        // composer. Neither the material nor any mesh capability bit changed.
        mesh.receiveShadows = true;
        const request = _pbrMeshRequest(scene, mesh, 0);
        expect(request[0]).toBe(retained._gen![0]);
        expect([request[1] & MSH_RECEIVE_SHADOWS, request[2], request[3]]).toEqual([MSH_RECEIVE_SHADOWS, 2, ""]);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        // The rebuild completes: a new context that covers the request, and a renderable stamped with it.
        const rebuilt = await forwardBuild(scene, mesh);
        expect(rebuilt._gen?.[0]).toBe(publishedContext(scene));
        expect(rebuilt._gen?.[0]).not.toBe(retained._gen![0]);
        expect(isPbrForwardBuildCurrent(scene, rebuilt, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        // And the other way round: shadow receiving switched off again is a pending rebuild as well.
        mesh.receiveShadows = false;
        expect(isPbrForwardBuildCurrent(scene, rebuilt, mesh)).toBe(false);
    });

    it("treats retained output as stale once a second light reaches the mesh", async () => {
        const scene = makeScene();
        scene.lights.push(createDirectionalLight([0, -1, 0]));
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const retained = await forwardBuild(scene, mesh);
        const retainedFeatures = _pbrMeshRequest(scene, mesh, 0)[1];
        expect(retained._gen?.slice(1, 4)).toEqual([retainedFeatures, 1, "directional"]);

        // A second light: no material change, no mesh capability bit changes — the scene-level light setup
        // did. The geometry pass would ask the retained single-light composer for the multi-light path.
        scene.lights.push(createHemisphericLight([0, 1, 0]));
        expect([..._pbrMeshRequest(scene, mesh, 0)]).toEqual([retained._gen![0], retainedFeatures, 2, ""]);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        const rebuilt = await forwardBuild(scene, mesh);
        expect(rebuilt._gen?.slice(1, 4)).toEqual([retainedFeatures, 2, ""]);
        expect(isPbrForwardBuildCurrent(scene, rebuilt, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(scene, retained, mesh)).toBe(false);

        // Back to one light of ANOTHER type: single-light again, but not the block the context was built with.
        scene.lights.shift();
        expect(_pbrMeshRequest(scene, mesh, 0).slice(2)).toEqual([1, "hemispheric"]);
        expect(isPbrForwardBuildCurrent(scene, rebuilt, mesh)).toBe(false);
    });

    it("treats output built against another PBR context as stale", async () => {
        // The geometry pass composes against the context the scene publishes for the mesh. A tracked
        // renderable that came from a different build than that context proves nothing about it, even when
        // material, capabilities and lights all match.
        const scene = makeScene();
        scene.lights.push(createDirectionalLight([0, -1, 0]));
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        const first = await forwardBuild(scene, mesh);
        const second = await forwardBuild(scene, mesh);

        expect(second._gen?.slice(1)).toEqual(first._gen?.slice(1));
        expect(isPbrForwardBuildCurrent(scene, second, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(scene, first, mesh)).toBe(false);

        // A runtime per-mesh build keeps its own context for the mesh; that one is then the reference.
        (scene as unknown as { _pbrMeshGeomContexts: WeakMap<Mesh, unknown> })._pbrMeshGeomContexts = new WeakMap([[mesh, first._gen![0]]]);
        expect(isPbrForwardBuildCurrent(scene, first, mesh)).toBe(true);
        expect(isPbrForwardBuildCurrent(scene, second, mesh)).toBe(false);
    });
});
