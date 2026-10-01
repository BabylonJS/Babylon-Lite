import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { enableMaterialPlugins, reconcileMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { _computePbrMaterialFeatures, createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { ToneMapping } from "../../../packages/babylon-lite/src/material/pbr/tone-mapping";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

function makeEngine(): { engine: EngineContext; createShaderModule: ReturnType<typeof vi.fn> } {
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule);
    const device = {
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule,
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(
            () =>
                ({
                    createView: vi.fn(() => ({}) as GPUTextureView),
                    destroy: vi.fn(),
                }) as unknown as GPUTexture
        ),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return {
                destroy: vi.fn(),
                getMappedRange: vi.fn(() => storage),
                unmap: vi.fn(),
            } as unknown as GPUBuffer;
        }),
        queue: {
            writeBuffer: vi.fn(),
            writeTexture: vi.fn(),
        },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, createShaderModule };
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material,
        receiveShadows: false,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        _gpu: {},
    } as unknown as Mesh;
}

const signature = {
    _colorFormat: "rgba8unorm",
    _depthStencilFormat: "depth24plus",
    _sampleCount: 1,
} as RenderTargetSignature;

function fragmentSources(createShaderModule: ReturnType<typeof vi.fn>): string[] {
    return createShaderModule.mock.calls.map((call) => (call[0] as GPUShaderModuleDescriptor).code).filter((code) => code.includes("@fragment fn main"));
}

/** What the geometry renderer task does for one PBR mesh on every record: a NEW geometry view of the material,
 *  a geometry renderable built and bound against it. Returns the bound pipeline (the mock device hands the
 *  descriptor back) and the release of the renderable's task-owned resources, which the task runs only once
 *  the next generation is built (make-before-break) or the task is disposed. */
function bindPbrGeometry(engine: EngineContext, scene: SceneContext, mesh: Mesh): [GPURenderPipelineDescriptor, () => void] {
    const view = createPbrGeometryMaterialView(mesh.material as PbrMaterialProps, {
        attachments: [GeometryTextureType.WORLD_NORMAL],
        emitColor: false,
    });
    const owner = { _lifetimeDisposers: [] as (() => void)[] };
    const pipeline = buildPbrGeometryRenderable(scene, mesh, view, owner).bind(engine, signature).pipeline as unknown as GPURenderPipelineDescriptor;
    return [pipeline, () => owner._lifetimeDisposers.splice(0).forEach((dispose) => dispose())];
}

