import type { Material, StencilState } from "../material/material.js";
import { _computePbrMaterialFeatures } from "../material/pbr/pbr-material-features.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
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
const UNIT_INTERVAL = { finite: true, min: 0, max: 1 } as const;
const STENCIL_MASK = { finite: true, integer: true, min: 0, max: 0xffffffff } as const;

const PBR_BINDINGS: readonly {
    readonly id: MaterialTextureBindingId;
    readonly label: string;
    readonly field: "baseColorTexture" | "normalTexture" | "ormTexture" | "occlusionTexture" | "emissiveTexture" | "specGlossTexture";
}[] = [
    { id: "pbr.baseColor", label: "Base Color Texture", field: "baseColorTexture" },
    { id: "pbr.normal", label: "Normal Texture", field: "normalTexture" },
    { id: "pbr.orm", label: "ORM Texture", field: "ormTexture" },
    { id: "pbr.occlusion", label: "Occlusion Texture", field: "occlusionTexture" },
    { id: "pbr.emissive", label: "Emissive Texture", field: "emissiveTexture" },
    { id: "pbr.specGloss", label: "Specular-Glossiness Texture", field: "specGlossTexture" },
];

interface PbrCoreFeatureSignature {
    readonly features: number;
    readonly features2: number;
    readonly bindingMask: number;
    readonly uv2Mask: number;
    readonly occlusionTexCoord: number;
    readonly alphaBlend: boolean;
    readonly alphaTest: boolean;
    readonly baseColorFactor: boolean;
    readonly emissiveColor: boolean;
    readonly uvTransform: boolean;
}

/** @internal Side-effect-free PBR core descriptor. Optional PBR families and dispatcher wiring are owned by later tasks. */
export const pbrMaterialInspectionDescriptor: MaterialInspectionFamilyDescriptor = {
    inspect: inspectPbrMaterial,
    preparePropertyMutation: preparePbrPropertyMutation,
    prepareTextureMutation: preparePbrTextureMutation,
};

function inspectPbrMaterial(source: Material) {
    const material = source as PbrMaterialProps;
    return {
        properties: createPbrProperties(material),
        textureBindings: PBR_BINDINGS.map((binding) => createPbrBinding(material, binding)),
    };
}

