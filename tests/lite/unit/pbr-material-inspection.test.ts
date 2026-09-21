import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pbrMaterialInspectionDescriptor } from "../../../packages/babylon-lite/src/inspection/pbr-material-inspection";
import {
    inspectMaterialWithFamily,
    setMaterialInspectionPropertyWithFamily,
    setMaterialInspectionTextureWithFamily,
} from "../../../packages/babylon-lite/src/inspection/material-inspection";
import type {
    MaterialInspectionMutationScope,
    MaterialInspectionPropertyId,
    MaterialInspectionPropertyValue,
    MaterialTextureBindingId,
} from "../../../packages/babylon-lite/src/inspection/inspection-types";
import { enableMaterialUvTransform } from "../../../packages/babylon-lite/src/material/enable-material-uv-transform";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { createPbrMaterial, type PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

const pbrApis = vi.hoisted(() => ({
    enableStencil: vi.fn(),
    enableLightmap: vi.fn(async () => {}),
    setLightmap: vi.fn(
        (
            material: {
                lightmapTexture?: unknown;
                lightmapLevel?: number;
                lightmapCoordIndex?: 0 | 1;
                useLightmapAsShadowmap?: boolean;
                gammaLightmap?: boolean;
                _uv2Mask?: number;
            },
            texture: unknown,
            options: { level: number; coordIndex: 0 | 1; useAsShadowmap: boolean; gamma: boolean }
        ) => {
            material.lightmapTexture = texture;
            material.lightmapLevel = options.level;
            material.lightmapCoordIndex = options.coordIndex;
            material.useLightmapAsShadowmap = options.useAsShadowmap;
            material.gammaLightmap = options.gamma;
            material._uv2Mask = options.coordIndex === 1 ? (material._uv2Mask ?? 0) | 64 : (material._uv2Mask ?? 0) & ~64;
        }
    ),
    setAlphaCutoff: vi.fn((material: { _alphaCutOff?: number }, value: number) => {
        material._alphaCutOff = value;
    }),
    setEmissive: vi.fn((material: { _emissiveColor?: [number, number, number] }, value: [number, number, number]) => {
        material._emissiveColor = value;
    }),
}));

vi.mock("../../../packages/babylon-lite/src/material/enable-material-stencil", () => ({
    enableMaterialStencil: pbrApis.enableStencil,
}));
vi.mock("../../../packages/babylon-lite/src/material/pbr/set-alpha-cutoff", () => ({
    setPbrAlphaCutoff: pbrApis.setAlphaCutoff,
}));
vi.mock("../../../packages/babylon-lite/src/material/pbr/set-emissive", () => ({
    setPbrEmissive: pbrApis.setEmissive,
}));
vi.mock("../../../packages/babylon-lite/src/material/pbr/enable-pbr-lightmap", () => ({
    enablePbrLightmap: pbrApis.enableLightmap,
    setPbrLightmap: pbrApis.setLightmap,
}));

const EXPECTED_PROPERTIES = [
    ["material.name", "general", "Name", "string", "A", "none"],
    ["pbr.doubleSided", "general", "Double Sided", "boolean", "R", "rebuild-material"],
    ["pbr.alphaBlend", "general", "Alpha Blend", "boolean", "R", "rebuild-material"],
    ["pbr.enableSpecularAA", "general", "Specular Anti-Aliasing", "boolean", "R", "rebuild-material"],
    ["pbr.alpha", "transparency", "Alpha", "number", "U/R", "rebuild-material"],
    ["pbr.alphaCutOff", "transparency", "Alpha Cutoff", "number", "U/R", "rebuild-material"],
    ["pbr.baseColorFactor", "lighting-colors", "Base Color Factor", "vec4", "U/R", "rebuild-material"],
    ["pbr.emissiveColor", "lighting-colors", "Emissive Color", "vec3", "U/R", "rebuild-material"],
    ["pbr.environmentIntensity", "lighting-colors", "Environment Intensity", "number", "U", "none"],
    ["pbr.directIntensity", "lighting-colors", "Direct Intensity", "number", "U", "none"],
    ["pbr.reflectance", "lighting-colors", "Reflectance", "number", "U", "none"],
    ["pbr.metallicFactor", "lighting-colors", "Metallic Factor", "number", "U", "none"],
    ["pbr.roughnessFactor", "lighting-colors", "Roughness Factor", "number", "U", "none"],
    ["pbr.normalTextureScale", "lighting-colors", "Normal Texture Scale", "number", "U", "none"],
    ["pbr.usePhysicalLightFalloff", "lighting-colors", "Use Physical Light Falloff", "boolean", "U", "none"],
    ["pbr.occlusionStrength", "occlusion", "Occlusion Strength", "number", "U/R", "rebuild-material"],
    ["pbr.occlusionTexCoord", "occlusion", "Occlusion Coordinates", "enum", "read-only", "none"],
    ["pbr.stencil.compare", "stencil", "Stencil Compare", "enum", "R", "rebuild-material"],
    ["pbr.stencil.passOp", "stencil", "Stencil Pass Operation", "enum", "R", "rebuild-material"],
    ["pbr.stencil.failOp", "stencil", "Stencil Fail Operation", "enum", "R", "rebuild-material"],
    ["pbr.stencil.depthFailOp", "stencil", "Stencil Depth Fail Operation", "enum", "R", "rebuild-material"],
    ["pbr.stencil.readMask", "stencil", "Stencil Read Mask", "number", "R", "rebuild-material"],
    ["pbr.stencil.writeMask", "stencil", "Stencil Write Mask", "number", "R", "rebuild-material"],
] as const;

const EXPECTED_BINDINGS = [
    ["pbr.baseColor", "Base Color Texture", "baseColorTexture"],
    ["pbr.normal", "Normal Texture", "normalTexture"],
    ["pbr.orm", "ORM Texture", "ormTexture"],
    ["pbr.occlusion", "Occlusion Texture", "occlusionTexture"],
    ["pbr.emissive", "Emissive Texture", "emissiveTexture"],
    ["pbr.specGloss", "Specular-Glossiness Texture", "specGlossTexture"],
] as const;

const OPTIONAL_PROPERTY_IDS = [
    "pbr.lightmapLevel",
    "pbr.lightmapCoordIndex",
    "pbr.useLightmapAsShadowmap",
    "pbr.gammaLightmap",
    "pbr.metallicReflectanceColor",
    "pbr.metallicF0Factor",
    "pbr.specularWeight",
    "pbr.useOnlyMetallicFromTexture",
    "pbr.clearCoat.enabled",
    "pbr.clearCoat.intensity",
    "pbr.clearCoat.roughness",
    "pbr.clearCoat.indexOfRefraction",
    "pbr.clearCoat.useF0Remap",
    "pbr.clearCoat.bumpTextureScale",
    "pbr.sheen.enabled",
    "pbr.sheen.color",
    "pbr.sheen.roughness",
    "pbr.sheen.intensity",
    "pbr.sheen.albedoScaling",
    "pbr.iridescence.enabled",
    "pbr.iridescence.intensity",
    "pbr.iridescence.indexOfRefraction",
    "pbr.iridescence.minimumThickness",
    "pbr.iridescence.maximumThickness",
    "pbr.anisotropy.enabled",
    "pbr.anisotropy.intensity",
    "pbr.anisotropy.direction",
    "pbr.translucency.intensity",
    "pbr.translucency.color",
    "pbr.translucency.diffusionDistance",
    "pbr.thickness.min",
    "pbr.thickness.max",
    "pbr.thickness.useGlTFChannel",
    "pbr.tint.color",
    "pbr.tint.atDistance",
    "pbr.transmission.intensity",
    "pbr.transmission.indexOfRefraction",
    "pbr.transmission.useThicknessAsDepth",
    "pbr.transmission.dispersion",
] as const;

const OPTIONAL_BINDING_IDS = [
    "pbr.lightmap",
    "pbr.metallicReflectance",
    "pbr.reflectance",
    "pbr.clearCoat",
    "pbr.clearCoatRoughness",
    "pbr.clearCoatBump",
    "pbr.sheen",
    "pbr.sheenRoughness",
    "pbr.iridescence",
    "pbr.iridescenceThickness",
    "pbr.anisotropy",
    "pbr.translucencyColor",
    "pbr.translucencyIntensity",
    "pbr.thickness",
    "pbr.transmission",
] as const;

beforeEach(() => {
    vi.clearAllMocks();
});

function inspect(material: PbrMaterialProps) {
    return inspectMaterialWithFamily(material, pbrMaterialInspectionDescriptor);
}

function propertyValues(material: PbrMaterialProps): Record<string, MaterialInspectionPropertyValue | "absent" | "unsupported"> {
    return Object.fromEntries(
        inspect(material).properties.map((property) => [
            property.id,
            property.value.state === "present" ? property.value.value : property.value.state === "absent" ? "absent" : "unsupported",
        ])
    );
}

function texture2d(seed: number): Texture2D {
    return {
        texture: { seed } as unknown as GPUTexture,
        view: { seed } as unknown as GPUTextureView,
        sampler: { seed } as unknown as GPUSampler,
        width: 16,
        height: 8,
    };
}

function cubeTexture(seed: number): object {
    return {
        _texture: { seed } as unknown as GPUTexture,
        _view: { seed } as unknown as GPUTextureView,
        _sampler: { seed } as unknown as GPUSampler,
    };
}

function createScene(materials: readonly Material[]): {
    readonly scene: SceneContext;
    readonly rebuild: ReturnType<typeof vi.fn>;
    readonly frameGraphBuild: ReturnType<typeof vi.fn>;
} {
    const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh) => ({ mesh, order: 0, isTransparent: false }) as Renderable);
    const frameGraphBuild = vi.fn();
    const currentBuilder = materials[0]?._buildGroup;
    if (currentBuilder?._materialFamily === "pbr") {
        const testBuilder = vi.fn();
        for (const material of materials) {
            (material as { _buildGroup: Material["_buildGroup"] })._buildGroup = testBuilder;
        }
    }
    const meshes = materials.map((material) => ({ material }) as Mesh);
    const scene = {
        surface: { engine: { _retirements: [] } },
        meshes,
        _groups: new Map(),
        _renderables: [],
        _meshDisposables: new Map(),
        _renderableVersion: 0,
        _materialEpoch: 0,
        _frameGraph: { build: frameGraphBuild },
    } as unknown as SceneContext;
    for (const material of materials) {
        if (!scene._groups.has(material._buildGroup)) {
            scene._groups.set(
                material._buildGroup,
                Object.assign(
                    meshes.filter((mesh) => mesh.material?._buildGroup === material._buildGroup),
                    { r: rebuild }
                )
            );
        }
    }
    return { scene, rebuild, frameGraphBuild };
}

