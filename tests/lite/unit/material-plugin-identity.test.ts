import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import { enableMaterialPlugins } from "../../../packages/babylon-lite/src/material/plugin/enable-material-plugins";
import type { MaterialPlugin } from "../../../packages/babylon-lite/src/material/plugin/material-plugin";
import { bakeStdPluginMaterial } from "../../../packages/babylon-lite/src/material/plugin/std-plugin-bridge";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { createStandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view";
import { buildStandardGeometryRenderable } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable";
import { _registerStdExt, HAS_SKELETON, HAS_SKELETON_8, NO_COLOR_OUTPUT, VERTEX_ALPHA } from "../../../packages/babylon-lite/src/material/standard/standard-flags";
import { _installStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline";
import { stdSkeletonExt } from "../../../packages/babylon-lite/src/material/standard/fragments/std-skeleton-fragment";
import { createStdVertexColorFragment } from "../../../packages/babylon-lite/src/material/standard/fragments/std-vertex-color-fragment";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { addToScene, createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";

function makeEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const bytes = new ArrayBuffer(Number(descriptor.size));
            return { destroy: vi.fn(), getMappedRange: () => bytes, unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => {
            const layout = descriptor.layout as unknown as GPUBindGroupLayoutDescriptor;
            expect(Array.from(descriptor.entries).map((entry) => entry.binding)).toEqual(Array.from(layout.entries).map((entry) => entry.binding));
            return descriptor as unknown as GPUBindGroup;
        },
        createPipelineLayout: (descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout,
        createShaderModule: (descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule,
        createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline,
        createSampler: (descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler,
        createTexture: () => ({ createView: () => ({}), destroy: vi.fn() }) as unknown as GPUTexture,
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [], format: "rgba8unorm" } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return engine;
}

function makeMesh(material: Mesh["material"]): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return { material, worldMatrix, worldMatrixVersion: 1, receiveShadows: false, morphTargets: null, _gpu: {} } as unknown as Mesh;
}

function plugin(name: string): MaterialPlugin {
    return {
        name,
        getUniforms: () => ({ ubo: [{ name, type: "f32" }] }),
        getCustomCode: (stage) => (stage === "fragment" ? { CUSTOM_FRAGMENT_UPDATE_ALPHA: `if (0.0 < -1.0) { discard; } // ${name}` } : null),
    };
}

const signature: RenderTargetSignature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 };

function shaders(pipeline: GPURenderPipeline): { vertex: string; fragment: string } {
    const descriptor = pipeline as unknown as GPURenderPipelineDescriptor;
    return {
        vertex: (descriptor.vertex.module as unknown as GPUShaderModuleDescriptor).code,
        fragment: (descriptor.fragment!.module as unknown as GPUShaderModuleDescriptor).code,
    };
}

describe("Standard plugin identity", () => {
    it("keeps a geometry-view UBO alive through a main-material swap and releases it with the view packet", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createStandardMaterial();
        material.plugins = [plugin("geometryOwner")];
        const mesh = makeMesh(material);
        addToScene(scene, mesh);
        enableMaterialPlugins(scene);
        buildStandardMeshRenderables(scene, [mesh], {});
        const createBuffer = vi.mocked(engine._device.createBuffer);
        const index = createBuffer.mock.calls.findIndex(([descriptor]) => descriptor.label === "plugin-ubo");
        const ubo = createBuffer.mock.results[index]!.value as GPUBuffer;
        const view = createStandardGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: false });
        const renderable = buildStandardGeometryRenderable(scene, mesh, view);
        mesh.material = createStandardMaterial();
        scene._meshDisposables.get(mesh)!.forEach((dispose) => dispose());
        expect(ubo.destroy).not.toHaveBeenCalled();
        renderable._geometryDispose!();
        expect(ubo.destroy).toHaveBeenCalledOnce();
        renderable._geometryDispose!();
        expect(ubo.destroy).toHaveBeenCalledOnce();
    });

    it("keeps more than 127 signatures separate from native feature bits and pipeline caches", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const materials = Array.from({ length: 140 }, (_, index) => {
            const material = createStandardMaterial();
            material.plugins = [plugin(`standard${index}`)];
            return material;
        });
        const meshes = materials.map(makeMesh);
        scene.meshes.push(...meshes);
        enableMaterialPlugins(scene);
        _registerStdExt(stdSkeletonExt);
        const result = buildStandardMeshRenderables(scene, meshes, {});
        const pipelines = result.renderables.map((renderable) => renderable.bind(engine, signature).pipeline);
        expect(new Set(materials.map((material) => material._pi)).size).toBe(140);
        expect(new Set(pipelines).size).toBe(140);
        for (let index = 0; index < materials.length; index++) {
            const material = materials[index]!;
            expect(material._renderFeatures!.features & (VERTEX_ALPHA | HAS_SKELETON | HAS_SKELETON_8)).toBe(0);
            const code = shaders(pipelines[index]!);
            expect(code.fragment).toContain(`// standard${index}\n`);
            expect(code.vertex).not.toContain("boneSampler");
        }
        const same = result.rebuildSingle(scene, meshes[0]!).bind(engine, signature).pipeline;
        expect(same).toBe(pipelines[0]);
    });

    it.each([false, true])("composes the correct plugin with vertex alpha and eight-bone skinning=%s", (eightBones) => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createStandardMaterial();
        material.plugins = [plugin(eightBones ? "skinnedEight" : "skinnedFour")];
        const mesh = makeMesh(material);
        mesh._gpu = { ...mesh._gpu, colorBuffer: {} as GPUBuffer };
        mesh.hasVertexAlpha = true;
        mesh.skeleton = {
            boneTexture: { createView: () => ({}) },
            jointsBuffer: {},
            weightsBuffer: {},
            joints1Buffer: eightBones ? {} : null,
            weights1Buffer: eightBones ? {} : null,
        } as unknown as Mesh["skeleton"];
        scene.meshes.push(mesh);
        enableMaterialPlugins(scene);
        _registerStdExt(stdSkeletonExt);
        _installStdVertexColorFragment(createStdVertexColorFragment);
        const result = buildStandardMeshRenderables(scene, [mesh], {});
        const normal = shaders(result.renderables[0]!.bind(engine, signature).pipeline);
        expect(normal.vertex).toContain("boneSampler");
        expect(normal.fragment).toContain(`// ${material.plugins[0]!.name}`);
        expect(result.renderables[0]!.isTransparent).toBe(true);
        const view = createMaterialView(material, { features: material._renderFeatures!.features | NO_COLOR_OUTPUT });
        expect(shaders(result.rebuildSingle(scene, mesh, view).bind(engine, signature).pipeline).fragment).toContain(`// ${material.plugins[0]!.name}`);
    });

    it("invalidates a geometry-view variant for plugin changes, removal, and re-enabling", () => {
        const engine = makeEngine();
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const material = createStandardMaterial();
        material.plugins = [plugin("geometryFirst")];
        const mesh = makeMesh(material);
        scene.meshes.push(mesh);
        enableMaterialPlugins(scene);
        buildStandardMeshRenderables(scene, [mesh], {});
        const view = createStandardGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: false });
        const first = buildStandardGeometryRenderable(scene, mesh, view).bind(engine, signature).pipeline;
        material.plugins = [plugin("geometrySecond")];
        bakeStdPluginMaterial(material, scene);
        const second = buildStandardGeometryRenderable(scene, mesh, view).bind(engine, signature).pipeline;
        expect(second).not.toBe(first);
        expect(shaders(first).fragment).toContain("// geometryFirst");
        expect(shaders(second).fragment).toContain("// geometrySecond");
        material.plugins = [];
        bakeStdPluginMaterial(material, scene);
        const absent = buildStandardGeometryRenderable(scene, mesh, view).bind(engine, signature).pipeline;
        expect(shaders(absent).fragment).not.toContain("pluginUbo");
        material.plugins = [plugin("geometryFirst")];
        bakeStdPluginMaterial(material, scene);
        expect(buildStandardGeometryRenderable(scene, mesh, view).bind(engine, signature).pipeline).toBe(first);
    });
});

