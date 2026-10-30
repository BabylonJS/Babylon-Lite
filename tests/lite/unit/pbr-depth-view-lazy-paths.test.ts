import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MaterialView } from "../../../packages/babylon-lite/src/material/material";
import { createPbrEsmShadowMaterialView } from "../../../packages/babylon-lite/src/material/pbr/esm-shadow-view";
import { createPbrNoColorMaterialView } from "../../../packages/babylon-lite/src/material/pbr/no-color-view";
import { PBR_HAS_ALPHA_TEST, PBR_HAS_NORMAL_MAP, PBR_HAS_SPEC_GLOSS, PBR2_HAS_REFRACTION } from "../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits";
import { _computePbrMaterialFeatures, createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { clearPbrPipelineCache } from "../../../packages/babylon-lite/src/material/pbr/pbr-pipeline";
import { setPbrAlphaCutoff } from "../../../packages/babylon-lite/src/material/pbr/set-alpha-cutoff";
import { setPbrTransmission } from "../../../packages/babylon-lite/src/material/pbr/set-transmission";
import { buildPbrGeometryRenderable } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-renderable";
import { createPbrGeometryMaterialView } from "../../../packages/babylon-lite/src/material/pbr/pbr-geometry-view";
import { GeometryTextureType } from "../../../packages/babylon-lite/src/frame-graph/geometry-types";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { buildPbrRenderables } from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { clearSceneBGLCache } from "../../../packages/babylon-lite/src/render/scene-helpers";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";

/**
 * A PBR group build loads the normal-map and spec-gloss WGSL only when one of its meshes needs it. The shadow tasks
 * build their casters' no-colour and ESM views through the group's closure, also while a material that gained such a
 * map after the build waits for the group rebuild. These tests run the REAL forward PBR group build (mocked device)
 * and check that such a view still gets a bind group matching the layout its shader declares.
 */
const texture = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler } as Texture2D;

function makeEngine(): { engine: EngineContext; createBindGroup: ReturnType<typeof vi.fn> } {
    const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup);
    const device = {
        // The layout is its own descriptor, so a bind group can be checked against it.
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        createBindGroup,
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => descriptor as unknown as GPUSampler),
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({}) as GPUTextureView), destroy: vi.fn() }) as unknown as GPUTexture),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const storage = new ArrayBuffer(Number(descriptor.size));
            return { destroy: vi.fn(), getMappedRange: vi.fn(() => storage), unmap: vi.fn() } as unknown as GPUBuffer;
        }),
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    } as unknown as GPUDevice;
    const engine = { _device: device, _disposables: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, createBindGroup };
}

function makeMesh(material: PbrMaterialProps, hasTangents: boolean): Mesh {
    const worldMatrix = new Float32Array(16);
    worldMatrix[0] = worldMatrix[5] = worldMatrix[10] = worldMatrix[15] = 1;
    return {
        material,
        receiveShadows: false,
        morphTargets: null,
        worldMatrix,
        worldMatrixVersion: 1,
        _gpu: hasTangents ? { tangentBuffer: {} } : {},
    } as unknown as Mesh;
}

/** A plain PBR material's group, built and committed with its closure, as the scene build leaves it. */
async function builtGroup(hasTangents: boolean) {
    const { engine, createBindGroup } = makeEngine();
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const material = createPbrMaterial();
    const mesh = makeMesh(material, hasTangents);
    scene._groups.set(material._buildGroup, [mesh]);
    const result = await buildPbrRenderables(scene, [mesh], undefined);
    return { scene, material, mesh, rebuild: result.rebuildSingle, createBindGroup };
}

/** What a map assignment leaves before the group rebuild commits: features recomputed (after `rebuildMaterial` drops
 *  them, the geometry pass or the transmission setup recomputes them), the group's closure still the one built without
 *  the map. */
function gainMap(material: PbrMaterialProps, map: "normalTexture" | "specGlossTexture"): void {
    material[map] = texture;
    material._renderFeatures = _computePbrMaterialFeatures(material);
}

/** Bind groups created by one rebuild, each with the binding numbers it supplies and the ones its layout declares. */
function bindingsOf(
    scene: SceneContext,
    rebuild: Awaited<ReturnType<typeof buildPbrRenderables>>["rebuildSingle"],
    mesh: Mesh,
    view: MaterialView,
    createBindGroup: ReturnType<typeof vi.fn>
): { supplied: number[]; declared: number[] }[] {
    createBindGroup.mockClear();
    rebuild(scene, mesh, view);
    return createBindGroup.mock.calls.map((call) => {
        const descriptor = call[0] as GPUBindGroupDescriptor;
        return {
            supplied: [...descriptor.entries].map((entry) => entry.binding),
            declared: [...(descriptor.layout as unknown as GPUBindGroupLayoutDescriptor).entries].map((entry) => entry.binding),
        };
    });
}