async function setProperty(scope: MaterialInspectionMutationScope, material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue) {
    return setMaterialInspectionPropertyWithFamily(scope, material, id, value, pbrMaterialInspectionDescriptor);
}

async function setTexture(
    scope: MaterialInspectionMutationScope,
    material: PbrMaterialProps,
    id: MaterialTextureBindingId,
    mutation: { readonly direction: "assign" | "replace"; readonly texture: object } | { readonly direction: "clear" }
) {
    return setMaterialInspectionTextureWithFamily(scope, material, id, mutation, pbrMaterialInspectionDescriptor);
}

function createConfiguredOptionalMaterial(withTextures = true): PbrMaterialProps {
    const textures = Array.from({ length: OPTIONAL_BINDING_IDS.length }, (_, index) => texture2d(100 + index));
    return createPbrMaterial({
        lightmapTexture: textures[0],
        lightmapLevel: 0.5,
        lightmapCoordIndex: 1,
        useLightmapAsShadowmap: true,
        gammaLightmap: true,
        _uv2Mask: 64,
        _metallicReflectanceColor: [0.8, 0.7, 0.6],
        _metallicF0Factor: 0.9,
        _specularWeight: 0.75,
        _useOnlyMetallicFromMetallicReflectanceTexture: true,
        _metallicReflectanceTexture: withTextures ? textures[1] : undefined,
        _reflectanceTexture: withTextures ? textures[2] : undefined,
        _clearCoat: {
            isEnabled: true,
            intensity: 0.8,
            roughness: 0.2,
            indexOfRefraction: 1.4,
            useF0Remap: false,
            bumpTextureScale: 0.7,
            texture: withTextures ? textures[3] : undefined,
            roughnessTexture: withTextures ? textures[4] : undefined,
            bumpTexture: withTextures ? textures[5] : undefined,
        },
        _sheen: {
            isEnabled: true,
            color: [0.2, 0.3, 0.4],
            roughness: 0.35,
            intensity: 0.65,
            albedoScaling: true,
            texture: withTextures ? textures[6] : undefined,
            roughnessTexture: withTextures ? textures[7] : undefined,
        },
        _iridescence: {
            isEnabled: true,
            intensity: 0.6,
            indexOfRefraction: 1.25,
            minimumThickness: 120,
            maximumThickness: 360,
            texture: withTextures ? textures[8] : undefined,
            thicknessTexture: withTextures ? textures[9] : undefined,
        },
        _anisotropy: {
            isEnabled: true,
            intensity: 0.55,
            direction: [0.8, 0.2],
            texture: withTextures ? textures[10] : undefined,
        },
        _subsurface: {
            translucency: {
                intensity: 0.45,
                color: [0.9, 0.8, 0.7],
                diffusionDistance: [1, 2, 3],
                colorTexture: withTextures ? textures[11] : undefined,
                intensityTexture: withTextures ? textures[12] : undefined,
            },
            scattering: { diffusionDistance: [9, 8, 7], metersPerUnit: 2 },
            thickness: {
                min: 0.1,
                max: 0.9,
                useGlTFChannel: true,
                texture: withTextures ? textures[13] : undefined,
            },
            tint: { color: [0.6, 0.7, 0.8], atDistance: 4 },
            refraction: {
                intensity: 0.7,
                indexOfRefraction: 1.45,
                useThicknessAsDepth: true,
                dispersion: 0.2,
                texture: withTextures ? textures[14] : undefined,
            },
        },
        _transmissive: true,
    });
}