describe("PBR shader variant caches", () => {
    beforeEach(() => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
    });

    it("separates tone-mapping algorithms that share all feature flags", async () => {
        const { engine, createShaderModule } = makeEngine();
        const makeToneMapping = (id: string): ToneMapping => ({
            id,
            helpersWGSL: "",
            callWGSL: `color*=scene.vImageInfos.x;\ncolor+=vec3f(0.0); // ${id}`,
        });
        const pipelines: GPURenderPipeline[] = [];

        for (const id of ["tone-a", "tone-b"]) {
            const scene = createSceneContext(engine, { defaultRenderTask: false });
            scene.imageProcessing.toneMappingEnabled = true;
            scene.imageProcessing.toneMapping = makeToneMapping(id);
            const material = createPbrMaterial();
            const mesh = makeMesh(material);
            scene._groups.set(material._buildGroup, [mesh]);
            const result = await buildPbrRenderables(scene, [mesh], undefined);
            pipelines.push(result.renderables[0]!.bind(engine, signature).pipeline);
        }

        expect(pipelines[0]).not.toBe(pipelines[1]);
        const fragments = fragmentSources(createShaderModule);
        expect(fragments.some((code) => code.includes("// tone-a"))).toBe(true);
        expect(fragments.some((code) => code.includes("// tone-b"))).toBe(true);
    });

    it("separates material-plugin variants without consuming native feature bits", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const plugin = (name: string, marker: string): MaterialPlugin => ({
            name,
            getCustomCode: (shaderType) => (shaderType === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: marker } : null),
        });
        const materialA = createPbrMaterial({ plugins: [plugin("plugin-a", "if(material.materialAlpha < -1.0){discard;}")] });
        const materialB = createPbrMaterial({ plugins: [plugin("plugin-b", "if(material.materialAlpha < -2.0){discard;}")] });
        const meshes = [makeMesh(materialA), makeMesh(materialB)];
        scene._groups.set(materialA._buildGroup, meshes);
        enableMaterialPlugins(scene);

        const result = await buildPbrRenderables(scene, meshes, undefined);
        const pipelineA = result.renderables[0]!.bind(engine, signature).pipeline;
        const pipelineB = result.renderables[1]!.bind(engine, signature).pipeline;

        expect(materialA._renderFeatures?.features2).toBe(materialB._renderFeatures?.features2);
        expect(materialA._pi).not.toBe(materialB._pi);
        expect(pipelineA).not.toBe(pipelineB);
        const fragments = fragmentSources(createShaderModule);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -1.0"))).toBe(true);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -2.0"))).toBe(true);
    });

    it("keeps plugin signature identities stable across scenes", async () => {
        const { engine, createShaderModule } = makeEngine();
        const makePlugin = (name: string, marker: string): MaterialPlugin => ({
            name,
            getCustomCode: (shaderType) => (shaderType === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: marker } : null),
        });
        const materialA = createPbrMaterial({ plugins: [makePlugin("scene-a", "if(material.materialAlpha < -5.0){discard;}")] });
        const sceneA = createSceneContext(engine, { defaultRenderTask: false });
        const meshA = makeMesh(materialA);
        sceneA._groups.set(materialA._buildGroup, [meshA]);
        enableMaterialPlugins(sceneA);
        const renderableA = (await buildPbrRenderables(sceneA, [meshA], undefined)).renderables[0]!;

        const materialB = createPbrMaterial({ plugins: [makePlugin("scene-b", "if(material.materialAlpha < -6.0){discard;}")] });
        const sceneB = createSceneContext(engine, { defaultRenderTask: false });
        const meshB = makeMesh(materialB);
        sceneB._groups.set(materialB._buildGroup, [meshB]);
        enableMaterialPlugins(sceneB);
        const renderableB = (await buildPbrRenderables(sceneB, [meshB], undefined)).renderables[0]!;

        expect(materialA._pi).not.toBe(materialB._pi);
        renderableA.bind(engine, signature);
        renderableB.bind(engine, signature);
        const fragments = fragmentSources(createShaderModule);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -5.0"))).toBe(true);
        expect(fragments.some((code) => code.includes("material.materialAlpha < -6.0"))).toBe(true);
    });

    it("recomputes runtime PBR plugin signatures for attachment, toggles, code changes, and disposal", async () => {
        const { engine } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        let marker = "a";
        const plugin: MaterialPlugin = {
            name: "runtime",
            getCustomCode: () => ({ CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `// ${marker}` }),
        };
        const material = createPbrMaterial();
        const target = makeMesh(material);
        const seenIndices: number[] = [];
        const makeRenderable = () => ({
            mesh: target,
            order: 0,
            isTransparent: false,
            bind: () => {
                throw new Error("The reconciliation test does not bind renderables.");
            },
        });
        const rebuild = vi.fn(() => {
            expect(material._renderFeatures).toBeUndefined();
            material._renderFeatures = _computePbrMaterialFeatures(material);
            seenIndices.push(material._pi ?? 0);
            return makeRenderable();
        });
        scene.meshes.push(target);
        scene._groups.set(material._buildGroup, Object.assign([target], { r: rebuild }));
        scene._renderables.push(makeRenderable());
        scene._meshDisposables.set(target, []);
        scene._built = true;
        material._renderFeatures = _computePbrMaterialFeatures(material);

        material.plugins = [plugin];
        await reconcileMaterialPlugins(scene, material);
        plugin.isEnabled = false;
        await reconcileMaterialPlugins(scene, material);
        plugin.isEnabled = true;
        marker = "b";
        await reconcileMaterialPlugins(scene, material);
        material.plugins = [];
        await reconcileMaterialPlugins(scene, material);

        expect(seenIndices[0]).toBeGreaterThan(0);
        expect(new Set(seenIndices.slice(0, 3)).size).toBe(3);
        expect(seenIndices[3]).toBe(0);
    });

    it("normalizes a missing material-plugin index to zero", async () => {
        const { engine } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const materialWithoutIndex = createPbrMaterial();
        const materialWithZeroIndex = createPbrMaterial();
        materialWithZeroIndex._pi = 0;
        const meshes = [makeMesh(materialWithoutIndex), makeMesh(materialWithZeroIndex)];
        scene._groups.set(materialWithoutIndex._buildGroup, meshes);

        const result = await buildPbrRenderables(scene, meshes, undefined);
        const pipelineWithoutIndex = result.renderables[0]!.bind(engine, signature).pipeline;
        const pipelineWithZeroIndex = result.renderables[1]!.bind(engine, signature).pipeline;

        expect(pipelineWithZeroIndex).toBe(pipelineWithoutIndex);
    });

    it("keeps forward and geometry variants separate for different storage layouts", async () => {
        const { engine } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createPbrMaterial();
        const meshA = makeMesh(material);
        const meshB = makeMesh(material);
        meshA._gpu = {
            ...meshA._gpu,
            _vbLayout: {
                position: { _stride: 32, _offset: 0 },
                normal: { _stride: 32, _offset: 12 },
                uv: { _stride: 32, _offset: 24 },
            },
            _vbKey: ":storage-a",
        };
        meshB._gpu = {
            ...meshB._gpu,
            _vbLayout: {
                position: { _stride: 40, _offset: 4 },
                normal: { _stride: 40, _offset: 20 },
                uv: { _stride: 40, _offset: 32 },
            },
            _vbKey: ":storage-b",
        };
        scene._groups.set(material._buildGroup, [meshA, meshB]);

        const forward = await buildPbrRenderables(scene, [meshA, meshB], undefined);
        const forwardA = forward.renderables[0]!.bind(engine, signature).pipeline as unknown as GPURenderPipelineDescriptor;
        const forwardB = forward.renderables[1]!.bind(engine, signature).pipeline as unknown as GPURenderPipelineDescriptor;
        expect(forwardB).not.toBe(forwardA);
        expect(forwardA.vertex.buffers).toEqual([
            { arrayStride: 32, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            { arrayStride: 32, stepMode: "vertex", attributes: [{ shaderLocation: 1, offset: 12, format: "float32x3" }] },
            { arrayStride: 32, stepMode: "vertex", attributes: [{ shaderLocation: 2, offset: 24, format: "float32x2" }] },
        ]);
        expect(forwardB.vertex.buffers).toEqual([
            { arrayStride: 40, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 4, format: "float32x3" }] },
            { arrayStride: 40, stepMode: "vertex", attributes: [{ shaderLocation: 1, offset: 20, format: "float32x3" }] },
            { arrayStride: 40, stepMode: "vertex", attributes: [{ shaderLocation: 2, offset: 32, format: "float32x2" }] },
        ]);

        const view = createPbrGeometryMaterialView(material, {
            attachments: [GeometryTextureType.WORLD_NORMAL],
            emitColor: false,
        });
        const ownerA = { _lifetimeDisposers: [] as (() => void)[] };
        const ownerB = { _lifetimeDisposers: [] as (() => void)[] };
        const geometryA = buildPbrGeometryRenderable(scene, meshA, view, ownerA).bind(engine, signature).pipeline as unknown as GPURenderPipelineDescriptor;
        const geometryB = buildPbrGeometryRenderable(scene, meshB, view, ownerB).bind(engine, signature).pipeline as unknown as GPURenderPipelineDescriptor;
        expect(geometryB).not.toBe(geometryA);
        expect(geometryA.vertex.buffers).toEqual(forwardA.vertex.buffers);
        expect(geometryB.vertex.buffers).toEqual(forwardB.vertex.buffers);
        ownerA._lifetimeDisposers.forEach((dispose) => dispose());
        ownerB._lifetimeDisposers.forEach((dispose) => dispose());
    });

    it("threads material-plugin variants through geometry-output composition and caches", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const plugin = (name: string, marker: string): MaterialPlugin => ({
            name,
            getCustomCode: (shaderType) => (shaderType === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: marker } : null),
        });
        const pluginA = plugin("geometry-a", "if(material.materialAlpha < -3.0){discard;}");
        const pluginB = plugin("geometry-b", "if(material.materialAlpha < -4.0){discard;}");
        const materialA = createPbrMaterial({ plugins: [pluginA] });
        const materialB = createPbrMaterial({ plugins: [pluginB] });
        const mesh = makeMesh(materialA);
        scene._groups.set(materialA._buildGroup, [mesh, makeMesh(materialB)]);
        enableMaterialPlugins(scene);
        await buildPbrRenderables(scene, scene._groups.get(materialA._buildGroup)!, undefined);

        const view = createPbrGeometryMaterialView(materialA, {
            attachments: [GeometryTextureType.WORLD_NORMAL],
            emitColor: false,
        });
        const ownerA = { _lifetimeDisposers: [] as (() => void)[] };
        const pipelineA = buildPbrGeometryRenderable(scene, mesh, view, ownerA).bind(engine, signature).pipeline;

        materialA.plugins = [pluginB];
        materialA._pi = materialB._pi;
        const ownerB = { _lifetimeDisposers: [] as (() => void)[] };
        const pipelineB = buildPbrGeometryRenderable(scene, mesh, view, ownerB).bind(engine, signature).pipeline;

        expect(pipelineB).not.toBe(pipelineA);
        expect((view._geometry as Map<string, unknown>).size).toBe(2);
        const geometryFragments = fragmentSources(createShaderModule).filter((code) => code.includes("struct FragmentOutput"));
        expect(geometryFragments.some((code) => code.includes("material.materialAlpha < -3.0"))).toBe(true);
        expect(geometryFragments.some((code) => code.includes("material.materialAlpha < -4.0"))).toBe(true);
    });

    it("reuses PBR geometry shader modules for a later geometry generation", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        scene._groups.set(material._buildGroup, [mesh]);
        // Forward renderables are never bound here, so every compiled module comes from the geometry path.
        await buildPbrRenderables(scene, [mesh], undefined);

        let calls = createShaderModule.mock.calls.length;
        const [first, releaseFirst] = bindPbrGeometry(engine, scene, mesh);
        expect(createShaderModule.mock.calls.length - calls).toBe(2);

        calls = createShaderModule.mock.calls.length;
        const [second] = bindPbrGeometry(engine, scene, mesh);
        releaseFirst();
        expect(second).not.toBe(first);
        expect(createShaderModule.mock.calls.length - calls).toBe(0);
        expect(second.vertex.module).toBe(first.vertex.module);
        expect(second.fragment!.module).toBe(first.fragment!.module);
    });

    it("reuses PBR geometry shader modules after a forward rebuild republishes an equivalent context", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createPbrMaterial();
        const mesh = makeMesh(material);
        scene._groups.set(material._buildGroup, [mesh]);
        await buildPbrRenderables(scene, [mesh], undefined);
        const [first, releaseFirst] = bindPbrGeometry(engine, scene, mesh);
        const firstContext = (scene as { _pbrGeomContext?: unknown })._pbrGeomContext;

        // A new context comes with a new composer, so the composed WGSL is a fresh string of the same code.
        await buildPbrRenderables(scene, [mesh], undefined);
        expect((scene as { _pbrGeomContext?: unknown })._pbrGeomContext).not.toBe(firstContext);

        const calls = createShaderModule.mock.calls.length;
        const [second] = bindPbrGeometry(engine, scene, mesh);
        releaseFirst();
        expect(createShaderModule.mock.calls.length - calls).toBe(0);
        expect(second.vertex.module).toBe(first.vertex.module);
        expect(second.fragment!.module).toBe(first.fragment!.module);
    });

    it("shares one PBR geometry module pair between materials with equal features", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const materialA = createPbrMaterial();
        const materialB = createPbrMaterial();
        const meshA = makeMesh(materialA);
        const meshB = makeMesh(materialB);
        scene._groups.set(materialA._buildGroup, [meshA, meshB]);
        await buildPbrRenderables(scene, [meshA, meshB], undefined);

        const calls = createShaderModule.mock.calls.length;
        const [pipelineA] = bindPbrGeometry(engine, scene, meshA);
        const [pipelineB] = bindPbrGeometry(engine, scene, meshB);

        expect(pipelineB).not.toBe(pipelineA);
        expect(createShaderModule.mock.calls.length - calls).toBe(2);
        expect(pipelineB.vertex.module).toBe(pipelineA.vertex.module);
        expect(pipelineB.fragment!.module).toBe(pipelineA.fragment!.module);
    });

    it("evicts the geometry modules of retired PBR plugin variants while the live variant stays shared", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        let marker = 0;
        const plugin: MaterialPlugin = {
            name: "edited",
            getCustomCode: (shaderType) => (shaderType === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: `if(material.materialAlpha < -${marker}.0){discard;}` } : null),
        };
        const material = createPbrMaterial({ plugins: [plugin] });
        const mesh = makeMesh(material);
        scene._groups.set(material._buildGroup, [mesh]);
        enableMaterialPlugins(scene);
        await buildPbrRenderables(scene, [mesh], undefined);
        /** Edit the plugin code (a new variant) and bind the next generation; the caller retires the previous one. */
        const bindEdit = (next: number): [GPURenderPipelineDescriptor, () => void] => {
            marker = next;
            material._renderFeatures = _computePbrMaterialFeatures(material);
            return bindPbrGeometry(engine, scene, mesh);
        };

        let [live, releaseLive] = bindPbrGeometry(engine, scene, mesh);
        const retiredFragments = [live.fragment!.module];
        for (let edit = 1; edit <= 3; edit++) {
            const calls = createShaderModule.mock.calls.length;
            const [next, releaseNext] = bindEdit(edit);
            // Only the edited fragment stage compiles; the vertex stage is shared with the generation it replaces.
            expect(createShaderModule.mock.calls.length - calls).toBe(1);
            expect(next.vertex.module).toBe(live.vertex.module);
            releaseLive();
            [live, releaseLive] = [next, releaseNext];
            retiredFragments.push(live.fragment!.module);
        }
        retiredFragments.pop();

        // The live variant is still shared by a later generation...
        let calls = createShaderModule.mock.calls.length;
        const [again, releaseAgain] = bindEdit(3);
        expect(createShaderModule.mock.calls.length - calls).toBe(0);
        expect(again.fragment!.module).toBe(live.fragment!.module);
        releaseLive();
        // ...while no retired variant stayed cached: editing the code back compiles its fragment stage again.
        for (let edit = 0; edit < retiredFragments.length; edit++) {
            calls = createShaderModule.mock.calls.length;
            const [restored, releaseRestored] = bindEdit(edit);
            expect(createShaderModule.mock.calls.length - calls).toBe(1);
            expect(restored.fragment!.module).not.toBe(retiredFragments[edit]);
            expect(restored.vertex.module).toBe(again.vertex.module);
            releaseRestored();
        }
        releaseAgain();
    });

    it("releases shared PBR geometry modules with their last holder", async () => {
        const { engine, createShaderModule } = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const materialA = createPbrMaterial();
        const meshA = makeMesh(materialA);
        const meshB = makeMesh(createPbrMaterial());
        scene._groups.set(materialA._buildGroup, [meshA, meshB]);
        await buildPbrRenderables(scene, [meshA, meshB], undefined);

        let calls = createShaderModule.mock.calls.length;
        const [pipelineA, releaseA] = bindPbrGeometry(engine, scene, meshA);
        const [pipelineB, releaseB] = bindPbrGeometry(engine, scene, meshB);
        expect(createShaderModule.mock.calls.length - calls).toBe(2);

        // A disposed holder leaves the pair to the material that still draws with it.
        releaseA();
        calls = createShaderModule.mock.calls.length;
        const [pipelineC, releaseC] = bindPbrGeometry(engine, scene, meshA);
        expect(createShaderModule.mock.calls.length - calls).toBe(0);
        expect(pipelineC.vertex.module).toBe(pipelineB.vertex.module);
        expect(pipelineC.fragment!.module).toBe(pipelineB.fragment!.module);

        // Once every holder is disposed, nothing keeps the pair: the next geometry pass compiles it again.
        releaseB();
        releaseC();
        calls = createShaderModule.mock.calls.length;
        const [pipelineD, releaseD] = bindPbrGeometry(engine, scene, meshA);
        expect(createShaderModule.mock.calls.length - calls).toBe(2);
        expect(pipelineD.vertex.module).not.toBe(pipelineA.vertex.module);
        expect(pipelineD.fragment!.module).not.toBe(pipelineA.fragment!.module);
        releaseD();
    });
});