function createPbrProperties(material: PbrMaterialProps): MaterialInspectionProperty[] {
    return [
        property("pbr.doubleSided", "general", "Double Sided", "boolean", material.doubleSided ?? false, edit("R", "rebuild-material")),
        property("pbr.alphaBlend", "general", "Alpha Blend", "boolean", material.alphaBlend ?? false, edit("R", "rebuild-material")),
        property("pbr.enableSpecularAA", "general", "Specular Anti-Aliasing", "boolean", material.enableSpecularAA ?? false, edit("R", "rebuild-material")),
        property("pbr.alpha", "transparency", "Alpha", "number", material.alpha ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        optionalProperty("pbr.alphaCutOff", "transparency", "Alpha Cutoff", "number", material._alphaCutOff, edit("U/R", "rebuild-material", FINITE_NUMBER)),
        optionalProperty("pbr.baseColorFactor", "lighting-colors", "Base Color Factor", "vec4", material.baseColorFactor, edit("U/R", "rebuild-material")),
        optionalProperty("pbr.emissiveColor", "lighting-colors", "Emissive Color", "vec3", material._emissiveColor, edit("U/R", "rebuild-material")),
        property("pbr.environmentIntensity", "lighting-colors", "Environment Intensity", "number", material.environmentIntensity ?? 1, edit("U", "none", FINITE_NUMBER)),
        property("pbr.directIntensity", "lighting-colors", "Direct Intensity", "number", material.directIntensity ?? 1, edit("U", "none", FINITE_NUMBER)),
        property("pbr.reflectance", "lighting-colors", "Reflectance", "number", material.reflectance ?? 0.04, edit("U", "none", FINITE_NUMBER)),
        property("pbr.metallicFactor", "lighting-colors", "Metallic Factor", "number", material.metallicFactor ?? 1, edit("U", "none", FINITE_NUMBER)),
        property("pbr.roughnessFactor", "lighting-colors", "Roughness Factor", "number", material.roughnessFactor ?? 1, edit("U", "none", FINITE_NUMBER)),
        property("pbr.normalTextureScale", "lighting-colors", "Normal Texture Scale", "number", material.normalTextureScale ?? 1, edit("U", "none", FINITE_NUMBER)),
        property("pbr.usePhysicalLightFalloff", "lighting-colors", "Use Physical Light Falloff", "boolean", material.usePhysicalLightFalloff ?? true, edit("U", "none")),
        property("pbr.occlusionStrength", "occlusion", "Occlusion Strength", "number", material.occlusionStrength ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        {
            ...property("pbr.occlusionTexCoord", "occlusion", "Occlusion Coordinates", "enum", material.occlusionTexCoord ?? 0, {
                access: "read-only",
                reason: "Changing the occlusion UV set requires a public setter that maintains the UV2 claim.",
            }),
            options: [
                { value: 0, label: "UV1" },
                { value: 1, label: "UV2" },
            ],
        },
        stencilProperty("pbr.stencil.compare", "Stencil Compare", material.stencil, material.stencil?.compare ?? "always", STENCIL_COMPARE_OPTIONS),
        stencilProperty("pbr.stencil.passOp", "Stencil Pass Operation", material.stencil, material.stencil?.passOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilProperty("pbr.stencil.failOp", "Stencil Fail Operation", material.stencil, material.stencil?.failOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilProperty("pbr.stencil.depthFailOp", "Stencil Depth Fail Operation", material.stencil, material.stencil?.depthFailOp ?? "keep", STENCIL_OPERATION_OPTIONS),
        stencilNumberProperty("pbr.stencil.readMask", "Stencil Read Mask", material.stencil, material.stencil?.readMask ?? 0xff),
        stencilNumberProperty("pbr.stencil.writeMask", "Stencil Write Mask", material.stencil, material.stencil?.writeMask ?? 0xff),
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

function optionalProperty(
    id: MaterialInspectionPropertyId,
    section: MaterialInspectionProperty["section"],
    label: string,
    valueType: MaterialInspectionProperty["valueType"],
    value: MaterialInspectionPropertyValue | undefined,
    access: MaterialInspectionAccess
): MaterialInspectionProperty {
    return { id, section, label, valueType, value: value === undefined ? { state: "absent" } : { state: "present", value }, access };
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

function createPbrBinding(material: PbrMaterialProps, descriptor: (typeof PBR_BINDINGS)[number]): MaterialTextureBinding {
    const texture = material[descriptor.field];
    const present = texture != null;
    return {
        id: descriptor.id,
        label: descriptor.label,
        value: present ? { state: "present", value: { entity: texture, kind: "2d" } } : { state: "absent" },
        acceptedKinds: ["2d"],
        sampleCategory: "float",
        viewCategory: "2d",
        directions: present ? ["replace", "clear", "navigate"] : ["assign"],
        mutation: edit("R", "rebuild-material"),
        transform: createBindingTransform(material, texture),
    };
}

function createBindingTransform(material: PbrMaterialProps, texture: Texture2D | null | undefined): InspectionValue<TextureInspectionTransform> {
    if (!texture) {
        return { state: "absent" };
    }
    if (!material._hasUvTx) {
        return { state: "unsupported", reason: "Per-texture UV transforms are not enabled for this material." };
    }
    return {
        state: "present",
        value: {
            uScale: texture.uScale ?? 1,
            vScale: texture.vScale ?? 1,
            uOffset: texture.uOffset ?? 0,
            vOffset: texture.vOffset ?? 0,
            uAng: texture.uAng ?? 0,
        },
    };
}

function preparePbrPropertyMutation(source: Material, property: MaterialInspectionProperty, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const material = source as PbrMaterialProps;
    switch (property.id) {
        case "pbr.doubleSided":
            return rebuildPlan(() => {
                material.doubleSided = value as boolean;
            });
        case "pbr.alphaBlend":
            return rebuildPlan(() => {
                material.alphaBlend = value as boolean;
            });
        case "pbr.enableSpecularAA":
            return rebuildPlan(() => {
                material.enableSpecularAA = value as boolean;
            });
        case "pbr.alpha":
            return featurePlan(material, { alpha: value as number }, () => {
                material.alpha = value as number;
            });
        case "pbr.alphaCutOff":
            return featurePlan(material, { _alphaCutOff: value as number }, async () => {
                const { setPbrAlphaCutoff } = await import("../material/pbr/set-alpha-cutoff.js");
                setPbrAlphaCutoff(material, value as number);
            });
        case "pbr.baseColorFactor": {
            const factor = value as [number, number, number, number];
            return featurePlan(material, { baseColorFactor: factor }, () => {
                material.baseColorFactor = factor;
            });
        }
        case "pbr.emissiveColor": {
            const color = value as [number, number, number];
            return featurePlan(material, { _emissiveColor: color }, async () => {
                const { setPbrEmissive } = await import("../material/pbr/set-emissive.js");
                setPbrEmissive(material, color);
            });
        }
        case "pbr.environmentIntensity":
            return uniformPlan(() => {
                material.environmentIntensity = value as number;
            });
        case "pbr.directIntensity":
            return uniformPlan(() => {
                material.directIntensity = value as number;
            });
        case "pbr.reflectance":
            return uniformPlan(() => {
                material.reflectance = value as number;
            });
        case "pbr.metallicFactor":
            return uniformPlan(() => {
                material.metallicFactor = value as number;
            });
        case "pbr.roughnessFactor":
            return uniformPlan(() => {
                material.roughnessFactor = value as number;
            });
        case "pbr.normalTextureScale":
            return uniformPlan(() => {
                material.normalTextureScale = value as number;
            });
        case "pbr.usePhysicalLightFalloff":
            return uniformPlan(() => {
                material.usePhysicalLightFalloff = value as boolean;
            });
        case "pbr.occlusionStrength":
            return featurePlan(material, { occlusionStrength: value as number }, () => {
                material.occlusionStrength = value as number;
            });
        case "pbr.stencil.compare":
            return stencilPlan(material, { compare: value as GPUCompareFunction });
        case "pbr.stencil.passOp":
            return stencilPlan(material, { passOp: value as GPUStencilOperation });
        case "pbr.stencil.failOp":
            return stencilPlan(material, { failOp: value as GPUStencilOperation });
        case "pbr.stencil.depthFailOp":
            return stencilPlan(material, { depthFailOp: value as GPUStencilOperation });
        case "pbr.stencil.readMask":
            return stencilPlan(material, { readMask: value as number });
        case "pbr.stencil.writeMask":
            return stencilPlan(material, { writeMask: value as number });
        default:
            throw new Error(`Property "${property.id}" is stale, read-only, or unsupported for a PBR material.`);
    }
}

function preparePbrTextureMutation(source: Material, binding: MaterialTextureBinding, mutation: MaterialTextureMutation): MaterialInspectionMutationPlan {
    const material = source as PbrMaterialProps;
    const texture = mutation.direction === "clear" ? null : mutation.texture;
    if (texture && !matchesTexture2d(texture)) {
        throw new TypeError(`Texture binding "${binding.id}" requires a Texture2D value.`);
    }
    return rebuildPlan(() => {
        setPbrTexture(material, binding.id, texture as Texture2D | null);
    });
}

function setPbrTexture(material: PbrMaterialProps, binding: MaterialTextureBindingId, texture: Texture2D | null): void {
    switch (binding) {
        case "pbr.baseColor":
            material.baseColorTexture = texture ?? undefined;
            return;
        case "pbr.normal":
            material.normalTexture = texture ?? undefined;
            return;
        case "pbr.orm":
            material.ormTexture = texture ?? undefined;
            return;
        case "pbr.occlusion":
            material.occlusionTexture = texture ?? undefined;
            return;
        case "pbr.emissive":
            material.emissiveTexture = texture ?? undefined;
            return;
        case "pbr.specGloss":
            material.specGlossTexture = texture ?? undefined;
            return;
        default:
            throw new Error(`Texture binding "${binding}" is stale or unsupported for a PBR material.`);
    }
}

function featurePlan(material: PbrMaterialProps, patch: Partial<PbrMaterialProps>, apply: () => void | Promise<void>): MaterialInspectionMutationPlan {
    const before = createPbrCoreFeatureSignature(material);
    const after = createPbrCoreFeatureSignature({ ...material, ...patch });
    return plan(samePbrCoreFeatureSignature(before, after) ? "U" : "R", apply);
}

function createPbrCoreFeatureSignature(material: PbrMaterialProps): PbrCoreFeatureSignature {
    const computed = _computePbrMaterialFeatures(material);
    let bindingMask = 0;
    for (let index = 0; index < PBR_BINDINGS.length; index++) {
        if (material[PBR_BINDINGS[index]!.field]) {
            bindingMask |= 1 << index;
        }
    }
    const alpha = material.alpha ?? 1;
    const alphaCutOff = material._alphaCutOff ?? 0;
    return {
        features: computed.features,
        features2: computed.features2,
        bindingMask,
        uv2Mask: material._uv2Mask ?? 0,
        occlusionTexCoord: material.occlusionTexCoord ?? 0,
        alphaBlend: material.alphaBlend === true || (alphaCutOff <= 0 && alpha < 1),
        alphaTest: alphaCutOff > 0,
        baseColorFactor: material.baseColorFactor !== undefined,
        emissiveColor: material._emissiveColor !== undefined,
        uvTransform: material._hasUvTx === true,
    };
}

function samePbrCoreFeatureSignature(a: PbrCoreFeatureSignature, b: PbrCoreFeatureSignature): boolean {
    return (
        a.features === b.features &&
        a.features2 === b.features2 &&
        a.bindingMask === b.bindingMask &&
        a.uv2Mask === b.uv2Mask &&
        a.occlusionTexCoord === b.occlusionTexCoord &&
        a.alphaBlend === b.alphaBlend &&
        a.alphaTest === b.alphaTest &&
        a.baseColorFactor === b.baseColorFactor &&
        a.emissiveColor === b.emissiveColor &&
        a.uvTransform === b.uvTransform
    );
}

function stencilPlan(material: PbrMaterialProps, update: StencilState): MaterialInspectionMutationPlan {
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

function matchesTexture2d(texture: object): boolean {
    try {
        const candidate = texture as Record<string, unknown>;
        return (
            "texture" in candidate &&
            "view" in candidate &&
            "sampler" in candidate &&
            typeof candidate.width === "number" &&
            Number.isFinite(candidate.width) &&
            typeof candidate.height === "number" &&
            Number.isFinite(candidate.height) &&
            !("_texture" in candidate) &&
            !("_view" in candidate) &&
            !("_sampler" in candidate)
        );
    } catch {
        return false;
    }
}