function readOptionalTexture(material: PbrMaterialProps, id: MaterialTextureBindingId): Texture2D | undefined {
    switch (id) {
        case "pbr.lightmap":
            return material.lightmapTexture;
        case "pbr.metallicReflectance":
            return material._metallicReflectanceTexture;
        case "pbr.reflectance":
            return material._reflectanceTexture;
        case "pbr.clearCoat":
            return material._clearCoat?.texture;
        case "pbr.clearCoatRoughness":
            return material._clearCoat?.roughnessTexture;
        case "pbr.clearCoatBump":
            return material._clearCoat?.bumpTexture;
        case "pbr.sheen":
            return material._sheen?.texture;
        case "pbr.sheenRoughness":
            return material._sheen?.roughnessTexture;
        case "pbr.iridescence":
            return material._iridescence?.texture;
        case "pbr.iridescenceThickness":
            return material._iridescence?.thicknessTexture;
        case "pbr.anisotropy":
            return material._anisotropy?.texture;
        case "pbr.translucencyColor":
            return material._subsurface?.translucency?.colorTexture;
        case "pbr.translucencyIntensity":
            return material._subsurface?.translucency?.intensityTexture;
        case "pbr.thickness":
            return material._subsurface?.thickness?.texture;
        case "pbr.transmission":
            return material._subsurface?.refraction?.texture;
        default:
            throw new Error(`Unexpected optional binding ${id}.`);
    }
}