describe("PBR depth views of a material that gained a shading map after its group build", () => {
    beforeEach(() => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
    });

    it.each([
        ["a normal map, mesh with tangents", "normalTexture", true],
        ["a normal map, mesh without tangents", "normalTexture", false],
        ["a spec-gloss map", "specGlossTexture", true],
    ] as const)("builds a no-colour view whose bind group matches its layout: %s", async (_name, map, hasTangents) => {
        const { scene, material, mesh, rebuild, createBindGroup } = await builtGroup(hasTangents);
        gainMap(material, map);

        const groups = bindingsOf(scene, rebuild, mesh, createPbrNoColorMaterialView(material), createBindGroup);

        expect(groups.length).toBeGreaterThan(0);
        for (const { supplied, declared } of groups) {
            expect(supplied).toEqual(declared);
        }
    });

    it("builds an ESM view whose bind group matches its layout", async () => {
        const { scene, material, mesh, rebuild, createBindGroup } = await builtGroup(true);
        gainMap(material, "normalTexture");

        const groups = bindingsOf(scene, rebuild, mesh, createPbrEsmShadowMaterialView(material, {} as GPUBuffer), createBindGroup);

        expect(groups.length).toBeGreaterThan(0);
        for (const { supplied, declared } of groups) {
            expect(supplied).toEqual(declared);
        }
    });

    it("keeps the features a depth pass reads, and drops the shading-only ones", () => {
        const material = createPbrMaterial({ normalTexture: texture, specGlossTexture: texture });
        setPbrAlphaCutoff(material, 0.5);
        material._renderFeatures = _computePbrMaterialFeatures(material);
        const source = material._renderFeatures.features;
        expect(source & (PBR_HAS_NORMAL_MAP | PBR_HAS_SPEC_GLOSS | PBR_HAS_ALPHA_TEST)).toBe(PBR_HAS_NORMAL_MAP | PBR_HAS_SPEC_GLOSS | PBR_HAS_ALPHA_TEST);

        for (const view of [createPbrNoColorMaterialView(material), createPbrEsmShadowMaterialView(material, {} as GPUBuffer)]) {
            const features = view._renderFeatures!.features;
            expect(features & (PBR_HAS_NORMAL_MAP | PBR_HAS_SPEC_GLOSS)).toBe(0);
            expect(features & PBR_HAS_ALPHA_TEST).toBe(PBR_HAS_ALPHA_TEST);
        }
    });
});

/** Refraction composes after the IBL fragment, so a transmissive forward build needs an environment. */
const environment = {
    specularCube: {} as GPUTexture,
    specularCubeView: {} as GPUTextureView,
    brdfLut: {} as GPUTexture,
    brdfLutView: {} as GPUTextureView,
    cubeSampler: {} as GPUSampler,
    brdfSampler: {} as GPUSampler,
    irradianceSH: new Float32Array(27),
    sphericalHarmonics: new Float32Array(36),
    lodGenerationScale: 0.8,
} as EnvironmentTextures;

/** A transmissive material's forward group, built as the scene build leaves it: the refraction extension registered
 *  and the material's features carrying `PBR2_HAS_REFRACTION`. */
async function builtTransmissiveGroup() {
    const { engine, createBindGroup } = makeEngine();
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    const material = createPbrMaterial();
    setPbrTransmission(material, { intensity: 1, indexOfRefraction: 1.5 });
    const mesh = makeMesh(material, true);
    scene._groups.set(material._buildGroup, [mesh]);
    const result = await buildPbrRenderables(scene, [mesh], environment);
    return { engine, scene, material, mesh, rebuild: result.rebuildSingle, createBindGroup };
}

/**
 * Only the main colour pass grabs the scene colour that refraction samples. A shadow or geometry task offers no
 * refraction texture, so a view that kept `PBR2_HAS_REFRACTION` deferred its bind group to the draw, which then threw
 * "PBR transmission requires a frame-graph refraction texture" on every record, for as long as the mesh was there.
 */
describe("PBR depth and geometry views of a transmissive material", () => {
    beforeEach(() => {
        clearPbrPipelineCache();
        clearSceneBGLCache();
    });

    it.each([
        ["no-colour", (material: PbrMaterialProps): MaterialView => createPbrNoColorMaterialView(material)],
        ["ESM", (material: PbrMaterialProps): MaterialView => createPbrEsmShadowMaterialView(material, {} as GPUBuffer)],
    ] as const)("builds the %s view with its bind group up front, matching its layout", async (_name, makeView) => {
        const { scene, material, mesh, rebuild, createBindGroup } = await builtTransmissiveGroup();
        expect((material._renderFeatures?.features2 ?? 0) & PBR2_HAS_REFRACTION).toBe(PBR2_HAS_REFRACTION);

        const view = makeView(material);
        expect((view._renderFeatures?.features2 ?? 0) & PBR2_HAS_REFRACTION).toBe(0);
        const groups = bindingsOf(scene, rebuild, mesh, view, createBindGroup);

        expect(groups.length).toBeGreaterThan(0);
        for (const { supplied, declared } of groups) {
            expect(supplied).toEqual(declared);
        }
    });

    it("binds the geometry view without a refraction texture", async () => {
        const { engine, scene, material, mesh } = await builtTransmissiveGroup();
        const view = createPbrGeometryMaterialView(material, { attachments: [GeometryTextureType.WORLD_NORMAL], emitColor: false });
        expect((view._renderFeatures?.features2 ?? 0) & PBR2_HAS_REFRACTION).toBe(0);

        const signature = { _colorFormat: "rgba8unorm", _depthStencilFormat: "depth24plus", _sampleCount: 1 } as RenderTargetSignature;
        const owner = { _lifetimeDisposers: [] as (() => void)[] };
        expect(() => buildPbrGeometryRenderable(scene, mesh, view, owner).bind(engine, signature)).not.toThrow();
    });
});
