import type { Material, StencilState } from "../material/material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { CubeTexture } from "../texture/cube-texture.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type {
    InspectionNumberConstraint,
    InspectionValue,
    MaterialInspectionAccess,
    MaterialInspectionProperty,
    MaterialInspectionPropertyId,
    MaterialInspectionPropertyValue,
    MaterialTextureBinding,
    MaterialTextureBindingId,
    MaterialTextureMutation,
    TextureInspectionTransform,
} from "./inspection-types.js";
import type { MaterialInspectionFamilyDescriptor, MaterialInspectionMutationPlan } from "./material-inspection.js";

const UV_OPTIONS = [
    { value: 0, label: "UV1" },
    { value: 1, label: "UV2" },
] as const;

const REFLECTION_COORD_OPTIONS = [
    { value: 1, label: "Spherical" },
    { value: 2, label: "Planar" },
] as const;

const STENCIL_COMPARE_OPTIONS = [
    { value: "never", label: "Never" },
    { value: "less", label: "Less" },
    { value: "equal", label: "Equal" },
    { value: "less-equal", label: "Less or Equal" },
    { value: "greater", label: "Greater" },
    { value: "not-equal", label: "Not Equal" },
    { value: "greater-equal", label: "Greater or Equal" },
    { value: "always", label: "Always" },
] as const;

const STENCIL_OPERATION_OPTIONS = [
    { value: "keep", label: "Keep" },
    { value: "zero", label: "Zero" },
    { value: "replace", label: "Replace" },
    { value: "invert", label: "Invert" },
    { value: "increment-clamp", label: "Increment Clamp" },
    { value: "decrement-clamp", label: "Decrement Clamp" },
    { value: "increment-wrap", label: "Increment Wrap" },
    { value: "decrement-wrap", label: "Decrement Wrap" },
] as const;

const FINITE_NUMBER = { finite: true } as const;
const NON_NEGATIVE_NUMBER = { finite: true, min: 0 } as const;
const STENCIL_MASK = { finite: true, integer: true, min: 0, max: 0xffffffff } as const;

const STANDARD_BINDINGS: readonly {
    readonly id: MaterialTextureBindingId;
    readonly label: string;
    readonly field:
        | "diffuseTexture"
        | "_emissiveTexture"
        | "_bumpTexture"
        | "_specularTexture"
        | "_ambientTexture"
        | "_lightmapTexture"
        | "_opacityTexture"
        | "_reflectionTexture"
        | "_reflectionCubeTexture";
    readonly kind: "2d" | "cube";
    readonly supportsTransform: boolean;
}[] = [
    { id: "standard.diffuse", label: "Diffuse Texture", field: "diffuseTexture", kind: "2d", supportsTransform: true },
    { id: "standard.emissive", label: "Emissive Texture", field: "_emissiveTexture", kind: "2d", supportsTransform: true },
    { id: "standard.bump", label: "Bump Texture", field: "_bumpTexture", kind: "2d", supportsTransform: true },
    { id: "standard.specular", label: "Specular Texture", field: "_specularTexture", kind: "2d", supportsTransform: true },
    { id: "standard.ambient", label: "Ambient Texture", field: "_ambientTexture", kind: "2d", supportsTransform: true },
    { id: "standard.lightmap", label: "Lightmap Texture", field: "_lightmapTexture", kind: "2d", supportsTransform: true },
    { id: "standard.opacity", label: "Opacity Texture", field: "_opacityTexture", kind: "2d", supportsTransform: true },
    { id: "standard.reflection2d", label: "Reflection Texture", field: "_reflectionTexture", kind: "2d", supportsTransform: false },
    { id: "standard.reflectionCube", label: "Reflection Cube Texture", field: "_reflectionCubeTexture", kind: "cube", supportsTransform: false },
];

/** @internal Side-effect-free Standard family descriptor. Dispatcher wiring is owned by the family convergence task. */
export const standardMaterialInspectionDescriptor: MaterialInspectionFamilyDescriptor = {
    inspect: inspectStandardMaterial,
    preparePropertyMutation: prepareStandardPropertyMutation,
    prepareTextureMutation: prepareStandardTextureMutation,
};