describe("PBR core material inspection matrix", () => {
    it("emits every approved core property with effective defaults and omits optional or internal state", () => {
        const material = createPbrMaterial();
        const snapshot = inspect(material);

        expect(snapshot.family).toBe("pbr");
        expect(
            snapshot.properties.map((entry) => [
                entry.id,
                entry.section,
                entry.label,
                entry.valueType,
                entry.access.access === "read-write" ? entry.access.mutation : "read-only",
                entry.access.access === "read-write" ? entry.access.postMutation : "none",
            ])
        ).toEqual(EXPECTED_PROPERTIES);
        expect(propertyValues(material)).toEqual({
            "material.name": "",
            "pbr.doubleSided": false,
            "pbr.alphaBlend": false,
            "pbr.enableSpecularAA": false,
            "pbr.alpha": 1,
            "pbr.alphaCutOff": "absent",
            "pbr.baseColorFactor": "absent",
            "pbr.emissiveColor": "absent",
            "pbr.environmentIntensity": 1,
            "pbr.directIntensity": 1,
            "pbr.reflectance": 0.04,
            "pbr.metallicFactor": 1,
            "pbr.roughnessFactor": 1,
            "pbr.normalTextureScale": 1,
            "pbr.usePhysicalLightFalloff": true,
            "pbr.occlusionStrength": 1,
            "pbr.occlusionTexCoord": 0,
            "pbr.stencil.compare": "absent",
            "pbr.stencil.passOp": "absent",
            "pbr.stencil.failOp": "absent",
            "pbr.stencil.depthFailOp": "absent",
            "pbr.stencil.readMask": "absent",
            "pbr.stencil.writeMask": "absent",
        });

        const byId = new Map(snapshot.properties.map((entry) => [entry.id, entry]));
        expect(byId.get("pbr.alpha")?.access).toMatchObject({ number: { finite: true, min: 0, max: 1 } });
        expect(byId.get("pbr.alphaCutOff")?.access).toMatchObject({ number: { finite: true } });
        expect(byId.get("pbr.occlusionStrength")?.access).toMatchObject({ number: { finite: true, min: 0, max: 1 } });
        expect(byId.get("pbr.occlusionTexCoord")).toMatchObject({
            access: { access: "read-only" },
            options: [
                { value: 0, label: "UV1" },
                { value: 1, label: "UV2" },
            ],
        });
        expect(byId.get("pbr.stencil.readMask")?.access).toMatchObject({ number: { finite: true, integer: true, min: 0, max: 0xffffffff } });
        expect(snapshot.properties.map(({ id }) => id)).not.toEqual(
            expect.arrayContaining([
                "pbr.lightmapLevel",
                "pbr.clearCoat.enabled",
                "pbr.transmission.intensity",
                "pbr.mode.unlit",
                "_subsurface",
                "scattering",
                "_localEnvironment",
                "plugins",
                "_renderFeatures",
            ])
        );
    });

    it("reports configured optional core values and effective stencil defaults", () => {
        const material = createPbrMaterial({
            _alphaCutOff: 0,
            baseColorFactor: [0.1, 0.2, 0.3, 0.4],
            _emissiveColor: [2, 1, 0.5],
            occlusionTexCoord: 1,
            stencil: { compare: "equal", writeMask: 3 },
        });

        const values = propertyValues(material);
        expect(values["pbr.alphaCutOff"]).toBe(0);
        expect(values["pbr.baseColorFactor"]).toEqual([0.1, 0.2, 0.3, 0.4]);
        expect(values["pbr.emissiveColor"]).toEqual([2, 1, 0.5]);
        expect(values["pbr.occlusionTexCoord"]).toBe(1);
        expect(values["pbr.stencil.compare"]).toBe("equal");
        expect(values["pbr.stencil.passOp"]).toBe("keep");
        expect(values["pbr.stencil.failOp"]).toBe("keep");
        expect(values["pbr.stencil.depthFailOp"]).toBe("keep");
        expect(values["pbr.stencil.readMask"]).toBe(0xff);
        expect(values["pbr.stencil.writeMask"]).toBe(3);
    });

    it("emits all six core slots in canonical order with exact empty capabilities", () => {
        const bindings = inspect(createPbrMaterial()).textureBindings;

        expect(bindings.map(({ id, label }) => [id, label])).toEqual(EXPECTED_BINDINGS.map(([id, label]) => [id, label]));
        for (const binding of bindings) {
            expect(binding.value).toEqual({ state: "absent" });
            expect(binding.acceptedKinds).toEqual(["2d"]);
            expect(binding.sampleCategory).toBe("float");
            expect(binding.viewCategory).toBe("2d");
            expect(binding.directions).toEqual(["assign"]);
            expect(binding.mutation).toEqual({ access: "read-write", mutation: "R", postMutation: "rebuild-material", number: undefined });
            expect(binding.transform).toEqual({ state: "absent" });
        }
    });

    it("reports exact present wrappers, directions, and transforms only after the public PBR enabler runs", () => {
        const textures = EXPECTED_BINDINGS.map((_, index) => texture2d(index));
        textures[0]!.uScale = 2;
        textures[0]!.vScale = 3;
        textures[0]!.uOffset = 0.25;
        textures[0]!.vOffset = -0.5;
        textures[0]!.uAng = 0.75;
        const material = createPbrMaterial(Object.fromEntries(EXPECTED_BINDINGS.map(([, , field], index) => [field, textures[index]])) as Partial<PbrMaterialProps>);

        expect(inspect(material).textureBindings.every((binding) => binding.transform.state === "unsupported")).toBe(true);
        expect(enableMaterialUvTransform(material)).toBe(true);

        const bindings = inspect(material).textureBindings;
        expect(bindings.map((binding) => binding.value)).toEqual(textures.map((texture) => ({ state: "present", value: { entity: texture, kind: "2d" } })));
        expect(bindings.every((binding) => binding.directions.join(",") === "replace,clear,navigate")).toBe(true);
        expect(bindings[0]!.transform).toEqual({
            state: "present",
            value: { uScale: 2, vScale: 3, uOffset: 0.25, vOffset: -0.5, uAng: 0.75 },
        });
        for (const binding of bindings.slice(1)) {
            expect(binding.transform).toEqual({
                state: "present",
                value: { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0, uAng: 0 },
            });
        }
    });

    it("has no static optional fragment/setter imports, registrations, or eager collections", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/inspection/pbr-material-inspection.ts"), "utf-8");
        expect(source).not.toMatch(/^import .*\/fragments\//m);
        expect(source).not.toMatch(
            /^import .*\/(?:set-alpha-cutoff|set-emissive|enable-material-stencil|enable-material-uv-transform|enable-pbr-lightmap|set-metallic-reflectance|set-clearcoat|set-sheen|set-iridescence|set-anisotropy|set-subsurface|set-transmission|set-dispersion)/m
        );
        expect(source).not.toMatch(/\b_registerPbrExt\s*\(/);
        expect(source).not.toMatch(/\bnew (?:Map|Set|WeakMap)\s*\(/);
    });
});

describe("PBR core property mutation", () => {
    it("routes every unchanged-feature U property through exactly one common UBO mark", async () => {
        const material = createPbrMaterial({
            alpha: 0.8,
            _alphaCutOff: 0.2,
            baseColorFactor: [1, 1, 1, 1],
            _emissiveColor: [0, 0, 0],
            occlusionStrength: 0.5,
        });
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue, () => unknown][] = [
            ["pbr.alpha", 0.6, () => material.alpha],
            ["pbr.alphaCutOff", 0.3, () => material._alphaCutOff],
            ["pbr.baseColorFactor", [0.1, 0.2, 0.3, 0.4], () => material.baseColorFactor],
            ["pbr.emissiveColor", [2, 1, 0.5], () => material._emissiveColor],
            ["pbr.environmentIntensity", 0.75, () => material.environmentIntensity],
            ["pbr.directIntensity", 0.5, () => material.directIntensity],
            ["pbr.reflectance", 0.08, () => material.reflectance],
            ["pbr.metallicFactor", 0.6, () => material.metallicFactor],
            ["pbr.roughnessFactor", 0.4, () => material.roughnessFactor],
            ["pbr.normalTextureScale", -0.5, () => material.normalTextureScale],
            ["pbr.usePhysicalLightFalloff", false, () => material.usePhysicalLightFalloff],
            ["pbr.occlusionStrength", 0.75, () => material.occlusionStrength],
        ];

        for (const [id, value, read] of mutations) {
            const before = material._uboVersion;
            await expect(setProperty({ scenes: [] }, material, id, value)).resolves.toEqual({
                changed: true,
                mutation: "U",
                postMutation: "none",
            });
            expect(material._uboVersion).toBe(before + 1);
            expect(read()).toEqual(value);
            if (Array.isArray(value)) {
                expect(read()).not.toBe(value);
            }
        }

        expect(pbrApis.setAlphaCutoff).toHaveBeenCalledWith(material, 0.3);
        expect(pbrApis.setEmissive).toHaveBeenCalledWith(material, [2, 1, 0.5]);

        const before = material._uboVersion;
        await expect(setProperty({ scenes: [] }, material, "pbr.environmentIntensity", material.environmentIntensity!)).resolves.toEqual({
            changed: false,
            mutation: "U",
            postMutation: "none",
        });
        expect(material._uboVersion).toBe(before);
    });

    it("uses the actual blend predicate for alpha U/R decisions and rebuilds every owning scene and view", async () => {
        const material = createPbrMaterial({ alpha: 1 });
        const view = createMaterialView(material, { features: 0, features2: 0 });
        const first = createScene([material, view]);
        const second = createScene([view]);

        await expect(setProperty({ scenes: [first.scene, first.scene, second.scene] }, material, "pbr.alpha", 0.5)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(first.rebuild).toHaveBeenCalledTimes(2);
        expect(second.rebuild).toHaveBeenCalledOnce();
        expect(material._uboVersion).toBe(0);

        await expect(setProperty({ scenes: [] }, material, "pbr.alpha", 0.25)).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(material._uboVersion).toBe(1);

        await expect(setProperty({ scenes: [first.scene, second.scene] }, material, "pbr.alpha", 1)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(first.rebuild).toHaveBeenCalledTimes(4);
        expect(second.rebuild).toHaveBeenCalledTimes(2);

        material.alphaBlend = true;
        await expect(setProperty({ scenes: [] }, material, "pbr.alpha", 0.5)).resolves.toMatchObject({ mutation: "U" });
        material.alphaBlend = false;
        material._alphaCutOff = 0.4;
        await expect(setProperty({ scenes: [] }, material, "pbr.alpha", 0.25)).resolves.toMatchObject({ mutation: "U" });
    });

    it("resolves alpha-test, base-factor, emissive, and occlusion feature boundaries before applying", async () => {
        const material = createPbrMaterial({ alpha: 1, occlusionStrength: 0 });
        const { scene, rebuild } = createScene([material]);

        await expect(setProperty({ scenes: [scene] }, material, "pbr.alphaCutOff", 0.5)).resolves.toMatchObject({ mutation: "R" });
        await expect(setProperty({ scenes: [] }, material, "pbr.alphaCutOff", 0.25)).resolves.toMatchObject({ mutation: "U" });
        await expect(setProperty({ scenes: [scene] }, material, "pbr.alphaCutOff", 0)).resolves.toMatchObject({ mutation: "R" });

        const baseFactor = [0.8, 0.7, 0.6, 0.5] as const;
        await expect(setProperty({ scenes: [scene] }, material, "pbr.baseColorFactor", baseFactor)).resolves.toMatchObject({ mutation: "R" });
        await expect(setProperty({ scenes: [] }, material, "pbr.baseColorFactor", [0.4, 0.3, 0.2, 0.1])).resolves.toMatchObject({ mutation: "U" });

        await expect(setProperty({ scenes: [scene] }, material, "pbr.emissiveColor", [1, 0, 0])).resolves.toMatchObject({ mutation: "R" });
        await expect(setProperty({ scenes: [] }, material, "pbr.emissiveColor", [0, 1, 0])).resolves.toMatchObject({ mutation: "U" });

        await expect(setProperty({ scenes: [scene] }, material, "pbr.occlusionStrength", 0.5)).resolves.toMatchObject({ mutation: "R" });
        await expect(setProperty({ scenes: [] }, material, "pbr.occlusionStrength", 0.75)).resolves.toMatchObject({ mutation: "U" });
        await expect(setProperty({ scenes: [scene] }, material, "pbr.occlusionStrength", 0)).resolves.toMatchObject({ mutation: "R" });

        expect(rebuild).toHaveBeenCalledTimes(6);
        expect(material._uboVersion).toBe(4);
    });

    it("applies every fixed R property and enables stencil only through the public enabler", async () => {
        const material = createPbrMaterial();
        const { scene, rebuild } = createScene([material]);
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue, () => unknown][] = [
            ["pbr.doubleSided", true, () => material.doubleSided],
            ["pbr.alphaBlend", true, () => material.alphaBlend],
            ["pbr.enableSpecularAA", true, () => material.enableSpecularAA],
            ["pbr.stencil.compare", "equal", () => material.stencil?.compare],
            ["pbr.stencil.passOp", "replace", () => material.stencil?.passOp],
            ["pbr.stencil.failOp", "zero", () => material.stencil?.failOp],
            ["pbr.stencil.depthFailOp", "invert", () => material.stencil?.depthFailOp],
            ["pbr.stencil.readMask", 0x0f, () => material.stencil?.readMask],
            ["pbr.stencil.writeMask", 0xf0, () => material.stencil?.writeMask],
        ];

        for (const [id, value, read] of mutations) {
            await expect(setProperty({ scenes: [scene] }, material, id, value)).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(read()).toEqual(value);
        }

        expect(rebuild).toHaveBeenCalledTimes(mutations.length);
        expect(pbrApis.enableStencil).toHaveBeenCalledTimes(6);
        expect(material._uboVersion).toBe(0);

        await expect(setProperty({ scenes: [scene] }, material, "pbr.doubleSided", true)).resolves.toEqual({
            changed: false,
            mutation: "R",
            postMutation: "none",
        });
        expect(rebuild).toHaveBeenCalledTimes(mutations.length);
    });

    it("rejects read-only UV claims and invalid ranges, finite values, tuples, and stencil masks before mutation", async () => {
        const material = createPbrMaterial();
        const { scene, rebuild } = createScene([material]);
        const invalid: readonly [MaterialInspectionPropertyId, unknown, RegExp][] = [
            ["pbr.alpha", -0.01, /at least 0/],
            ["pbr.alpha", 1.01, /at most 1/],
            ["pbr.alphaCutOff", Number.NaN, /finite/],
            ["pbr.environmentIntensity", Number.POSITIVE_INFINITY, /finite/],
            ["pbr.occlusionStrength", -0.01, /at least 0/],
            ["pbr.occlusionStrength", 1.01, /at most 1/],
            ["pbr.baseColorFactor", [1, 1, 1], /4-component/],
            ["pbr.emissiveColor", [1, 2, Number.NaN], /finite tuple/],
            ["pbr.stencil.compare", "invalid", /enum value/],
            ["pbr.stencil.readMask", 1.5, /integer/],
            ["pbr.stencil.readMask", -1, /at least 0/],
            ["pbr.stencil.writeMask", 0x1_0000_0000, /at most/],
        ];

        for (const [id, value, message] of invalid) {
            await expect(setProperty({ scenes: [scene] }, material, id, value as MaterialInspectionPropertyValue)).rejects.toThrow(message);
        }
        await expect(setProperty({ scenes: [scene] }, material, "pbr.occlusionTexCoord", 1)).rejects.toThrow(/read-only/);

        expect(rebuild).not.toHaveBeenCalled();
        expect(pbrApis.enableStencil).not.toHaveBeenCalled();
        expect(pbrApis.setAlphaCutoff).not.toHaveBeenCalled();
        expect(pbrApis.setEmissive).not.toHaveBeenCalled();
        expect(material._uboVersion).toBe(0);
        expect(material.occlusionTexCoord).toBeUndefined();
    });

    it("leaves alpha-cutoff and stencil state untouched when public enablement fails", async () => {
        const material = createPbrMaterial();
        const { scene, rebuild } = createScene([material]);
        pbrApis.setAlphaCutoff.mockImplementationOnce(() => {
            throw new Error("alpha enable failed");
        });
        pbrApis.enableStencil.mockImplementationOnce(() => {
            throw new Error("stencil enable failed");
        });

        await expect(setProperty({ scenes: [scene] }, material, "pbr.alphaCutOff", 0.5)).rejects.toThrow("alpha enable failed");
        await expect(setProperty({ scenes: [scene] }, material, "pbr.stencil.compare", "equal")).rejects.toThrow("stencil enable failed");
        expect(material._alphaCutOff).toBeUndefined();
        expect(material.stencil).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
    });
});

describe("PBR core texture mutation", () => {
    it("supports assignment, replacement, navigation, and clearing for every canonical core slot", async () => {
        for (let index = 0; index < EXPECTED_BINDINGS.length; index++) {
            const [id, , field] = EXPECTED_BINDINGS[index]!;
            const material = createPbrMaterial();
            const { scene, rebuild } = createScene([material]);
            const first = texture2d(index * 2);
            const second = texture2d(index * 2 + 1);

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "assign", texture: first })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(material[field]).toBe(first);
            expect(inspect(material).textureBindings.find((binding) => binding.id === id)?.directions).toEqual(["replace", "clear", "navigate"]);

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "replace", texture: second })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(material[field]).toBe(second);
            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "replace", texture: second })).resolves.toEqual({
                changed: false,
                mutation: "R",
                postMutation: "none",
            });

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "clear" })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(material[field]).toBeUndefined();
            expect(rebuild).toHaveBeenCalledTimes(3);
        }
    });

    it("rejects cube and malformed type mismatches before assignment or rebuild", async () => {
        const material = createPbrMaterial();
        const { scene, rebuild } = createScene([material]);

        await expect(setTexture({ scenes: [scene] }, material, "pbr.baseColor", { direction: "assign", texture: cubeTexture(1) })).rejects.toThrow(/Texture2D/);
        await expect(setTexture({ scenes: [scene] }, material, "pbr.normal", { direction: "assign", texture: {} })).rejects.toThrow(/Texture2D/);

        expect(material.baseColorTexture).toBeUndefined();
        expect(material.normalTexture).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
    });

    it("rejects unsupported mutation directions with zero source mutation", async () => {
        const material = createPbrMaterial({ baseColorTexture: texture2d(1) });
        const { scene, rebuild } = createScene([material]);

        await expect(setTexture({ scenes: [scene] }, material, "pbr.emissive", { direction: "replace", texture: texture2d(2) })).rejects.toThrow(/does not support/);
        await expect(setTexture({ scenes: [scene] }, material, "pbr.occlusion", { direction: "clear" })).rejects.toThrow(/does not support/);
        await expect(setTexture({ scenes: [scene] }, material, "pbr.baseColor", { direction: "assign", texture: texture2d(3) })).rejects.toThrow(/does not support/);

        expect(material.baseColorTexture).toBeDefined();
        expect(material.emissiveTexture).toBeUndefined();
        expect(material.occlusionTexture).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
    });
});

