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
        expect(source).not.toMatch(/^import .*\/(?:set-alpha-cutoff|set-emissive|enable-material-stencil|enable-material-uv-transform)/m);
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