function inspectStandardMaterial(source: Material) {
    const material = source as StandardMaterialProps;
    return {
        properties: createStandardProperties(material),
        textureBindings: STANDARD_BINDINGS.map((binding) => createStandardBinding(material, binding)),
    };
}

function createStandardProperties(material: StandardMaterialProps): MaterialInspectionProperty[] {
    return [
        property("standard.backFaceCulling", "general", "Back Face Culling", "boolean", material.backFaceCulling, edit("R", "rebuild-material")),
        property("standard.disableLighting", "general", "Disable Lighting", "boolean", material.disableLighting, edit("R", "rebuild-material")),
        property("standard.alpha", "transparency", "Alpha", "number", material.alpha, edit("U/R", "rebuild-material", FINITE_NUMBER)),
        property("standard.alphaCutOff", "transparency", "Alpha Cutoff", "number", material.alphaCutOff, edit("U", "none", FINITE_NUMBER)),
        property("standard.diffuseColor", "lighting-colors", "Diffuse Color", "vec3", material.diffuseColor, edit("U", "none")),
        property("standard.specularColor", "lighting-colors", "Specular Color", "vec3", material.specularColor, edit("U", "none")),
        property("standard.emissiveColor", "lighting-colors", "Emissive Color", "vec3", material.emissiveColor, edit("U", "none")),
        property("standard.ambientColor", "lighting-colors", "Ambient Color", "vec3", material.ambientColor, edit("U", "none")),
        property("standard.specularPower", "lighting-colors", "Specular Power", "number", material.specularPower, edit("U", "none", NON_NEGATIVE_NUMBER)),
        enumProperty("standard.diffuseCoordIndex", "Diffuse Coordinates", material.diffuseCoordIndex, UV_OPTIONS, "R"),
        enumProperty("standard.specularCoordIndex", "Specular Coordinates", material.specularCoordIndex, UV_OPTIONS, "R"),
        enumProperty("standard.ambientCoordIndex", "Ambient Coordinates", material.ambientCoordIndex, UV_OPTIONS, "R"),
        enumProperty("standard.lightmapCoordIndex", "Lightmap Coordinates", material.lightmapCoordIndex, UV_OPTIONS, "R"),
        property("standard.bumpLevel", "texture-settings", "Bump Level", "number", material.bumpLevel, edit("U", "none", FINITE_NUMBER)),
        property("standard.ambientTexLevel", "texture-settings", "Ambient Texture Level", "number", material.ambientTexLevel, edit("U", "none", FINITE_NUMBER)),
        property("standard.lightmapLevel", "texture-settings", "Lightmap Level", "number", material.lightmapLevel, edit("U", "none", FINITE_NUMBER)),
        property("standard.opacityLevel", "texture-settings", "Opacity Level", "number", material.opacityLevel, edit("U", "none", FINITE_NUMBER)),
        property("standard.reflectionLevel", "texture-settings", "Reflection Level", "number", material.reflectionLevel, edit("U", "none", FINITE_NUMBER)),
        {
            ...property("standard.reflectionCoordMode", "texture-settings", "Reflection Coordinates", "enum", material.reflectionCoordMode, edit("U", "none")),
            options: REFLECTION_COORD_OPTIONS,
        },
        property("standard.useLightmapAsShadowmap", "texture-settings", "Use Lightmap as Shadowmap", "boolean", material.useLightmapAsShadowmap, edit("R", "rebuild-material")),
        property("standard.opacityFromRGB", "texture-settings", "Opacity from RGB", "boolean", material.opacityFromRGB, edit("R", "rebuild-material")),
        property("standard.uvScale", "transform", "UV Scale", "vec2", material.uvScale, edit("R", "rebuild-material")),
        property("standard.uvOffset", "transform", "UV Offset", "vec2", material.uvOffset ?? [0, 0], edit("R", "rebuild-material")),
        stencilProperty("standard.stencil.compare", "Stencil Compare", material.stencil, material.stencil?.compare ?? "always", STENCIL_COMPARE_OPTIONS),
        stencilProperty("standard.stencil.passOp", "Stencil Pass Operation", material.stencil, material.stencil?.passOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilProperty("standard.stencil.failOp", "Stencil Fail Operation", material.stencil, material.stencil?.failOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilProperty("standard.stencil.depthFailOp", "Stencil Depth Fail Operation", material.stencil, material.stencil?.depthFailOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilNumberProperty("standard.stencil.readMask", "Stencil Read Mask", material.stencil, material.stencil?.readMask ?? 0xff),
        stencilNumberProperty("standard.stencil.writeMask", "Stencil Write Mask", material.stencil, material.stencil?.writeMask ?? 0xff),
    ];
}

function property(
    id: MaterialInspectionPropertyId,
    section: MaterialInspectionProperty["section"],
    label: string,
    valueType: MaterialInspectionProperty["valueType"],
    value: MaterialInspectionPropertyValue,
    access: MaterialInspectionAccess
): MaterialInspectionProperty {
    return { id, section, label, valueType, value: { state: "present", value }, access };
}

function enumProperty(
    id: MaterialInspectionPropertyId,
    label: string,
    value: number,
    options: readonly { readonly value: number; readonly label: string }[],
    mutation: "R"
): MaterialInspectionProperty {
    return {
        ...property(id, "texture-settings", label, "enum", value, edit(mutation, "rebuild-material")),
        options,
    };
}

function stencilProperty(
    id: MaterialInspectionPropertyId,
    label: string,
    stencil: StencilState | undefined,
    value: string,
    options: readonly { readonly value: string; readonly label: string }[]
): MaterialInspectionProperty {
    return {
        id,
        section: "stencil",
        label,
        valueType: "enum",
        value: stencil ? { state: "present", value } : { state: "absent" },
        access: edit("R", "rebuild-material"),
        options,
    };
}

function stencilNumberProperty(id: MaterialInspectionPropertyId, label: string, stencil: StencilState | undefined, value: number): MaterialInspectionProperty {
    return {
        id,
        section: "stencil",
        label,
        valueType: "number",
        value: stencil ? { state: "present", value } : { state: "absent" },
        access: edit("R", "rebuild-material", STENCIL_MASK),
    };
}

function edit(mutation: "U" | "R" | "U/R", postMutation: "none" | "rebuild-material", number?: InspectionNumberConstraint): MaterialInspectionAccess {
    return { access: "read-write", mutation, postMutation, number };
}

function createStandardBinding(material: StandardMaterialProps, descriptor: (typeof STANDARD_BINDINGS)[number]): MaterialTextureBinding {
    const texture = material[descriptor.field];
    const present = texture != null;
    return {
        id: descriptor.id,
        label: descriptor.label,
        value: present ? { state: "present", value: { entity: texture, kind: descriptor.kind } } : { state: "absent" },
        acceptedKinds: [descriptor.kind],
        sampleCategory: "float",
        viewCategory: descriptor.kind,
        directions: present ? ["replace", "clear", "navigate"] : ["assign"],
        mutation: edit("R", "rebuild-material"),
        transform: createBindingTransform(material, descriptor, texture),
    };
}

function createBindingTransform(
    material: StandardMaterialProps,
    descriptor: (typeof STANDARD_BINDINGS)[number],
    texture: Texture2D | CubeTexture | null | undefined
): InspectionValue<TextureInspectionTransform> {
    if (!texture) {
        return { state: "absent" };
    }
    if (descriptor.kind !== "2d" || !descriptor.supportsTransform) {
        return { state: "unsupported", reason: `${descriptor.label} does not use Standard UV transforms.` };
    }
    if (!material._hasUvTx) {
        return { state: "unsupported", reason: "Per-texture UV transforms are not enabled for this material." };
    }
    const texture2d = texture as Texture2D;
    return {
        state: "present",
        value: {
            uScale: texture2d.uScale ?? 1,
            vScale: texture2d.vScale ?? 1,
            uOffset: texture2d.uOffset ?? 0,
            vOffset: texture2d.vOffset ?? 0,
            uAng: texture2d.uAng ?? 0,
        },
    };
}

function prepareStandardPropertyMutation(source: Material, property: MaterialInspectionProperty, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const material = source as StandardMaterialProps;
    switch (property.id) {
        case "standard.backFaceCulling":
            return rebuildPlan(() => {
                material.backFaceCulling = value as boolean;
            });
        case "standard.disableLighting":
            return rebuildPlan(() => {
                material.disableLighting = value as boolean;
            });
        case "standard.alpha": {
            const alpha = value as number;
            const mutation = material.alpha < 1 === alpha < 1 ? "U" : "R";
            return plan(mutation, () => {
                material.alpha = alpha;
            });
        }
        case "standard.alphaCutOff":
            return uniformPlan(() => {
                material.alphaCutOff = value as number;
            });
        case "standard.diffuseColor":
            return uniformPlan(() => {
                material.diffuseColor = value as [number, number, number];
            });
        case "standard.specularColor":
            return uniformPlan(() => {
                material.specularColor = value as [number, number, number];
            });
        case "standard.emissiveColor":
            return uniformPlan(() => {
                material.emissiveColor = value as [number, number, number];
            });
        case "standard.ambientColor":
            return uniformPlan(() => {
                material.ambientColor = value as [number, number, number];
            });
        case "standard.specularPower":
            return uniformPlan(() => {
                material.specularPower = value as number;
            });
        case "standard.diffuseCoordIndex":
            return rebuildPlan(() => {
                material.diffuseCoordIndex = value as 0 | 1;
            });
        case "standard.specularCoordIndex":
            return rebuildPlan(() => {
                material.specularCoordIndex = value as 0 | 1;
            });
        case "standard.ambientCoordIndex":
            return rebuildPlan(() => {
                material.ambientCoordIndex = value as 0 | 1;
            });
        case "standard.lightmapCoordIndex":
            return rebuildPlan(() => {
                material.lightmapCoordIndex = value as 0 | 1;
            });
        case "standard.bumpLevel":
            return uniformPlan(() => {
                material.bumpLevel = value as number;
            });
        case "standard.ambientTexLevel":
            return uniformPlan(() => {
                material.ambientTexLevel = value as number;
            });
        case "standard.lightmapLevel":
            return uniformPlan(() => {
                material.lightmapLevel = value as number;
            });
        case "standard.opacityLevel":
            return uniformPlan(() => {
                material.opacityLevel = value as number;
            });
        case "standard.reflectionLevel":
            return uniformPlan(() => {
                material.reflectionLevel = value as number;
            });
        case "standard.reflectionCoordMode":
            return uniformPlan(() => {
                material.reflectionCoordMode = value as 1 | 2;
            });
        case "standard.useLightmapAsShadowmap":
            return rebuildPlan(() => {
                material.useLightmapAsShadowmap = value as boolean;
            });
        case "standard.opacityFromRGB":
            return rebuildPlan(() => {
                material.opacityFromRGB = value as boolean;
            });
        case "standard.uvScale":
            return rebuildPlan(() => {
                material.uvScale = value as [number, number];
            });
        case "standard.uvOffset":
            return rebuildPlan(async () => {
                const { enableStandardUvOffset } = await import("../material/standard/enable-standard-mesh-features.js");
                enableStandardUvOffset();
                material.uvOffset = value as [number, number];
            });
        case "standard.stencil.compare":
            return stencilPlan(material, { compare: value as GPUCompareFunction });
        case "standard.stencil.passOp":
            return stencilPlan(material, { passOp: value as GPUStencilOperation });
        case "standard.stencil.failOp":
            return stencilPlan(material, { failOp: value as GPUStencilOperation });
        case "standard.stencil.depthFailOp":
            return stencilPlan(material, { depthFailOp: value as GPUStencilOperation });
        case "standard.stencil.readMask":
            return stencilPlan(material, { readMask: value as number });
        case "standard.stencil.writeMask":
            return stencilPlan(material, { writeMask: value as number });
        default:
            throw new Error(`Property "${property.id}" is stale or unsupported for a Standard material.`);
    }
}

function prepareStandardTextureMutation(source: Material, binding: MaterialTextureBinding, mutation: MaterialTextureMutation): MaterialInspectionMutationPlan {
    const material = source as StandardMaterialProps;
    const texture = mutation.direction === "clear" ? null : mutation.texture;
    const expectedKind = binding.id === "standard.reflectionCube" ? "cube" : "2d";
    if (texture && !matchesTextureKind(texture, expectedKind)) {
        throw new TypeError(`Texture binding "${binding.id}" requires a ${expectedKind === "cube" ? "CubeTexture" : "Texture2D"} value.`);
    }
    return rebuildPlan(() => setStandardTexture(material, binding.id, texture as Texture2D | CubeTexture | null));
}

async function setStandardTexture(material: StandardMaterialProps, binding: MaterialTextureBindingId, texture: Texture2D | CubeTexture | null): Promise<void> {
    switch (binding) {
        case "standard.diffuse":
            material.diffuseTexture = texture as Texture2D | null;
            return;
        case "standard.emissive": {
            const { setStandardEmissiveTexture } = await import("../material/standard/set-std-emissive.js");
            setStandardEmissiveTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.bump": {
            const { setStandardBumpTexture } = await import("../material/standard/set-std-bump.js");
            setStandardBumpTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.specular": {
            const { setStandardSpecularTexture } = await import("../material/standard/set-std-specular.js");
            setStandardSpecularTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.ambient": {
            const { setStandardAmbientTexture } = await import("../material/standard/set-std-ambient.js");
            setStandardAmbientTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.lightmap": {
            const { setStandardLightmapTexture } = await import("../material/standard/set-std-lightmap.js");
            setStandardLightmapTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.opacity": {
            const { setStandardOpacityTexture } = await import("../material/standard/set-std-opacity.js");
            setStandardOpacityTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.reflection2d": {
            const { setStandardReflectionTexture } = await import("../material/standard/set-std-reflection.js");
            setStandardReflectionTexture(material, texture as Texture2D | null);
            return;
        }
        case "standard.reflectionCube": {
            const { setStandardReflectionCubeTexture } = await import("../material/standard/set-std-cube-reflection.js");
            setStandardReflectionCubeTexture(material, texture as CubeTexture | null);
            return;
        }
        default:
            throw new Error(`Texture binding "${binding}" is stale or unsupported for a Standard material.`);
    }
}

function stencilPlan(material: StandardMaterialProps, update: StencilState): MaterialInspectionMutationPlan {
    const current = material.stencil;
    return rebuildPlan(async () => {
        const { enableMaterialStencil } = await import("../material/enable-material-stencil.js");
        enableMaterialStencil();
        material.stencil = { ...current, ...update };
    });
}

function uniformPlan(apply: () => void): MaterialInspectionMutationPlan {
    return plan("U", apply);
}

function rebuildPlan(apply: () => void | Promise<void>): MaterialInspectionMutationPlan {
    return plan("R", apply);
}

function plan(mutation: "U" | "R", apply: () => void | Promise<void>): MaterialInspectionMutationPlan {
    return { mutation, apply };
}

function matchesTextureKind(texture: object, kind: "2d" | "cube"): boolean {
    try {
        const candidate = texture as Record<string, unknown>;
        const is2d =
            "texture" in candidate &&
            "view" in candidate &&
            "sampler" in candidate &&
            typeof candidate.width === "number" &&
            Number.isFinite(candidate.width) &&
            typeof candidate.height === "number" &&
            Number.isFinite(candidate.height);
        const isCube = "_texture" in candidate && "_view" in candidate && "_sampler" in candidate;
        return kind === "2d" ? is2d && !isCube : isCube && !is2d;
    } catch {
        return false;
    }
}