describe("PBR optional material inspection matrix", () => {
    it("emits every configured optional family with public effective values and omits unconfigured sections", () => {
        const material = createConfiguredOptionalMaterial();
        const snapshot = inspect(material);
        const values = propertyValues(material);

        expect(snapshot.properties.map(({ id }) => id)).toEqual([...EXPECTED_PROPERTIES.map(([id]) => id), ...OPTIONAL_PROPERTY_IDS]);
        expect(Object.fromEntries(OPTIONAL_PROPERTY_IDS.map((id) => [id, values[id]]))).toEqual({
            "pbr.lightmapLevel": 0.5,
            "pbr.lightmapCoordIndex": 1,
            "pbr.useLightmapAsShadowmap": true,
            "pbr.gammaLightmap": true,
            "pbr.metallicReflectanceColor": [0.8, 0.7, 0.6],
            "pbr.metallicF0Factor": 0.9,
            "pbr.specularWeight": 0.75,
            "pbr.useOnlyMetallicFromTexture": true,
            "pbr.clearCoat.enabled": true,
            "pbr.clearCoat.intensity": 0.8,
            "pbr.clearCoat.roughness": 0.2,
            "pbr.clearCoat.indexOfRefraction": 1.4,
            "pbr.clearCoat.useF0Remap": false,
            "pbr.clearCoat.bumpTextureScale": 0.7,
            "pbr.sheen.enabled": true,
            "pbr.sheen.color": [0.2, 0.3, 0.4],
            "pbr.sheen.roughness": 0.35,
            "pbr.sheen.intensity": 0.65,
            "pbr.sheen.albedoScaling": true,
            "pbr.iridescence.enabled": true,
            "pbr.iridescence.intensity": 0.6,
            "pbr.iridescence.indexOfRefraction": 1.25,
            "pbr.iridescence.minimumThickness": 120,
            "pbr.iridescence.maximumThickness": 360,
            "pbr.anisotropy.enabled": true,
            "pbr.anisotropy.intensity": 0.55,
            "pbr.anisotropy.direction": [0.8, 0.2],
            "pbr.translucency.intensity": 0.45,
            "pbr.translucency.color": [0.9, 0.8, 0.7],
            "pbr.translucency.diffusionDistance": [1, 2, 3],
            "pbr.thickness.min": 0.1,
            "pbr.thickness.max": 0.9,
            "pbr.thickness.useGlTFChannel": true,
            "pbr.tint.color": [0.6, 0.7, 0.8],
            "pbr.tint.atDistance": 4,
            "pbr.transmission.intensity": 0.7,
            "pbr.transmission.indexOfRefraction": 1.45,
            "pbr.transmission.useThicknessAsDepth": true,
            "pbr.transmission.dispersion": 0.2,
        });

        const empty = inspect(createPbrMaterial());
        expect(empty.properties.map(({ id }) => id)).toEqual(EXPECTED_PROPERTIES.map(([id]) => id));
        expect(empty.textureBindings.map(({ id }) => id)).toEqual(EXPECTED_BINDINGS.map(([id]) => id));
    });

    it("keeps every configured optional binding in canonical order with exact directional capabilities", () => {
        const populated = inspect(createConfiguredOptionalMaterial()).textureBindings.slice(EXPECTED_BINDINGS.length);
        expect(populated.map(({ id }) => id)).toEqual(OPTIONAL_BINDING_IDS);
        expect(populated.map(({ directions }) => directions)).toEqual(
            OPTIONAL_BINDING_IDS.map((_, index) => (index < 3 ? ["replace", "navigate"] : ["replace", "clear", "navigate"]))
        );

        const emptySlots = inspect(createConfiguredOptionalMaterial(false)).textureBindings.slice(EXPECTED_BINDINGS.length);
        expect(emptySlots.map(({ id }) => id)).toEqual(OPTIONAL_BINDING_IDS);
        expect(emptySlots.map(({ directions }) => directions)).toEqual([["replace", "navigate"], ...OPTIONAL_BINDING_IDS.slice(1).map(() => ["assign"])]);
    });

    it("exposes configured one-way modes as read-only and omits scattering and probe internals", async () => {
        const material = createPbrMaterial({
            _unlit: true,
            _unlitColor: [0.2, 0.3, 0.4],
            _gammaAlbedo: true,
            _skyboxMode: true,
            _shadowOnly: true,
            _shadowOnlyColor: [0.1, 0.2, 0.3],
            _shadowOnlyOpacity: 0.6,
            _shadowOnlyFalloff: 2,
            _subsurface: { scattering: { diffusionDistance: [1, 2, 3], metersPerUnit: 4 } },
            ...({
                _localEnvironment: cubeTexture(1),
                _reflectionProbe: cubeTexture(2),
            } as Partial<PbrMaterialProps>),
        });
        const snapshot = inspect(material);
        const special = snapshot.properties.filter(({ section }) => section === "special-modes");

        expect(special.map(({ id }) => id)).toEqual([
            "pbr.mode.unlit",
            "pbr.mode.unlitColor",
            "pbr.mode.gammaAlbedo",
            "pbr.mode.skybox",
            "pbr.mode.shadowOnly",
            "pbr.mode.shadowOnlyColor",
            "pbr.mode.shadowOnlyOpacity",
            "pbr.mode.shadowOnlyFalloff",
        ]);
        expect(special.every(({ access }) => access.access === "read-only")).toBe(true);
        expect(snapshot.properties.map(({ id }) => id)).not.toEqual(expect.arrayContaining(["pbr.scattering", "pbr.localEnvironment", "pbr.reflectionProbe"]));
        expect(snapshot.textureBindings.map(({ id }) => id)).not.toEqual(expect.arrayContaining(["pbr.scattering", "pbr.localEnvironment", "pbr.reflectionProbe"]));

        for (const property of special) {
            await expect(setProperty({ scenes: [] }, material, property.id, property.value.state === "present" ? property.value.value : true)).rejects.toThrow(/read-only/);
        }
        expect(material._uboVersion).toBe(0);
    });
});

