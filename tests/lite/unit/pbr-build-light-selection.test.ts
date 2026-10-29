import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { Material } from "../../../packages/babylon-lite/src/material/material.js";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { createPointLight } from "../../../packages/babylon-lite/src/light/point-light.js";
import { createSpotLight } from "../../../packages/babylon-lite/src/light/spot-light.js";
import { COMPUTE_PBR_LIGHT, MULTI_LIGHT_STRUCTS, getMultiLightLoop } from "../../../packages/babylon-lite/src/material/pbr/fragments/multilight-wgsl.js";
import type { SceneLightingExtension } from "../../../packages/babylon-lite/src/light/lighting-extension.js";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";
import { _registerPbrSceneHook } from "../../../packages/babylon-lite/src/material/pbr/pbr-flags.js";
import type { PbrLightMode } from "../../../packages/babylon-lite/src/material/pbr/pbr-compose.js";
import type { MeshGroupBuildResult } from "../../../packages/babylon-lite/src/render/renderable.js";

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

/**
 * The WGSL the build actually composed for its first renderable. `_gen` carries the composer plus the
 * feature bits, light mode and single-light type the renderable was stamped with, and the composer
 * caches by exactly those, so recomposing returns the shader the build produced rather than a new one.
 */
function composedFragment(result: MeshGroupBuildResult): string {
    type Compose = (...args: [number, number, number, number, PbrLightMode, string]) => { _fragmentWGSL: string };
    type Gen = [{ _composePbr: Compose }, number, PbrLightMode, string, { features: number; features2?: number }];
    const [context, sceneFeatures, lightMode, singleLightType, renderFeatures] = (result.renderables[0] as unknown as { _gen: Gen })._gen;
    return context._composePbr(renderFeatures.features, renderFeatures.features2 ?? 0, 0, sceneFeatures, lightMode, singleLightType)._fragmentWGSL;
}

/** A seam that runs inside the build, between the first light scan and the composition. */
let editDuringBuild: (() => void) | null = null;
_registerPbrSceneHook(async () => {
    editDuringBuild?.();
});

describe("PBR build light selection", () => {
    it("loads the light block for the mode it composes when a mesh list is edited mid-build", async () => {
        const { scene } = fixture();
        const near = createPointLight([0, 2, 0]);
        const far = createPointLight([2, 0, 0]);
        scene.lights.push(near, far);
        const material = createPbrMaterial();
        const receiver = mesh(material, "receiver");
        scene._groups.set(material._buildGroup, [receiver]);
        // Two affected lights when the build picks its WGSL, so only the multi-light block is loaded.
        // The edit then drops the mesh to one light, which is the mode the renderable composes with.
        editDuringBuild = () => {
            far.excludedMeshes = new Set([receiver]);
        };
        let res: MeshGroupBuildResult;
        try {
            res = await buildPbrRenderables(scene, [receiver], undefined);
        } finally {
            editDuringBuild = null;
        }
        expect(composedFragment(res)).toContain("lights.lights[mli(0u)]");
        scene._disposables.forEach((dispose) => dispose());
    });

    it("composes the multi-light block when an edit adds a light to the mesh mid-build", async () => {
        const { scene } = fixture();
        const near = createPointLight([0, 2, 0]);
        const far = createPointLight([2, 0, 0]);
        far.excludedMeshIds = new Set(["receiver"]);
        scene.lights.push(near, far);
        const material = createPbrMaterial();
        const receiver = mesh(material, "receiver");
        scene._groups.set(material._buildGroup, [receiver]);
        // One affected light at the first scan, two by the time the renderable is composed.
        editDuringBuild = () => {
            far.excludedMeshIds = undefined;
        };
        let res: MeshGroupBuildResult;
        try {
            res = await buildPbrRenderables(scene, [receiver], undefined);
        } finally {
            editDuringBuild = null;
        }
        expect(composedFragment(res)).toContain("fn computePbrLight(");
        scene._disposables.forEach((dispose) => dispose());
    });

    it("loads a light block selected by an edit that lands inside the dependency loading itself", async () => {
        const { scene } = fixture();
        const near = createPointLight([0, 2, 0]);
        const side = createSpotLight([2, 0, 0], [-1, 0, 0], Math.PI / 4, 2);
        scene.lights.push(near, side);
        const material = createPbrMaterial();
        const receiver = mesh(material, "receiver");
        scene._groups.set(material._buildGroup, [receiver]);
        side.excludedMeshes = new Set([receiver]);
        // The multi-light contribution is requested from inside the loader, so editing a list here lands
        // in the window the scan before the loader cannot see. It moves the mesh onto the spot light
        // alone, a single-light type this build has had no reason to fetch.
        const lighting: SceneLightingExtension = {
            _prepare: async () => {},
            _multi: () => {
                near.excludedMeshes = new Set([receiver]);
                side.excludedMeshes = undefined;
                return { _helpers: MULTI_LIGHT_STRUCTS() + COMPUTE_PBR_LIGHT, _loop: getMultiLightLoop() };
            },
        };
        scene._lighting = lighting;
        // Both lights affected by the time of the last scan, so that scan is what first asks for multi.
        editDuringBuild = () => {
            side.excludedMeshes = undefined;
        };
        let res: MeshGroupBuildResult;
        try {
            res = await buildPbrRenderables(scene, [receiver], undefined);
        } finally {
            editDuringBuild = null;
        }
        expect(composedFragment(res)).toContain("let spotC = dot(");
        scene._disposables.forEach((dispose) => dispose());
    });
});
