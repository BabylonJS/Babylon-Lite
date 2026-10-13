import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { Material } from "../../../packages/babylon-lite/src/material/material.js";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { createRectAreaLight } from "../../../packages/babylon-lite/src/light/rect-area-light.js";
import { createPointLight } from "../../../packages/babylon-lite/src/light/point-light.js";
import { enableRectAreaLights } from "../../../packages/babylon-lite/src/light/enable-rect-area-lights.js";
import { MAX_LIGHTS } from "../../../packages/babylon-lite/src/light/types.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { buildStandardMeshRenderables } from "../../../packages/babylon-lite/src/material/standard/standard-renderable.js";
import { createStandardGeometryMaterialView } from "../../../packages/babylon-lite/src/material/standard/geometry-view.js";
import { buildStandardGeometryRenderable } from "../../../packages/babylon-lite/src/material/standard/standard-geometry-renderable.js";
import { rectAreaStandardContext } from "../../../packages/babylon-lite/src/material/standard/fragments/rect-area-light-fragment.js";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";
import { setPbrClearCoat } from "../../../packages/babylon-lite/src/material/pbr/set-clearcoat.js";
import { rectAreaPbrFeatures, RECT_AREA_PBR_SCENE, RECT_AREA_PBR_SELECTED } from "../../../packages/babylon-lite/src/material/pbr/fragments/rect-area-light-fragment.js";
import { enableMaterialTracking } from "../../../packages/babylon-lite/src/material/observable-material.js";
import { writeStdMaterialData } from "../../../packages/babylon-lite/src/material/standard/standard-pipeline.js";

function fixture() {
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({ label: descriptor.label, createView: vi.fn(() => ({ label: descriptor.label })), destroy: vi.fn() })),
        createSampler: vi.fn(() => ({})),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const data = new ArrayBuffer(Number(descriptor.size));
            return { destroy: vi.fn(), getMappedRange: vi.fn(() => data), unmap: vi.fn() };
        }),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    };
    const engine = { _device: device, _disposables: [], format: "rgba8unorm", msaaSamples: 1 } as unknown as EngineContext;
    Object.assign(engine, { engine });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    return { engine, scene, device };
}

function mesh(material: Material, id: string): Mesh {
    return Object.assign(createTransformNode(id), { id, material, receiveShadows: false, morphTargets: null, _gpu: {} }) as Mesh;
}