describe("PBR optional property mutation", () => {
    it("routes every optional field through its reconstructed public setter with the exact U/R class", async () => {
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue, "U" | "R"][] = [
            ["pbr.lightmapLevel", 0.6, "U"],
            ["pbr.lightmapCoordIndex", 0, "R"],
            ["pbr.useLightmapAsShadowmap", false, "R"],
            ["pbr.gammaLightmap", false, "R"],
            ["pbr.metallicReflectanceColor", [0.4, 0.5, 0.6], "U"],
            ["pbr.metallicF0Factor", 0.8, "U"],
            ["pbr.specularWeight", 0.6, "U"],
            ["pbr.useOnlyMetallicFromTexture", false, "R"],
            ["pbr.clearCoat.enabled", false, "R"],
            ["pbr.clearCoat.intensity", 0.7, "U"],
            ["pbr.clearCoat.roughness", 0.3, "U"],
            ["pbr.clearCoat.indexOfRefraction", 1.6, "U"],
            ["pbr.clearCoat.useF0Remap", true, "R"],
            ["pbr.clearCoat.bumpTextureScale", 0.6, "U"],
            ["pbr.sheen.enabled", false, "R"],
            ["pbr.sheen.color", [0.4, 0.3, 0.2], "U"],
            ["pbr.sheen.roughness", 0.45, "U"],
            ["pbr.sheen.intensity", 0.55, "U"],
            ["pbr.sheen.albedoScaling", false, "R"],
            ["pbr.iridescence.enabled", false, "R"],
            ["pbr.iridescence.intensity", 0.5, "U"],
            ["pbr.iridescence.indexOfRefraction", 1.35, "U"],
            ["pbr.iridescence.minimumThickness", 140, "U"],
            ["pbr.iridescence.maximumThickness", 420, "U"],
            ["pbr.anisotropy.enabled", false, "R"],
            ["pbr.anisotropy.intensity", 0.45, "U"],
            ["pbr.anisotropy.direction", [0.6, 0.4], "U"],
            ["pbr.translucency.intensity", 0.35, "U"],
            ["pbr.translucency.color", [0.7, 0.6, 0.5], "U"],
            ["pbr.translucency.diffusionDistance", [3, 2, 1], "U"],
            ["pbr.thickness.min", 0.2, "U"],
            ["pbr.thickness.max", 1.2, "U"],
            ["pbr.thickness.useGlTFChannel", false, "R"],
            ["pbr.tint.color", [0.3, 0.4, 0.5], "U"],
            ["pbr.tint.atDistance", 5, "U"],
            ["pbr.transmission.intensity", 0.6, "U"],
            ["pbr.transmission.indexOfRefraction", 1.6, "U"],
            ["pbr.transmission.useThicknessAsDepth", false, "U"],
            ["pbr.transmission.dispersion", 0.3, "U"],
        ];

        for (const [id, value, mutation] of mutations) {
            const material = createConfiguredOptionalMaterial();
            const { scene } = createScene([material]);
            const result = await setProperty({ scenes: [scene] }, material, id, value);
            expect(result, id).toEqual({
                changed: true,
                mutation,
                postMutation: mutation === "R" ? "rebuild-material" : "none",
            });
            expect(propertyValues(material)[id], id).toEqual(value);
        }
    });

    it("reconstructs each public setter family, preserves sibling state, and keeps stable numeric and color edits on U", async () => {
        const material = createConfiguredOptionalMaterial();
        const { scene } = createScene([material]);
        const beforeTextures = new Map(OPTIONAL_BINDING_IDS.map((id) => [id, readOptionalTexture(material, id)]));
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue][] = [
            ["pbr.lightmapLevel", 0.6],
            ["pbr.metallicReflectanceColor", [0.4, 0.5, 0.6]],
            ["pbr.clearCoat.roughness", 0.3],
            ["pbr.sheen.color", [0.4, 0.3, 0.2]],
            ["pbr.iridescence.maximumThickness", 420],
            ["pbr.anisotropy.direction", [0.6, 0.4]],
            ["pbr.translucency.diffusionDistance", [3, 2, 1]],
            ["pbr.thickness.max", 1.2],
            ["pbr.tint.color", [0.3, 0.4, 0.5]],
            ["pbr.transmission.indexOfRefraction", 1.6],
            ["pbr.transmission.dispersion", 0.3],
        ];

        for (const [id, value] of mutations) {
            const result = await setProperty({ scenes: [scene] }, material, id, value);
            expect(result, id).toEqual({
                changed: true,
                mutation: "U",
                postMutation: "none",
            });
        }

        expect(material._uboVersion).toBe(mutations.length);
        expect(material._subsurface?.scattering).toEqual({ diffusionDistance: [9, 8, 7], metersPerUnit: 2 });
        expect(material._subsurface?.translucency).toMatchObject({ intensity: 0.45, color: [0.9, 0.8, 0.7] });
        expect(material._subsurface?.thickness).toMatchObject({ min: 0.1, useGlTFChannel: true });
        expect(material._subsurface?.tint).toMatchObject({ atDistance: 4 });
        expect(material._subsurface?.refraction).toMatchObject({ intensity: 0.7, useThicknessAsDepth: true });
        for (const [id, texture] of beforeTextures) {
            expect(readOptionalTexture(material, id)).toBe(texture);
        }
    });

    it("classifies feature transitions as R across shared material views and rebuilds frame graphs only for transmission participation", async () => {
        const material = createPbrMaterial({ _clearCoat: { isEnabled: false, intensity: 0.8 } });
        const view = createMaterialView(material, { features: 0, features2: 0 });
        const first = createScene([material, view]);
        const second = createScene([view]);

        await expect(setProperty({ scenes: [first.scene, second.scene] }, material, "pbr.clearCoat.enabled", true)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(first.rebuild).toHaveBeenCalledTimes(2);
        expect(second.rebuild).toHaveBeenCalledOnce();
        expect(first.frameGraphBuild).not.toHaveBeenCalled();
        expect(second.frameGraphBuild).not.toHaveBeenCalled();

        const transmissive = createPbrMaterial({
            _transmissive: true,
            _subsurface: {
                thickness: { min: 0.1, max: 1 },
                tint: { color: [1, 0.9, 0.8], atDistance: 2 },
                refraction: { intensity: 0, dispersion: 0 },
            },
        });
        const transmissiveView = createMaterialView(transmissive, { features: 0, features2: 0 });
        const transmissionScene = createScene([transmissive, transmissiveView]);

        await expect(setProperty({ scenes: [transmissionScene.scene] }, transmissive, "pbr.transmission.intensity", 0.7)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material-and-frame-graph",
        });
        expect(transmissionScene.rebuild).toHaveBeenCalledTimes(2);
        expect(transmissionScene.frameGraphBuild).toHaveBeenCalledOnce();

        await expect(setProperty({ scenes: [transmissionScene.scene] }, transmissive, "pbr.transmission.dispersion", 0.4)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(transmissionScene.rebuild).toHaveBeenCalledTimes(4);
        expect(transmissionScene.frameGraphBuild).toHaveBeenCalledOnce();

        await expect(setProperty({ scenes: [transmissionScene.scene] }, transmissive, "pbr.transmission.dispersion", 0.6)).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(transmissionScene.rebuild).toHaveBeenCalledTimes(4);
        expect(transmissionScene.frameGraphBuild).toHaveBeenCalledOnce();
    });

    it("resolves every optional shader-mode boundary from before and after signatures", async () => {
        const cases: readonly [PbrMaterialProps, MaterialInspectionPropertyId, MaterialInspectionPropertyValue][] = [
            [createConfiguredOptionalMaterial(), "pbr.useLightmapAsShadowmap", false],
            [
                createPbrMaterial({
                    _metallicReflectanceColor: [0.5, 0.5, 0.5],
                    _metallicF0Factor: 1,
                }),
                "pbr.metallicReflectanceColor",
                [1, 1, 1],
            ],
            [createPbrMaterial({ _clearCoat: { isEnabled: true, useF0Remap: false } }), "pbr.clearCoat.useF0Remap", true],
            [createPbrMaterial({ _sheen: { isEnabled: true, albedoScaling: true } }), "pbr.sheen.albedoScaling", false],
            [createPbrMaterial({ _iridescence: { isEnabled: true } }), "pbr.iridescence.enabled", false],
            [createPbrMaterial({ _anisotropy: { isEnabled: true } }), "pbr.anisotropy.enabled", false],
            [
                createPbrMaterial({
                    _subsurface: {
                        translucency: {},
                        thickness: { texture: texture2d(500), useGlTFChannel: true },
                    },
                }),
                "pbr.thickness.useGlTFChannel",
                false,
            ],
        ];

        for (const [material, id, value] of cases) {
            const { scene } = createScene([material]);
            const result = await setProperty({ scenes: [scene] }, material, id, value);
            expect(result, id).toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
        }

        const transmissive = createPbrMaterial({
            _transmissive: true,
            _subsurface: { refraction: { intensity: 0.8 } },
        });
        const transmissionScene = createScene([transmissive]);
        await expect(setProperty({ scenes: [transmissionScene.scene] }, transmissive, "pbr.transmission.intensity", 0)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material-and-frame-graph",
        });
        expect(transmissionScene.frameGraphBuild).toHaveBeenCalledOnce();
    });

    it("awaits lightmap enablement before mutation and preserves the exact prior state on rejection", async () => {
        const texture = texture2d(1);
        const material = createPbrMaterial({
            lightmapTexture: texture,
            lightmapLevel: 0.5,
            lightmapCoordIndex: 1,
            useLightmapAsShadowmap: true,
            gammaLightmap: false,
            _uv2Mask: 95,
        });
        const { scene, rebuild } = createScene([material]);
        pbrApis.enableLightmap.mockRejectedValueOnce(new Error("lightmap enable failed"));

        await expect(setProperty({ scenes: [scene] }, material, "pbr.lightmapLevel", 0.8)).rejects.toThrow("lightmap enable failed");
        expect(material).toMatchObject({
            lightmapTexture: texture,
            lightmapLevel: 0.5,
            lightmapCoordIndex: 1,
            useLightmapAsShadowmap: true,
            gammaLightmap: false,
            _uv2Mask: 95,
            _uboVersion: 0,
        });
        expect(pbrApis.setLightmap).not.toHaveBeenCalled();
        expect(rebuild).not.toHaveBeenCalled();

        await expect(setProperty({ scenes: [scene] }, material, "pbr.lightmapCoordIndex", 0)).resolves.toMatchObject({ mutation: "R" });
        expect(material._uv2Mask).toBe(31);
    });
});

