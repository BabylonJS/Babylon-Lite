import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { standardMaterialInspectionDescriptor } from "../../../packages/babylon-lite/src/inspection/standard-material-inspection";
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
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import type { StandardMaterialProps } from "../../../packages/babylon-lite/src/material/standard/standard-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";

const standardApis = vi.hoisted(() => ({
    enableStencil: vi.fn(),
    enableUvOffset: vi.fn(),
    setters: {
        "standard.emissive": vi.fn((material: { _emissiveTexture?: object | null }, texture: object | null) => {
            material._emissiveTexture = texture;
        }),
        "standard.bump": vi.fn((material: { _bumpTexture?: object | null }, texture: object | null) => {
            material._bumpTexture = texture;
        }),
        "standard.specular": vi.fn((material: { _specularTexture?: object | null }, texture: object | null) => {
            material._specularTexture = texture;
        }),
        "standard.ambient": vi.fn((material: { _ambientTexture?: object | null }, texture: object | null) => {
            material._ambientTexture = texture;
        }),
        "standard.lightmap": vi.fn((material: { _lightmapTexture?: object | null }, texture: object | null) => {
            material._lightmapTexture = texture;
        }),
        "standard.opacity": vi.fn((material: { _opacityTexture?: object | null }, texture: object | null) => {
            material._opacityTexture = texture;
        }),
        "standard.reflection2d": vi.fn((material: { _reflectionTexture?: object | null }, texture: object | null) => {
            material._reflectionTexture = texture;
        }),
        "standard.reflectionCube": vi.fn((material: { _reflectionCubeTexture?: object | null }, texture: object | null) => {
            material._reflectionCubeTexture = texture;
        }),
    },
}));