describe("PBR plugin identity lifetime", () => {
    it.each([false, true])("preserves a live scene across second-scene registration (separate device=%s)", async (separateDevice) => {
        const engineA = makeEngine();
        const engineB = separateDevice ? makeEngine() : engineA;
        const sceneA = createSceneContext(engineA, { defaultRenderTask: false });
        const sceneB = createSceneContext(engineB, { defaultRenderTask: false });
        const materialA = createPbrMaterial({ plugins: [plugin("firstScene")] });
        const materialB = createPbrMaterial({ plugins: [plugin("secondScene")] });
        const meshA = makeMesh(materialA);
        const meshB = makeMesh(materialB);
        sceneA.meshes.push(meshA);
        sceneB.meshes.push(meshB);
        sceneA._groups.set(materialA._buildGroup, [meshA]);
        sceneB._groups.set(materialB._buildGroup, [meshB]);
        enableMaterialPlugins(sceneA);
        await buildPbrRenderables(sceneA, [meshA], undefined);
        const originalId = materialA._pi;
        enableMaterialPlugins(sceneB);
        await buildPbrRenderables(sceneB, [meshB], undefined);
        enableMaterialPlugins(sceneB);
        expect(materialA._pi).toBe(originalId);
        expect(materialB._pi).not.toBe(originalId);

        // Rebuild a fresh composer while the first material retains its cached features/identity.
        const rebuilt = await buildPbrRenderables(sceneA, [meshA], undefined);
        const mainCode = shaders(rebuilt.renderables[0]!.bind(engineA, signature).pipeline);
        expect(mainCode.fragment).toContain("// firstScene");
        expect(mainCode.fragment).not.toContain("// secondScene");
        const view = createPbrGeometryMaterialView(materialA, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: false });
        const geometryCode = shaders(buildPbrGeometryRenderable(sceneA, meshA, view).bind(engineA, signature).pipeline);
        expect(geometryCode.fragment).toContain("// firstScene");
        expect(geometryCode.fragment).not.toContain("// secondScene");

        Object.assign(engineA, { _device: makeEngine()._device });
        const recovered = await buildPbrRenderables(sceneA, [meshA], undefined);
        expect(materialA._pi).toBe(originalId);
        expect(shaders(recovered.renderables[0]!.bind(engineA, signature).pipeline).fragment).toContain("// firstScene");
    });
});