describe("PBR optional texture mutation", () => {
    it("supports assign, replace, and clear for every reversible optional slot", async () => {
        const material = createConfiguredOptionalMaterial(false);
        const reversible = OPTIONAL_BINDING_IDS.slice(3);
        const { scene } = createScene([material]);

        for (let index = 0; index < reversible.length; index++) {
            const id = reversible[index]!;
            const first = texture2d(200 + index * 2);
            const second = texture2d(201 + index * 2);

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "assign", texture: first })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(readOptionalTexture(material, id)).toBe(first);
            expect(inspect(material).textureBindings.find((entry) => entry.id === id)?.directions).toEqual(["replace", "clear", "navigate"]);

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "replace", texture: second })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(readOptionalTexture(material, id)).toBe(second);

            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "clear" })).resolves.toEqual({
                changed: true,
                mutation: "R",
                postMutation: "rebuild-material",
            });
            expect(readOptionalTexture(material, id)).toBeUndefined();
        }
    });

    it("supports assign and replace but rejects unsafe clear for metallic reflectance, and rejects lightmap clear", async () => {
        const material = createConfiguredOptionalMaterial(false);
        const { scene } = createScene([material]);
        const first = texture2d(300);
        const second = texture2d(301);

        for (const id of ["pbr.metallicReflectance", "pbr.reflectance"] as const) {
            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "assign", texture: first })).resolves.toMatchObject({ mutation: "R" });
            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "replace", texture: second })).resolves.toMatchObject({ mutation: "R" });
            await expect(setTexture({ scenes: [scene] }, material, id, { direction: "clear" })).rejects.toThrow(/does not support/);
            expect(readOptionalTexture(material, id)).toBe(second);
        }

        const originalLightmap = material.lightmapTexture;
        await expect(setTexture({ scenes: [scene] }, material, "pbr.lightmap", { direction: "replace", texture: second })).resolves.toMatchObject({ mutation: "R" });
        await expect(setTexture({ scenes: [scene] }, material, "pbr.lightmap", { direction: "clear" })).rejects.toThrow(/does not support/);
        expect(material.lightmapTexture).toBe(second);
        expect(material.lightmapTexture).not.toBe(originalLightmap);
    });

    it("changes only the selected semantic slot when replacing a texture shared by optional families", async () => {
        const shared = texture2d(400);
        const replacement = texture2d(401);
        const material = createPbrMaterial({
            _clearCoat: { isEnabled: true, texture: shared, roughnessTexture: shared },
            _sheen: { isEnabled: true, texture: shared },
        });
        const { scene } = createScene([material]);

        await expect(setTexture({ scenes: [scene] }, material, "pbr.clearCoat", { direction: "replace", texture: replacement })).resolves.toMatchObject({ mutation: "R" });
        expect(material._clearCoat?.texture).toBe(replacement);
        expect(material._clearCoat?.roughnessTexture).toBe(shared);
        expect(material._sheen?.texture).toBe(shared);
    });
});
