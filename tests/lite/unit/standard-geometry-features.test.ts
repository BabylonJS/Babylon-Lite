import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { makePackMeshWorld, packMat4IntoF32WithOffset } from "../../../packages/babylon-lite/src/large-world/pack-mat4-with-offset";
import { wrapRenderableForFO } from "../../../packages/babylon-lite/src/large-world/floating-origin";
import { preloadStandardGeometryFeatures, _getStandardGeometryThinInstanceHelpers } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import { syncThinInstanceBuffers, syncThinInstanceForDraw } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import { createThinInstanceFragment } from "../../../packages/babylon-lite/src/shader/fragments/thin-instance-fragment";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { buildStandardMeshRenderables, type StandardRebuildContext } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { STD_SCENE_FOG } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { createStandardFogFragment } from "../../../packages/babylon-lite/src/material/standard/std-fog-wgsl";
import { createStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment";
import { _installStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { buildStandardGeometryRenderable, disposeStandardGeometryViewResources } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable";
import { disposeNodeGeometryViewResources } from "../../../packages/babylon-lite/src/material/node/node-geometry-renderable";
import { createStandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import type { StandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import type { PbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { createNodeGeometryMaterialView } from "../../../packages/babylon-lite/src/material/node/node-geometry-view";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";

const gpuGlobals = globalThis as typeof globalThis & { GPUBufferUsage?: unknown; GPUShaderStage?: unknown; GPUTextureUsage?: unknown };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8, STORAGE: 0x80 } as unknown as GPUBufferUsage;
gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_SRC: 0x1, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeMockEngine(): EngineContext {
    const device = {
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout,
        createBindGroup: (d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup,
        createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout,
        createRenderPipeline: (d: GPURenderPipelineDescriptor) => d as unknown as GPURenderPipeline,
        createShaderModule: (d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule,
        createSampler: (d: GPUSamplerDescriptor) => d as unknown as GPUSampler,
        createBuffer: (d: GPUBufferDescriptor) => ({ descriptor: d, destroy: () => undefined }) as unknown as GPUBuffer,
        queue: { writeBuffer: () => undefined },
    } as unknown as GPUDevice;
    const eng = {
        canvas: {},
        msaaSamples: 1,
        maxDevicePixelRatio: Infinity,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        format: "bgra8unorm",
        _disposables: [],
    } as unknown as EngineContext;
    Object.assign(eng, { engine: eng });
    return eng;
}

function makeStdMesh(gpu: object = {}): Mesh {
    const world = worldAt(0, 0, 0);
    return { material: createStandardMaterial(), receiveShadows: false, morphTargets: null, worldMatrix: world, worldMatrixVersion: 1, _gpu: gpu } as unknown as Mesh;
}

// ── Blocker 4: the singleton Standard builder must not cross-contaminate scenes ──
describe("Standard per-scene rebuild context", () => {
    it("stores an independent engine/fog rebuild context on each scene and does not let a later build clobber an earlier scene's", () => {
        const engA = makeMockEngine();
        const engB = makeMockEngine();
        const sceneA = createSceneContext(engA, { defaultRenderTask: false }) as SceneContext;
        const sceneB = createSceneContext(engB, { defaultRenderTask: false }) as SceneContext;
        const meshA = makeStdMesh();
        const meshB = makeStdMesh();

        const fogCtx = { _features: STD_SCENE_FOG, _fragments: [createStandardFogFragment()] };
        // Scene A builds WITH fog.
        buildStandardMeshRenderables(sceneA, [meshA], { sceneShader: fogCtx });
        const ctxA = (sceneA as SceneContext & { _standardRebuildContext?: StandardRebuildContext })._standardRebuildContext!;
        expect(ctxA._factories.sceneShader).toBe(fogCtx);
        expect(ctxA._engine).toBe(engA);

        // Scene B builds WITHOUT fog on a DIFFERENT device — the singleton builder
        // must not overwrite scene A's captured fog/engine context.
        buildStandardMeshRenderables(sceneB, [meshB], { sceneShader: null });
        const ctxB = (sceneB as SceneContext & { _standardRebuildContext?: StandardRebuildContext })._standardRebuildContext!;
        expect(ctxB._factories.sceneShader).toBeNull();
        expect(ctxB._engine).toBe(engB);

        // Scene A's context is still its own (fog + engine A) after B built.
        expect(ctxA._factories.sceneShader).toBe(fogCtx);
        expect(ctxA._engine).toBe(engA);
        expect(ctxA).not.toBe(ctxB);
    });
});

/** Column-major mat4 with the given translation column; rotation left as identity. */
function worldAt(x: number, y: number, z: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
}

// ── Blocker 3: explicit vertex-alpha metadata drives Standard transparency ──
describe("Standard vertex-alpha classification", () => {
    it("classifies a Standard renderable transparent only when the mesh opts in AND carries a vertex-colour buffer", () => {
        _installStdVertexColorFragment(createStdVertexColorFragment);
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const opaqueMesh = makeStdMesh({ colorBuffer: {} }); // vertex colour, no opt-in
        const alphaMesh = makeStdMesh({ colorBuffer: {} });
        alphaMesh.hasVertexAlpha = true;
        const noColorAlphaMesh = makeStdMesh({}); // opt-in but no vertex-colour buffer
        noColorAlphaMesh.hasVertexAlpha = true;

        const { renderables } = buildStandardMeshRenderables(scene, [opaqueMesh, alphaMesh, noColorAlphaMesh], { sceneShader: null });
        const [rOpaque, rAlpha, rNoColor] = renderables;

        // Opt-in + vertex colour → alpha-blended transparent phase.
        expect(rAlpha!.isTransparent).toBe(true);
        expect(rAlpha!.order).toBe(200);
        // Vertex colour but no opt-in → opaque (RGB modulation only).
        expect(rOpaque!.isTransparent).toBe(false);
        expect(rOpaque!.order).toBe(100);
        // Opt-in without an actual vertex-colour buffer stays opaque (never inferred).
        expect(rNoColor!.isTransparent).toBe(false);
        expect(rNoColor!.order).toBe(100);
    });
});

// ── Blocker 2: floating-origin correctness for current AND previous matrices ──
describe("Standard geometry floating-origin packing", () => {
    it("packs the world translation relative to the active-camera origin, rotation untouched", () => {
        const scene = { camera: { worldMatrix: worldAt(1000, 0, 0) } } as unknown as SceneContext;
        const pack = makePackMeshWorld(scene);
        const out = new Float32Array(16);
        pack(out, worldAt(1000, 5, 0), 0, 0);
        // Translation becomes origin-relative; the large 1000 cancels to 0 at F64 precision.
        expect(out[12]).toBe(0);
        expect(out[13]).toBe(5);
        expect(out[14]).toBe(0);
        // Rotation/scale columns are copied verbatim.
        expect(out[0]).toBe(1);
        expect(out[5]).toBe(1);
        expect(out[10]).toBe(1);
    });

    it("keeps current and previous matrices consistent across an origin jump", () => {
        // The geometry renderable snapshots previous-world with the SAME packer as
        // current-world, so each frame's matrix is origin-relative to that frame's
        // camera origin — matching the origin-relative previousViewProjection.
        const world = worldAt(2000, 5, 0);
        // Frame N: origin O1.
        const prev = new Float32Array(16);
        packMat4IntoF32WithOffset(prev, world, 0, 0, 1000, 0, 0);
        expect([prev[12], prev[13], prev[14]]).toEqual([1000, 5, 0]);
        // Frame N+1: origin jumps to O2; current is repacked with the new offset.
        const curr = new Float32Array(16);
        packMat4IntoF32WithOffset(curr, world, 0, 0, 3000, 0, 0);
        expect([curr[12], curr[13], curr[14]]).toEqual([-1000, 5, 0]);
        // An absolute (non-origin-relative) previous world would leave 2000 here and
        // mismatch the origin-relative previousViewProjection — the bug this fixes.
        expect(prev[12]).not.toBe(world[12]);
    });

    it("wrapRenderableForFO invalidates the mesh UBO on camera-version change only", () => {
        const cam = { worldMatrixVersion: 0 };
        const scene = { camera: cam } as unknown as SceneContext;
        let invalidated = 0;
        let ran = 0;
        const update = wrapRenderableForFO(
            () => {
                ran++;
            },
            scene,
            () => {
                invalidated++;
            }
        );
        update(); // first run: version -1 → 0, invalidates once, runs inner
        expect(invalidated).toBe(1);
        expect(ran).toBe(1);
        update(); // same version: no invalidate, inner still runs
        expect(invalidated).toBe(1);
        expect(ran).toBe(2);
        cam.worldMatrixVersion = 7; // camera (origin) moved → re-pack forced
        update();
        expect(invalidated).toBe(2);
        expect(ran).toBe(3);
    });
});

// ── Blocker 5: thin-instance helpers stay out of non-thin geometry bundles ──
describe("Standard geometry thin-instance injection", () => {
    it("injects thin-instance helpers only after a geometry-pass mesh carries thin instances", async () => {
        await preloadStandardGeometryFeatures([{ thinInstances: { matrixData: new Float32Array(16), count: 1 } }] as unknown as readonly Mesh[], false);
        const helpers = _getStandardGeometryThinInstanceHelpers();
        expect(helpers).not.toBeNull();
        expect(helpers!._fragment).toBe(createThinInstanceFragment);
        expect(helpers!._syncBuffers).toBe(syncThinInstanceBuffers);
        expect(helpers!._syncForDraw).toBe(syncThinInstanceForDraw);
    });
});

// ── Blockers 2 & 4: build a real Standard geometry renderable and inspect it ──
function makeCamera(x: number, y: number, z: number, version = 1): Camera {
    return { worldMatrix: worldAt(x, y, z), worldMatrixVersion: version } as unknown as Camera;
}

function buildGeoRenderable(scene: SceneContext, camera: Camera | null) {
    const source = createStandardMaterial();
    const view = createStandardGeometryMaterialView(source, {
        attachments: [GeometryTextureType.WORLD_POSITION],
        emitColor: false,
        camera,
    }) as StandardGeometryMaterialView;
    const mesh = {
        material: source,
        worldMatrix: worldAt(5000, 3, 0),
        worldMatrixVersion: 1,
        hasVertexAlpha: false,
        skeleton: null,
        thinInstances: null,
        morphTargets: null,
        visible: true,
        _gpu: {},
    } as unknown as Mesh;
    const renderable = buildStandardGeometryRenderable(scene, mesh, view);
    return { renderable, mesh };
}

describe("Standard geometry task-camera floating-origin", () => {
    it("packs world/previous-world and invalidates against the effective task camera override", () => {
        const engine = makeMockEngine();
        const packScenes: Array<{ camera?: Camera | null }> = [];
        const foScenes: Array<{ camera?: Camera | null }> = [];
        // Enable floating origin with spies that record which "scene" (camera source) each hook sees.
        (engine as { _makePackMeshWorld?: unknown })._makePackMeshWorld = (s: SceneContext) => {
            packScenes.push(s);
            return makePackMeshWorld(s);
        };
        (engine as { _wrapRenderableForFO?: unknown })._wrapRenderableForFO = (inner: () => void, s: SceneContext, inv: () => void) => {
            foScenes.push(s);
            return wrapRenderableForFO(inner, s, inv);
        };
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        scene.camera = makeCamera(1000, 0, 0);
        const overrideCamera = makeCamera(5000, 0, 0);

        buildGeoRenderable(scene, overrideCamera);
        // Both the mesh-world packer and the FO invalidation wrapper must key off the
        // override camera — NOT scene.camera — so origins stay consistent with the
        // task's view-projection.
        expect(packScenes[0]!.camera).toBe(overrideCamera);
        expect(foScenes[0]!.camera).toBe(overrideCamera);
    });

    it("falls back to the scene's active camera when the task supplies no override", () => {
        const engine = makeMockEngine();
        const packScenes: Array<{ camera?: Camera | null }> = [];
        (engine as { _makePackMeshWorld?: unknown })._makePackMeshWorld = (s: SceneContext) => {
            packScenes.push(s);
            return makePackMeshWorld(s);
        };
        (engine as { _wrapRenderableForFO?: unknown })._wrapRenderableForFO = (inner: () => void, s: SceneContext, inv: () => void) => wrapRenderableForFO(inner, s, inv);
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const sceneCamera = makeCamera(1000, 0, 0);
        scene.camera = sceneCamera;

        buildGeoRenderable(scene, null);
        expect(packScenes[0]!.camera).toBe(sceneCamera);
    });
});

// ── Cross-family: the effective task camera reaches EVERY geometry family's view, so
//    Standard, PBR and Node all pack world origin-relative to the override camera. ──
describe("Geometry view effective-camera threading (all families)", () => {
    const families: Array<
        [string, (src: unknown, cfg: { attachments: readonly GeometryTextureType[]; emitColor: boolean; camera?: Camera | null }) => { _camera: Camera | null }]
    > = [
        ["standard", (src, cfg) => createStandardGeometryMaterialView(src as never, cfg) as unknown as { _camera: Camera | null }],
        ["pbr", (src, cfg) => createPbrGeometryMaterialView(src as never, cfg) as unknown as { _camera: Camera | null }],
        ["node", (src, cfg) => createNodeGeometryMaterialView(src as never, cfg) as unknown as { _camera: Camera | null }],
    ];

    it.each(families)("%s view captures the override camera and packs world origin-relative to it at large coords", (_family, make) => {
        const overrideCamera = makeCamera(5000, 0, 0);
        const source = { _renderFeatures: { features: 0, features2: 0 } };
        const view = make(source, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false, camera: overrideCamera });
        expect(view._camera).toBe(overrideCamera);

        // The renderable builds `foScene = view._camera ? { camera: view._camera } : scene`
        // and packs mesh world through it — so a mesh at large X=5000 lands origin-relative
        // (0) to the override, NOT the scene camera (which sits far away at X=9000).
        const sceneCamera = makeCamera(9000, 0, 0);
        const foScene = (view._camera ? { camera: view._camera } : { camera: sceneCamera }) as unknown as SceneContext;
        const packed = new Float32Array(16);
        makePackMeshWorld(foScene)(packed, worldAt(5000, 2, 0), 0, 0);
        expect([packed[12], packed[13], packed[14]]).toEqual([0, 2, 0]);
    });

    it.each(families)("%s view preserves no-override behavior: _camera is null and world packs relative to the scene camera", (_family, make) => {
        const source = { _renderFeatures: { features: 0, features2: 0 } };
        const view = make(source, { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false });
        expect(view._camera).toBeNull();

        // No override → foScene = scene → world is origin-relative to the SCENE camera (X=9000).
        const sceneCamera = makeCamera(9000, 0, 0);
        const foScene = (view._camera ? { camera: view._camera } : { camera: sceneCamera }) as unknown as SceneContext;
        const packed = new Float32Array(16);
        makePackMeshWorld(foScene)(packed, worldAt(5000, 2, 0), 0, 0);
        expect([packed[12], packed[13], packed[14]]).toEqual([-4000, 2, 0]);
    });
});

// ── PBR geometry override-camera floating-origin shadow-receiving contract ──
// Mirrors the inlined gate in `buildPbrGeometryRenderable` (pbr-geometry-renderable.ts):
//   receiveShadows = mesh.receiveShadows && hasSomeShadows && !(view._camera && engine.useFloatingOrigin)
// Kept as a local mirror because the production gate is inlined (rather than an
// exported helper) so it tree-shakes to nothing in PBR geometry scenes that
// receive no shadows, preserving their guarded bundle ceilings.
function pbrGeometryReceivesShadows(mesh: Mesh, view: PbrGeometryMaterialView, engine: EngineContext, hasSomeShadows: boolean): boolean {
    return mesh.receiveShadows && hasSomeShadows && !(view._camera && engine.useFloatingOrigin);
}

describe("PBR geometry override-camera floating-origin shadow receiving", () => {
    function makePbrGeoView(overrideCamera: Camera | null): PbrGeometryMaterialView {
        const source = { _renderFeatures: { features: 0, features2: 0 } };
        return createPbrGeometryMaterialView(source as never, {
            attachments: [GeometryTextureType.WORLD_POSITION],
            emitColor: false,
            ...(overrideCamera ? { camera: overrideCamera } : {}),
        }) as unknown as PbrGeometryMaterialView;
    }
    const foEngine = { useFloatingOrigin: true } as unknown as EngineContext;
    const nonFoEngine = { useFloatingOrigin: false } as unknown as EngineContext;
    const shadowReceiver = { receiveShadows: true } as unknown as Mesh;

    it("disables shadow receiving for an override-camera FO task because the shared scene-camera shadow matrix mis-transforms the override-relative receiver world", () => {
        // Scene camera far from the override; a receiver mesh sits at the override eye.
        const sceneCamera = makeCamera(9000, 0, 0);
        const overrideCamera = makeCamera(5000, 0, 0);
        const view = makePbrGeoView(overrideCamera);
        expect(view._camera).toBe(overrideCamera);

        // The task packs the receiver world origin-relative to the OVERRIDE camera
        // (real production packer): a mesh at absolute X=5000 packs to X=0.
        const packed = new Float32Array(16);
        makePackMeshWorld({ camera: overrideCamera } as unknown as SceneContext)(packed, worldAt(5000, 3, 0), 0, 0);
        expect(packed[12]).toBe(0);

        // A shared shadow matrix is baked eye-relative to the SCENE camera, so it
        // expects the SAME world expressed scene-relative: absolute X=5000 → X=-4000.
        const sceneRelativeX = 5000 - sceneCamera.worldMatrix[12]!;
        expect(sceneRelativeX).toBe(-4000);
        // Binding that matrix against the packed (override-relative) world would
        // evaluate 0 where -4000 is expected — a displacement equal to the origin
        // delta D = O_override − O_scene. That incoherence is why override-FO tasks
        // disable shadow receiving.
        const originDelta = overrideCamera.worldMatrix[12]! - sceneCamera.worldMatrix[12]!;
        expect(packed[12]! - sceneRelativeX).toBe(-originDelta);
        expect(pbrGeometryReceivesShadows(shadowReceiver, view, foEngine, true)).toBe(false);
    });

    it("keeps shadow receiving when the task uses no override camera (receiver world and shadow matrix share the scene-camera origin)", () => {
        const view = makePbrGeoView(null);
        expect(view._camera).toBeNull();
        expect(pbrGeometryReceivesShadows(shadowReceiver, view, foEngine, true)).toBe(true);
    });

    it("keeps shadow receiving under an override camera when floating origin is inactive (worlds are absolute, so origins already agree)", () => {
        const view = makePbrGeoView(makeCamera(5000, 0, 0));
        expect(pbrGeometryReceivesShadows(shadowReceiver, view, nonFoEngine, true)).toBe(true);
    });

    it("never receives shadows when the mesh opts out or no shadow lights exist, regardless of override state", () => {
        const view = makePbrGeoView(makeCamera(5000, 0, 0));
        const nonReceiver = { receiveShadows: false } as unknown as Mesh;
        expect(pbrGeometryReceivesShadows(nonReceiver, view, nonFoEngine, true)).toBe(false);
        expect(pbrGeometryReceivesShadows(shadowReceiver, makePbrGeoView(null), foEngine, false)).toBe(false);
    });
});

describe("Standard geometry aux-disposer drain safety", () => {
    it("does not skip sibling packets and is idempotent when the aux array is drained live", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const { mesh } = buildGeoRenderable(scene, null);

        const auxList = scene._meshAuxDisposables.get(mesh)!;
        expect(auxList).toHaveLength(1); // the real per-mesh geometry disposer

        // A second packet (e.g. another geometry task) on the same mesh.
        const sibling = vi.fn();
        auxList.push(sibling);

        // Simulate the scene-remove / scene-core drain: iterate the LIVE array.
        for (const fn of auxList) {
            fn();
        }
        // The real disposer must NOT self-remove — otherwise the sibling at index 1
        // would be skipped when index 0 splices itself out mid-iteration.
        expect(sibling).toHaveBeenCalledOnce();
        expect(auxList).toHaveLength(2);

        // Idempotent: running the real disposer again is a safe no-op (no double free).
        expect(() => auxList[0]!()).not.toThrow();
    });

    it("wires the Standard geometry renderable's _geometryDispose onto _meshAuxDisposables (never _meshDisposables) so material swaps cannot invalidate it", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false }) as SceneContext;
        const { renderable, mesh } = buildGeoRenderable(scene, null);

        expect(typeof renderable._geometryDispose).toBe("function");
        // The disposer registered on the aux list IS the renderable's _geometryDispose.
        expect(scene._meshAuxDisposables.get(mesh)).toContain(renderable._geometryDispose);
        // A MAIN-material swap drains _meshDisposables; the geometry packet must NOT be there.
        expect(scene._meshDisposables.has(mesh)).toBe(false);
    });
});

// ── Blocker 2: per-mesh + per-view ownership across all three geometry families ──
// Every family registers its per-mesh geometry resources on `scene._meshAuxDisposables`
// (NOT `_meshDisposables`) as an idempotent disposer also assigned to the renderable's
// `_geometryDispose`, so the owning geometry task can retire both on re-record/dispose
// without a material swap ever destroying live geometry bindings. Node additionally
// exposes a per-view `_disposeGeometryResources` for its shared node UBO.
describe("Geometry view resource disposal (per family)", () => {
    it("Standard: destroys the shared material + UV UBOs once and is idempotent", () => {
        const matUBO = { destroy: vi.fn() };
        const upUBO = { destroy: vi.fn() };
        const cache = new Map([["variant", { _matUBO: matUBO, _upUBO: upUBO }]]);
        const view = { _geometry: cache } as unknown as StandardGeometryMaterialView;

        disposeStandardGeometryViewResources(view);
        expect(matUBO.destroy).toHaveBeenCalledOnce();
        expect(upUBO.destroy).toHaveBeenCalledOnce();
        expect(cache.size).toBe(0);

        // Idempotent: cleared cache → no further destroys.
        disposeStandardGeometryViewResources(view);
        expect(matUBO.destroy).toHaveBeenCalledOnce();
    });

    it("PBR: shared per-view cache holds only GC-managed objects, so the view exposes no per-view disposer", () => {
        const src = { _renderFeatures: { features: 0, features2: 0 } };
        const cfg = { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false } as const;
        const pbrView = createPbrGeometryMaterialView(src as never, cfg) as unknown as PbrGeometryMaterialView & { _disposeGeometryResources?: () => void };
        // PBR's per-variant cache is composed WGSL + pipelines/BGLs/modules (GC-reclaimed);
        // the per-mesh mesh/material UBOs are freed by the renderable's `_geometryDispose`.
        // So there is nothing to explicitly free per view — no disposer is exposed.
        expect(pbrView._disposeGeometryResources).toBeUndefined();
    });

    it("Node: destroys the shared node UBO once, clears the compile cache, and is idempotent", () => {
        const nodeUBO = { destroy: vi.fn() };
        const compileBySig = new Map([["sig", {}]]);
        const res = { _nodeUBO: nodeUBO, _nodeUBOReady: true, _compileBySig: compileBySig };
        const view = { _geometry: res } as unknown as import("../../../packages/babylon-lite/src/material/node/node-geometry-view").NodeGeometryMaterialView;

        disposeNodeGeometryViewResources(view);
        expect(nodeUBO.destroy).toHaveBeenCalledOnce();
        expect(res._nodeUBO).toBeNull();
        expect(res._nodeUBOReady).toBe(false);
        expect(compileBySig.size).toBe(0);
        expect((view as unknown as { _geometry: unknown })._geometry).toBeUndefined();

        // Idempotent: the cache reference was dropped, so a second call is a no-op.
        disposeNodeGeometryViewResources(view);
        expect(nodeUBO.destroy).toHaveBeenCalledOnce();
    });

    it("Node view exposes a _disposeGeometryResources closure from its factory (its shared node UBO needs an explicit free)", () => {
        const src = { _renderFeatures: { features: 0, features2: 0 } };
        const cfg = { attachments: [GeometryTextureType.WORLD_POSITION], emitColor: false } as const;
        const nodeView = createNodeGeometryMaterialView(src as never, cfg) as unknown as { _disposeGeometryResources?: () => void };
        expect(typeof nodeView._disposeGeometryResources).toBe("function");
    });
});