function mockLtc(): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(new ArrayBuffer(65536)))
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("area lighting auxiliary passes, selection and material tracking", () => {
    it.each([false, true])("actual Standard geometry builder retains matching area helper/texture bindings (emitColor=%s)", async (emitColor) => {
        mockLtc();
        const { scene, device } = fixture();
        scene.lights.push(createRectAreaLight([0, 1, 2], 2, 3));
        await enableRectAreaLights(scene);
        const material = createStandardMaterial();
        const receiver = mesh(material, "receiver");
        buildStandardMeshRenderables(scene, [receiver], { sceneShader: rectAreaStandardContext(null) });
        const view = createStandardGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor });
        device.createShaderModule.mockClear();
        device.createBindGroup.mockClear();
        const resources = { _lifetimeDisposers: [] as (() => void)[] };
        buildStandardGeometryRenderable(scene, receiver, view, resources);
        const fragment = device.createShaderModule.mock.calls.map(([descriptor]) => descriptor.code).find((code) => code.includes("@fragment"));
        expect(fragment).toContain("evaluateAreaLtc(N,viewDir,P,L,mat._0)");
        expect(fragment).toContain("fn evaluateAreaLtc");
        expect(fragment).toContain("var areaLtc1:texture_2d<f32>");
        expect(fragment).toContain("var areaLtc2Sampler:sampler");
        expect(device.createBindGroup.mock.calls.at(-1)![0].entries).toHaveLength(6);
        const resourcesBound = Array.from(device.createBindGroup.mock.calls.at(-1)![0].entries).map((entry) => entry.resource);
        expect(resourcesBound).toContainEqual({ label: "rect-area-ltc1" });
        expect(resourcesBound).toContainEqual({ label: "rect-area-ltc2" });
        resources._lifetimeDisposers.forEach((dispose) => dispose());
        scene._disposables.forEach((dispose) => dispose());
    });

    it.each(["excluded", "included-only", "no-area"] as const)("actual PBR forward builder accepts clearcoat punctual-only receivers (%s)", async (filter) => {
        mockLtc();
        const { scene } = fixture();
        const area = createRectAreaLight([0, 1, 2], 2, 3);
        if (filter === "excluded") {
            area.excludedMeshIds = new Set(["receiver"]);
        } else if (filter === "included-only") {
            area.includedOnlyMeshIds = new Set(["other"]);
        }
        if (filter !== "no-area") {
            scene.lights.push(area);
        }
        scene.lights.push(createPointLight([0, 2, 1]));
        await enableRectAreaLights(scene);
        const material = createPbrMaterial();
        setPbrClearCoat(material, { isEnabled: true, intensity: 1, roughness: 0.2 });
        const receiver = mesh(material, "receiver");
        scene._groups.set(material._buildGroup, [receiver]);
        expect(rectAreaPbrFeatures(scene.lights, receiver.id)).toBe(RECT_AREA_PBR_SCENE);
        await expect(buildPbrRenderables(scene, [receiver], undefined)).resolves.toMatchObject({ renderables: expect.any(Array) });
        scene._disposables.forEach((dispose) => dispose());
    });

    it("actual PBR builder rejects a layered material only when its selected lights contain an area emitter", async () => {
        mockLtc();
        const { scene } = fixture();
        const area = createRectAreaLight([0, 1, 2], 2, 3);
        area.includedOnlyMeshIds = new Set(["receiver"]);
        scene.lights.push(area, createPointLight([0, 2, 1]));
        await enableRectAreaLights(scene);
        const material = createPbrMaterial();
        setPbrClearCoat(material, { isEnabled: true, intensity: 1 });
        const receiver = mesh(material, "receiver");
        scene._groups.set(material._buildGroup, [receiver]);
        expect(rectAreaPbrFeatures(scene.lights, receiver.id)).toBe(RECT_AREA_PBR_SCENE | RECT_AREA_PBR_SELECTED);
        await expect(buildPbrRenderables(scene, [receiver], undefined)).rejects.toThrow(/layered PBR/);
        scene._disposables.forEach((dispose) => dispose());
    });

    it("selection-aware policy follows the packed-light cap and writer omissions", () => {
        const area = createRectAreaLight([0, 1, 2], 2, 3);
        const points = Array.from({ length: MAX_LIGHTS }, () => createPointLight([0, 0, 0]));
        const writerless = createRectAreaLight([0, 0, 0], 2, 3);
        Object.defineProperty(writerless, "_writeLightUbo", { value: undefined });
        expect(rectAreaPbrFeatures([...points, area], "receiver")).toBe(RECT_AREA_PBR_SCENE);
        expect(rectAreaPbrFeatures([...points.slice(1), area], "receiver")).toBe(RECT_AREA_PBR_SCENE | RECT_AREA_PBR_SELECTED);
        expect(rectAreaPbrFeatures([...points.slice(1), writerless, area], "receiver")).toBe(RECT_AREA_PBR_SCENE | RECT_AREA_PBR_SELECTED);
        area.includedOnlyMeshIds = new Set(["receiver"]);
        expect(rectAreaPbrFeatures([area], undefined)).toBe(RECT_AREA_PBR_SCENE);
    });

    it("keeps selected-area rejection in the cache key for meshes sharing one layered material and multi-light mode", async () => {
        mockLtc();
        const { scene } = fixture();
        const area = createRectAreaLight([0, 1, 2], 2, 3);
        area.includedOnlyMeshIds = new Set(["area-receiver"]);
        scene.lights.push(area, createPointLight([0, 2, 1]), createPointLight([1, 2, 1]));
        await enableRectAreaLights(scene);
        const material = createPbrMaterial();
        setPbrClearCoat(material, { isEnabled: true, intensity: 1 });
        const punctual = mesh(material, "punctual-receiver");
        const areaReceiver = mesh(material, "area-receiver");
        scene._groups.set(material._buildGroup, [punctual, areaReceiver]);
        await expect(buildPbrRenderables(scene, [punctual, areaReceiver], undefined)).rejects.toThrow(/layered PBR/);
        for (const disposers of scene._meshDisposables.values()) {
            disposers.forEach((dispose) => dispose());
        }
        scene._disposables.forEach((dispose) => dispose());
    });

    it("public enableMaterialTracking tracks initially undefined Standard roughness and writes the new LTC UBO value", async () => {
        mockLtc();
        const { scene } = fixture();
        await enableRectAreaLights(scene);
        const material = createStandardMaterial();
        expect(material.roughness).toBeUndefined();
        await enableMaterialTracking(material);
        const version = material._uboVersion;
        material.roughness = 0.7;
        expect(material._uboVersion).toBe(version + 1);
        const data = new Float32Array(24);
        writeStdMaterialData(data, material, 1);
        expect(data[22]).toBeCloseTo(0.7);
        material.roughness = 0.7;
        expect(material._uboVersion).toBe(version + 1);
        material.roughness = undefined;
        expect(material._uboVersion).toBe(version + 2);
        writeStdMaterialData(data, material, 1);
        expect(data[22]).toBe(0);
        scene._disposables.forEach((dispose) => dispose());
    });
});