vi.mock("../../../packages/babylon-lite/src/material/enable-material-stencil", () => ({
    enableMaterialStencil: standardApis.enableStencil,
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features", () => ({
    enableStandardUvOffset: standardApis.enableUvOffset,
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-emissive", () => ({
    setStandardEmissiveTexture: standardApis.setters["standard.emissive"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-bump", () => ({
    setStandardBumpTexture: standardApis.setters["standard.bump"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-specular", () => ({
    setStandardSpecularTexture: standardApis.setters["standard.specular"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-ambient", () => ({
    setStandardAmbientTexture: standardApis.setters["standard.ambient"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-lightmap", () => ({
    setStandardLightmapTexture: standardApis.setters["standard.lightmap"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-opacity", () => ({
    setStandardOpacityTexture: standardApis.setters["standard.opacity"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-reflection", () => ({
    setStandardReflectionTexture: standardApis.setters["standard.reflection2d"],
}));
vi.mock("../../../packages/babylon-lite/src/material/standard/set-std-cube-reflection", () => ({
    setStandardReflectionCubeTexture: standardApis.setters["standard.reflectionCube"],
}));

const EXPECTED_PROPERTIES = [
    ["material.name", "general", "Name", "string", "A", "none"],
    ["standard.backFaceCulling", "general", "Back Face Culling", "boolean", "R", "rebuild-material"],
    ["standard.disableLighting", "general", "Disable Lighting", "boolean", "R", "rebuild-material"],
    ["standard.alpha", "transparency", "Alpha", "number", "U/R", "rebuild-material"],
    ["standard.alphaCutOff", "transparency", "Alpha Cutoff", "number", "U", "none"],
    ["standard.diffuseColor", "lighting-colors", "Diffuse Color", "vec3", "U", "none"],
    ["standard.specularColor", "lighting-colors", "Specular Color", "vec3", "U", "none"],
    ["standard.emissiveColor", "lighting-colors", "Emissive Color", "vec3", "U", "none"],
    ["standard.ambientColor", "lighting-colors", "Ambient Color", "vec3", "U", "none"],
    ["standard.specularPower", "lighting-colors", "Specular Power", "number", "U", "none"],
    ["standard.diffuseCoordIndex", "texture-settings", "Diffuse Coordinates", "enum", "R", "rebuild-material"],
    ["standard.specularCoordIndex", "texture-settings", "Specular Coordinates", "enum", "R", "rebuild-material"],
    ["standard.ambientCoordIndex", "texture-settings", "Ambient Coordinates", "enum", "R", "rebuild-material"],
    ["standard.lightmapCoordIndex", "texture-settings", "Lightmap Coordinates", "enum", "R", "rebuild-material"],
    ["standard.bumpLevel", "texture-settings", "Bump Level", "number", "U", "none"],
    ["standard.ambientTexLevel", "texture-settings", "Ambient Texture Level", "number", "U", "none"],
    ["standard.lightmapLevel", "texture-settings", "Lightmap Level", "number", "U", "none"],
    ["standard.opacityLevel", "texture-settings", "Opacity Level", "number", "U", "none"],
    ["standard.reflectionLevel", "texture-settings", "Reflection Level", "number", "U", "none"],
    ["standard.reflectionCoordMode", "texture-settings", "Reflection Coordinates", "enum", "U", "none"],
    ["standard.useLightmapAsShadowmap", "texture-settings", "Use Lightmap as Shadowmap", "boolean", "R", "rebuild-material"],
    ["standard.opacityFromRGB", "texture-settings", "Opacity from RGB", "boolean", "R", "rebuild-material"],
    ["standard.uvScale", "transform", "UV Scale", "vec2", "R", "rebuild-material"],
    ["standard.uvOffset", "transform", "UV Offset", "vec2", "R", "rebuild-material"],
    ["standard.stencil.compare", "stencil", "Stencil Compare", "enum", "R", "rebuild-material"],
    ["standard.stencil.passOp", "stencil", "Stencil Pass Operation", "enum", "R", "rebuild-material"],
    ["standard.stencil.failOp", "stencil", "Stencil Fail Operation", "enum", "R", "rebuild-material"],
    ["standard.stencil.depthFailOp", "stencil", "Stencil Depth Fail Operation", "enum", "R", "rebuild-material"],
    ["standard.stencil.readMask", "stencil", "Stencil Read Mask", "number", "R", "rebuild-material"],
    ["standard.stencil.writeMask", "stencil", "Stencil Write Mask", "number", "R", "rebuild-material"],
] as const;

const EXPECTED_BINDINGS = [
    ["standard.diffuse", "Diffuse Texture", "2d", "2d"],
    ["standard.emissive", "Emissive Texture", "2d", "2d"],
    ["standard.bump", "Bump Texture", "2d", "2d"],
    ["standard.specular", "Specular Texture", "2d", "2d"],
    ["standard.ambient", "Ambient Texture", "2d", "2d"],
    ["standard.lightmap", "Lightmap Texture", "2d", "2d"],
    ["standard.opacity", "Opacity Texture", "2d", "2d"],
    ["standard.reflection2d", "Reflection Texture", "2d", "2d"],
    ["standard.reflectionCube", "Reflection Cube Texture", "cube", "cube"],
] as const;

const BINDING_FIELDS = {
    "standard.diffuse": "diffuseTexture",
    "standard.emissive": "_emissiveTexture",
    "standard.bump": "_bumpTexture",
    "standard.specular": "_specularTexture",
    "standard.ambient": "_ambientTexture",
    "standard.lightmap": "_lightmapTexture",
    "standard.opacity": "_opacityTexture",
    "standard.reflection2d": "_reflectionTexture",
    "standard.reflectionCube": "_reflectionCubeTexture",
} as const satisfies Record<(typeof EXPECTED_BINDINGS)[number][0], keyof StandardMaterialProps>;

beforeEach(() => {
    vi.clearAllMocks();
});

function inspect(material: StandardMaterialProps) {
    return inspectMaterialWithFamily(material, standardMaterialInspectionDescriptor);
}

function propertyValues(material: StandardMaterialProps): Record<string, MaterialInspectionPropertyValue | "absent" | "unsupported"> {
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

function cubeTexture(seed: number): CubeTexture {
    return {
        _texture: { seed } as unknown as GPUTexture,
        _view: { seed } as unknown as GPUTextureView,
        _sampler: { seed } as unknown as GPUSampler,
    } as CubeTexture;
}

function createScene(materials: readonly Material[]): {
    readonly scene: SceneContext;
    readonly rebuild: ReturnType<typeof vi.fn>;
    readonly frameGraphBuild: ReturnType<typeof vi.fn>;
} {
    const meshes = materials.map((material) => ({ material }) as Mesh);
    const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh) => ({ mesh, order: 0, isTransparent: false }) as Renderable);
    const frameGraphBuild = vi.fn();
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

async function setProperty(scope: MaterialInspectionMutationScope, material: StandardMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue) {
    return setMaterialInspectionPropertyWithFamily(scope, material, id, value, standardMaterialInspectionDescriptor);
}

async function setTexture(
    scope: MaterialInspectionMutationScope,
    material: StandardMaterialProps,
    id: MaterialTextureBindingId,
    mutation: { readonly direction: "assign" | "replace"; readonly texture: object } | { readonly direction: "clear" }
) {
    return setMaterialInspectionTextureWithFamily(scope, material, id, mutation, standardMaterialInspectionDescriptor);
}

describe("Standard material inspection matrix", () => {
    it("emits the complete approved property matrix and omits Babylon.js-only controls", () => {
        const material = createStandardMaterial();
        const snapshot = inspect(material);

        expect(snapshot.family).toBe("standard");
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
            "standard.backFaceCulling": true,
            "standard.disableLighting": false,
            "standard.alpha": 1,
            "standard.alphaCutOff": 0,
            "standard.diffuseColor": [1, 1, 1],
            "standard.specularColor": [1, 1, 1],
            "standard.emissiveColor": [0, 0, 0],
            "standard.ambientColor": [0, 0, 0],
            "standard.specularPower": 64,
            "standard.diffuseCoordIndex": 0,
            "standard.specularCoordIndex": 0,
            "standard.ambientCoordIndex": 0,
            "standard.lightmapCoordIndex": 1,
            "standard.bumpLevel": 1,
            "standard.ambientTexLevel": 1,
            "standard.lightmapLevel": 1,
            "standard.opacityLevel": 1,
            "standard.reflectionLevel": 1,
            "standard.reflectionCoordMode": 1,
            "standard.useLightmapAsShadowmap": false,
            "standard.opacityFromRGB": false,
            "standard.uvScale": [1, 1],
            "standard.uvOffset": [0, 0],
            "standard.stencil.compare": "absent",
            "standard.stencil.passOp": "absent",
            "standard.stencil.failOp": "absent",
            "standard.stencil.depthFailOp": "absent",
            "standard.stencil.readMask": "absent",
            "standard.stencil.writeMask": "absent",
        });

        const byId = new Map(snapshot.properties.map((entry) => [entry.id, entry]));
        expect(byId.get("standard.alpha")?.access).toMatchObject({ number: { finite: true } });
        expect(byId.get("standard.specularPower")?.access).toMatchObject({ number: { finite: true, min: 0 } });
        expect(byId.get("standard.diffuseCoordIndex")?.options).toEqual([
            { value: 0, label: "UV1" },
            { value: 1, label: "UV2" },
        ]);
        expect(byId.get("standard.reflectionCoordMode")?.options).toEqual([
            { value: 1, label: "Spherical" },
            { value: 2, label: "Planar" },
        ]);
        expect(byId.get("standard.stencil.readMask")?.access).toMatchObject({ number: { finite: true, integer: true, min: 0, max: 0xffffffff } });
        expect(snapshot.properties.map(({ id }) => id)).not.toEqual(
            expect.arrayContaining(["standard.refractionTexture", "standard.detailMap", "standard.wireframe", "standard.sideOrientation"])
        );
    });

    it("reports effective stencil defaults once the public state is present", () => {
        const material = createStandardMaterial();
        material.stencil = { compare: "equal", writeMask: 3 };

        const values = propertyValues(material);
        expect(values["standard.stencil.compare"]).toBe("equal");
        expect(values["standard.stencil.passOp"]).toBe("keep");
        expect(values["standard.stencil.failOp"]).toBe("keep");
        expect(values["standard.stencil.depthFailOp"]).toBe("keep");
        expect(values["standard.stencil.readMask"]).toBe(0xff);
        expect(values["standard.stencil.writeMask"]).toBe(3);
    });

    it("emits all nine bindings in canonical order with exact empty capabilities", () => {
        const bindings = inspect(createStandardMaterial()).textureBindings;

        expect(bindings.map(({ id, label, acceptedKinds, viewCategory }) => [id, label, acceptedKinds[0], viewCategory])).toEqual(EXPECTED_BINDINGS);
        for (const binding of bindings) {
            expect(binding.value).toEqual({ state: "absent" });
            expect(binding.sampleCategory).toBe("float");
            expect(binding.directions).toEqual(["assign"]);
            expect(binding.mutation).toEqual({ access: "read-write", mutation: "R", postMutation: "rebuild-material", number: undefined });
            expect(binding.transform).toEqual({ state: "absent" });
        }
    });

    it("keeps 2D and cube reflection slots distinct and reports enabled transform values only where consumed", () => {
        const material = createStandardMaterial();
        const textures = EXPECTED_BINDINGS.map(([, , kind], index) => (kind === "cube" ? cubeTexture(index) : texture2d(index)));
        for (let index = 0; index < EXPECTED_BINDINGS.length; index++) {
            const id = EXPECTED_BINDINGS[index]![0];
            material[BINDING_FIELDS[id]] = textures[index] as never;
        }
        const diffuse = textures[0] as Texture2D;
        diffuse.uScale = 2;
        diffuse.vScale = 3;
        diffuse.uOffset = 0.25;
        diffuse.vOffset = -0.5;
        diffuse.uAng = 0.75;
        material._hasUvTx = true;

        const bindings = inspect(material).textureBindings;
        expect(bindings.map((binding) => binding.value)).toEqual(
            textures.map((texture, index) => ({
                state: "present",
                value: { entity: texture, kind: EXPECTED_BINDINGS[index]![2] },
            }))
        );
        expect(bindings.every((binding) => binding.directions.join(",") === "replace,clear,navigate")).toBe(true);
        expect(bindings[0]!.transform).toEqual({
            state: "present",
            value: { uScale: 2, vScale: 3, uOffset: 0.25, vOffset: -0.5, uAng: 0.75 },
        });
        for (const binding of bindings.slice(1, 7)) {
            expect(binding.transform).toEqual({
                state: "present",
                value: { uScale: 1, vScale: 1, uOffset: 0, vOffset: 0, uAng: 0 },
            });
        }
        expect(bindings[7]!.transform).toMatchObject({ state: "unsupported" });
        expect(bindings[8]!.transform).toMatchObject({ state: "unsupported" });

        material._hasUvTx = false;
        expect(
            inspect(material)
                .textureBindings.slice(0, 7)
                .every((binding) => binding.transform.state === "unsupported")
        ).toBe(true);
    });

    it("has no static feature-fragment imports, registrations, or eager collections", () => {
        const source = readFileSync(resolve(__dirname, "../../../packages/babylon-lite/src/inspection/standard-material-inspection.ts"), "utf-8");
        expect(source).not.toMatch(/^import .*\/fragments\//m);
        expect(source).not.toMatch(/\b_registerStdExt\s*\(/);
        expect(source).not.toMatch(/\bnew (?:Map|Set|WeakMap)\s*\(/);
    });
});

describe("Standard material property mutation", () => {
    it("routes every U property through the common one-mark path and preserves tuple isolation", async () => {
        const material = createStandardMaterial();
        material.alpha = 0.8;
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue, () => unknown][] = [
            ["standard.alpha", 0.5, () => material.alpha],
            ["standard.alphaCutOff", 0.25, () => material.alphaCutOff],
            ["standard.diffuseColor", [0.1, 0.2, 0.3], () => material.diffuseColor],
            ["standard.specularColor", [0.2, 0.3, 0.4], () => material.specularColor],
            ["standard.emissiveColor", [0.3, 0.4, 0.5], () => material.emissiveColor],
            ["standard.ambientColor", [0.4, 0.5, 0.6], () => material.ambientColor],
            ["standard.specularPower", 32, () => material.specularPower],
            ["standard.bumpLevel", 0.75, () => material.bumpLevel],
            ["standard.ambientTexLevel", 0.5, () => material.ambientTexLevel],
            ["standard.lightmapLevel", 0.25, () => material.lightmapLevel],
            ["standard.opacityLevel", 0.8, () => material.opacityLevel],
            ["standard.reflectionLevel", 0.6, () => material.reflectionLevel],
            ["standard.reflectionCoordMode", 2, () => material.reflectionCoordMode],
        ];

        for (const [id, value, read] of mutations) {
            const before = material._uboVersion;
            await expect(setProperty({ scenes: [] }, material, id, value)).resolves.toMatchObject({ changed: true, mutation: "U", postMutation: "none" });
            expect(material._uboVersion).toBe(before + 1);
            expect(read()).toEqual(value);
            if (Array.isArray(value)) {
                expect(read()).not.toBe(value);
            }
        }

        const before = material._uboVersion;
        await expect(setProperty({ scenes: [] }, material, "standard.reflectionLevel", material.reflectionLevel)).resolves.toEqual({
            changed: false,
            mutation: "U",
            postMutation: "none",
        });
        expect(material._uboVersion).toBe(before);
    });

    it("uses the alpha feature predicate for U/R and rebuilds every explicit owning scene and view", async () => {
        const material = createStandardMaterial();
        const view = createMaterialView(material, { features: 0 });
        const first = createScene([material, view]);
        const second = createScene([view]);

        await expect(setProperty({ scenes: [first.scene, first.scene, second.scene] }, material, "standard.alpha", 0.5)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(first.rebuild).toHaveBeenCalledTimes(2);
        expect(second.rebuild).toHaveBeenCalledOnce();
        expect(material._uboVersion).toBe(0);

        await expect(setProperty({ scenes: [] }, material, "standard.alpha", 0.25)).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(material._uboVersion).toBe(1);

        await expect(setProperty({ scenes: [first.scene, second.scene] }, material, "standard.alpha", 1)).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(first.rebuild).toHaveBeenCalledTimes(4);
        expect(second.rebuild).toHaveBeenCalledTimes(2);

        await expect(setProperty({ scenes: [] }, material, "standard.alpha", 2)).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(material._uboVersion).toBe(2);
    });

    it("applies every R property and enables UV offset and stencil only through public enablers", async () => {
        const material = createStandardMaterial();
        const { scene, rebuild } = createScene([material]);
        const mutations: readonly [MaterialInspectionPropertyId, MaterialInspectionPropertyValue, () => unknown][] = [
            ["standard.backFaceCulling", false, () => material.backFaceCulling],
            ["standard.disableLighting", true, () => material.disableLighting],
            ["standard.diffuseCoordIndex", 1, () => material.diffuseCoordIndex],
            ["standard.specularCoordIndex", 1, () => material.specularCoordIndex],
            ["standard.ambientCoordIndex", 1, () => material.ambientCoordIndex],
            ["standard.lightmapCoordIndex", 0, () => material.lightmapCoordIndex],
            ["standard.useLightmapAsShadowmap", true, () => material.useLightmapAsShadowmap],
            ["standard.opacityFromRGB", true, () => material.opacityFromRGB],
            ["standard.uvScale", [2, 3], () => material.uvScale],
            ["standard.uvOffset", [0.25, -0.5], () => material.uvOffset],
            ["standard.stencil.compare", "equal", () => material.stencil?.compare],
            ["standard.stencil.passOp", "replace", () => material.stencil?.passOp],
            ["standard.stencil.failOp", "zero", () => material.stencil?.failOp],
            ["standard.stencil.depthFailOp", "invert", () => material.stencil?.depthFailOp],
            ["standard.stencil.readMask", 0x0f, () => material.stencil?.readMask],
            ["standard.stencil.writeMask", 0xf0, () => material.stencil?.writeMask],
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
        expect(standardApis.enableUvOffset).toHaveBeenCalledOnce();
        expect(standardApis.enableStencil).toHaveBeenCalledTimes(6);
        expect(material._uboVersion).toBe(0);

        await expect(setProperty({ scenes: [scene] }, material, "standard.backFaceCulling", material.backFaceCulling)).resolves.toEqual({
            changed: false,
            mutation: "R",
            postMutation: "none",
        });
        expect(rebuild).toHaveBeenCalledTimes(mutations.length);
    });

    it("rejects invalid finite, range, enum, tuple, and stencil-mask values before mutation", async () => {
        const material = createStandardMaterial();
        const { scene, rebuild } = createScene([material]);
        const invalid: readonly [MaterialInspectionPropertyId, unknown, RegExp][] = [
            ["standard.alpha", Number.NaN, /finite/],
            ["standard.alphaCutOff", Number.POSITIVE_INFINITY, /finite/],
            ["standard.specularPower", -1, /at least 0/],
            ["standard.diffuseCoordIndex", 2, /enum value/],
            ["standard.reflectionCoordMode", 0, /enum value/],
            ["standard.diffuseColor", [1, 2], /3-component/],
            ["standard.uvScale", [1, Number.NaN], /finite tuple/],
            ["standard.stencil.compare", "invalid", /enum value/],
            ["standard.stencil.readMask", 1.5, /integer/],
            ["standard.stencil.readMask", -1, /at least 0/],
            ["standard.stencil.writeMask", 0x1_0000_0000, /at most/],
        ];

        for (const [id, value, message] of invalid) {
            await expect(setProperty({ scenes: [scene] }, material, id, value as MaterialInspectionPropertyValue)).rejects.toThrow(message);
        }

        expect(rebuild).not.toHaveBeenCalled();
        expect(standardApis.enableStencil).not.toHaveBeenCalled();
        expect(standardApis.enableUvOffset).not.toHaveBeenCalled();
        expect(material._uboVersion).toBe(0);
    });

    it("leaves stencil state untouched when public enablement fails", async () => {
        const material = createStandardMaterial();
        const { scene, rebuild } = createScene([material]);
        standardApis.enableStencil.mockImplementationOnce(() => {
            throw new Error("stencil enable failed");
        });

        await expect(setProperty({ scenes: [scene] }, material, "standard.stencil.compare", "equal")).rejects.toThrow("stencil enable failed");
        expect(material.stencil).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
    });
});

describe("Standard material texture mutation", () => {
    it("supports assignment, replacement, navigation, and clearing for every canonical slot", async () => {
        for (let index = 0; index < EXPECTED_BINDINGS.length; index++) {
            const [id, , kind] = EXPECTED_BINDINGS[index]!;
            const material = createStandardMaterial();
            const { scene, rebuild } = createScene([material]);
            const first = kind === "cube" ? cubeTexture(index * 2) : texture2d(index * 2);
            const second = kind === "cube" ? cubeTexture(index * 2 + 1) : texture2d(index * 2 + 1);
            const field = BINDING_FIELDS[id];

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
            expect(material[field]).toBeNull();
            expect(rebuild).toHaveBeenCalledTimes(3);

            const setter = standardApis.setters[id as keyof typeof standardApis.setters];
            if (setter) {
                expect(setter).toHaveBeenNthCalledWith(1, material, first);
                expect(setter).toHaveBeenNthCalledWith(2, material, second);
                expect(setter).toHaveBeenNthCalledWith(3, material, null);
            }
        }
    });

    it("rejects cube, 2D, and malformed type mismatches before a setter or rebuild", async () => {
        const material = createStandardMaterial();
        const { scene, rebuild } = createScene([material]);
        const twoD = texture2d(1);
        const cube = cubeTexture(2);

        await expect(setTexture({ scenes: [scene] }, material, "standard.diffuse", { direction: "assign", texture: cube })).rejects.toThrow(/Texture2D/);
        await expect(setTexture({ scenes: [scene] }, material, "standard.reflectionCube", { direction: "assign", texture: twoD })).rejects.toThrow(/CubeTexture/);
        await expect(setTexture({ scenes: [scene] }, material, "standard.emissive", { direction: "assign", texture: {} })).rejects.toThrow(/Texture2D/);

        expect(material.diffuseTexture).toBeNull();
        expect(material._reflectionCubeTexture).toBeUndefined();
        expect(material._emissiveTexture).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
        expect(Object.values(standardApis.setters).every((setter) => setter.mock.calls.length === 0)).toBe(true);
    });

    it("rejects unsupported mutation directions with zero source mutation", async () => {
        const material = createStandardMaterial();
        const current = texture2d(1);
        material.diffuseTexture = current;
        const { scene, rebuild } = createScene([material]);

        await expect(setTexture({ scenes: [scene] }, material, "standard.emissive", { direction: "replace", texture: texture2d(2) })).rejects.toThrow(/does not support/);
        await expect(setTexture({ scenes: [scene] }, material, "standard.opacity", { direction: "clear" })).rejects.toThrow(/does not support/);
        await expect(setTexture({ scenes: [scene] }, material, "standard.diffuse", { direction: "assign", texture: texture2d(3) })).rejects.toThrow(/does not support/);

        expect(material.diffuseTexture).toBe(current);
        expect(material._emissiveTexture).toBeUndefined();
        expect(material._opacityTexture).toBeUndefined();
        expect(rebuild).not.toHaveBeenCalled();
        expect(Object.values(standardApis.setters).every((setter) => setter.mock.calls.length === 0)).toBe(true);
    });
});
