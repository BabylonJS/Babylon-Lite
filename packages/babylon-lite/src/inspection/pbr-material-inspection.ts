import type { Material, StencilState } from "../material/material.js";
import { _computePbrMaterialFeatures } from "../material/pbr/pbr-material-features.js";
import type {
    AnisotropyProps,
    ClearCoatProps,
    IridescenceProps,
    PbrMaterialProps,
    RefractionProps,
    SheenProps,
    SubSurfaceProps,
    ThicknessProps,
    TintProps,
    TranslucencyProps,
} from "../material/pbr/pbr-material.js";
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

interface MetallicReflectanceOptions {
    color?: [number, number, number];
    texture?: Texture2D;
    reflectanceTexture?: Texture2D;
    f0Factor?: number;
    specularWeight?: number;
    useOnlyMetallicFromTexture?: boolean;
}

interface PbrFeatureSignature {
    readonly core: PbrCoreFeatureSignature;
    readonly optional: readonly unknown[];
    readonly frameGraphParticipation: boolean;
}

/** @internal Side-effect-free PBR descriptor. Optional setters are imported only by requested mutations. */
export const pbrMaterialInspectionDescriptor: MaterialInspectionFamilyDescriptor = {
    inspect: inspectPbrMaterial,
    preparePropertyMutation: preparePbrPropertyMutation,
    prepareTextureMutation: preparePbrTextureMutation,
};

function inspectPbrMaterial(source: Material) {
    const material = source as PbrMaterialProps;
    return {
        properties: createPbrProperties(material),
        textureBindings: createPbrBindings(material),
    };
}

function createPbrProperties(material: PbrMaterialProps): MaterialInspectionProperty[] {
    const properties: MaterialInspectionProperty[] = [
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
    appendLightmapProperties(properties, material);
    appendMetallicReflectanceProperties(properties, material);
    appendClearCoatProperties(properties, material._clearCoat);
    appendSheenProperties(properties, material._sheen);
    appendIridescenceProperties(properties, material._iridescence);
    appendAnisotropyProperties(properties, material._anisotropy);
    appendSubsurfaceProperties(properties, material);
    appendSpecialModeProperties(properties, material);
    return properties;
}

function appendLightmapProperties(properties: MaterialInspectionProperty[], material: PbrMaterialProps): void {
    if (!material.lightmapTexture) {
        return;
    }
    properties.push(
        property("pbr.lightmapLevel", "lightmap", "Level", "number", material.lightmapLevel ?? 1, edit("U/R", "rebuild-material", FINITE_NUMBER)),
        {
            ...property("pbr.lightmapCoordIndex", "lightmap", "Coordinates", "enum", material.lightmapCoordIndex ?? 1, edit("U/R", "rebuild-material")),
            options: [
                { value: 0, label: "UV1" },
                { value: 1, label: "UV2" },
            ],
        },
        property("pbr.useLightmapAsShadowmap", "lightmap", "Use as Shadowmap", "boolean", material.useLightmapAsShadowmap ?? false, edit("U/R", "rebuild-material")),
        property("pbr.gammaLightmap", "lightmap", "Gamma Decode", "boolean", material.gammaLightmap ?? false, edit("U/R", "rebuild-material"))
    );
}

function appendMetallicReflectanceProperties(properties: MaterialInspectionProperty[], material: PbrMaterialProps): void {
    if (!hasMetallicReflectanceConfiguration(material)) {
        return;
    }
    properties.push(
        property(
            "pbr.metallicReflectanceColor",
            "metallic-reflectance",
            "Metallic Reflectance Color",
            "vec3",
            material._metallicReflectanceColor ?? [1, 1, 1],
            edit("U/R", "rebuild-material")
        ),
        property("pbr.metallicF0Factor", "metallic-reflectance", "Metallic F0 Factor", "number", material._metallicF0Factor ?? 1, edit("U/R", "rebuild-material", FINITE_NUMBER)),
        property(
            "pbr.specularWeight",
            "metallic-reflectance",
            "Specular Weight",
            "number",
            material._specularWeight ?? material._metallicF0Factor ?? 1,
            edit("U/R", "rebuild-material", FINITE_NUMBER)
        ),
        property(
            "pbr.useOnlyMetallicFromTexture",
            "metallic-reflectance",
            "Use Only Metallic From Texture",
            "boolean",
            material._useOnlyMetallicFromMetallicReflectanceTexture ?? false,
            edit("U/R", "rebuild-material")
        )
    );
}

function appendClearCoatProperties(properties: MaterialInspectionProperty[], clearCoat: ClearCoatProps | undefined): void {
    if (!clearCoat) {
        return;
    }
    properties.push(
        property("pbr.clearCoat.enabled", "clear-coat", "Enabled", "boolean", clearCoat.isEnabled ?? false, edit("U/R", "rebuild-material")),
        property("pbr.clearCoat.intensity", "clear-coat", "Intensity", "number", clearCoat.intensity ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property("pbr.clearCoat.roughness", "clear-coat", "Roughness", "number", clearCoat.roughness ?? 0, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property(
            "pbr.clearCoat.indexOfRefraction",
            "clear-coat",
            "Index of Refraction",
            "number",
            clearCoat.indexOfRefraction ?? 1.5,
            edit("U/R", "rebuild-material", FINITE_NUMBER)
        ),
        property("pbr.clearCoat.useF0Remap", "clear-coat", "F0 Remap", "boolean", clearCoat.useF0Remap ?? true, edit("U/R", "rebuild-material")),
        property("pbr.clearCoat.bumpTextureScale", "clear-coat", "Bump Texture Scale", "number", clearCoat.bumpTextureScale ?? 1, edit("U/R", "rebuild-material", FINITE_NUMBER))
    );
}

function appendSheenProperties(properties: MaterialInspectionProperty[], sheen: SheenProps | undefined): void {
    if (!sheen) {
        return;
    }
    properties.push(
        property("pbr.sheen.enabled", "sheen", "Enabled", "boolean", sheen.isEnabled ?? false, edit("U/R", "rebuild-material")),
        property("pbr.sheen.color", "sheen", "Color", "vec3", sheen.color ?? [1, 1, 1], edit("U/R", "rebuild-material")),
        property("pbr.sheen.roughness", "sheen", "Roughness", "number", sheen.roughness ?? 0, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property("pbr.sheen.intensity", "sheen", "Intensity", "number", sheen.intensity ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property("pbr.sheen.albedoScaling", "sheen", "Albedo Scaling", "boolean", sheen.albedoScaling ?? false, edit("U/R", "rebuild-material"))
    );
}

function appendIridescenceProperties(properties: MaterialInspectionProperty[], iridescence: IridescenceProps | undefined): void {
    if (!iridescence) {
        return;
    }
    properties.push(
        property("pbr.iridescence.enabled", "iridescence", "Enabled", "boolean", iridescence.isEnabled ?? false, edit("U/R", "rebuild-material")),
        property("pbr.iridescence.intensity", "iridescence", "Intensity", "number", iridescence.intensity ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property(
            "pbr.iridescence.indexOfRefraction",
            "iridescence",
            "Index of Refraction",
            "number",
            iridescence.indexOfRefraction ?? 1.3,
            edit("U/R", "rebuild-material", FINITE_NUMBER)
        ),
        property(
            "pbr.iridescence.minimumThickness",
            "iridescence",
            "Minimum Thickness",
            "number",
            iridescence.minimumThickness ?? 100,
            edit("U/R", "rebuild-material", FINITE_NUMBER)
        ),
        property(
            "pbr.iridescence.maximumThickness",
            "iridescence",
            "Maximum Thickness",
            "number",
            iridescence.maximumThickness ?? 400,
            edit("U/R", "rebuild-material", FINITE_NUMBER)
        )
    );
}

function appendAnisotropyProperties(properties: MaterialInspectionProperty[], anisotropy: AnisotropyProps | undefined): void {
    if (!anisotropy) {
        return;
    }
    properties.push(
        property("pbr.anisotropy.enabled", "anisotropy", "Enabled", "boolean", anisotropy.isEnabled ?? false, edit("U/R", "rebuild-material")),
        property("pbr.anisotropy.intensity", "anisotropy", "Intensity", "number", anisotropy.intensity ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
        property("pbr.anisotropy.direction", "anisotropy", "Direction", "vec2", anisotropy.direction ?? [1, 0], edit("U/R", "rebuild-material"))
    );
}

function appendSubsurfaceProperties(properties: MaterialInspectionProperty[], material: PbrMaterialProps): void {
    const subsurface = material._subsurface;
    const translucency = subsurface?.translucency;
    if (translucency) {
        properties.push(
            property("pbr.translucency.intensity", "subsurface-translucency", "Intensity", "number", translucency.intensity ?? 1, edit("U/R", "rebuild-material", UNIT_INTERVAL)),
            property("pbr.translucency.color", "subsurface-translucency", "Color", "vec3", translucency.color ?? [1, 1, 1], edit("U/R", "rebuild-material")),
            property(
                "pbr.translucency.diffusionDistance",
                "subsurface-translucency",
                "Diffusion Distance",
                "vec3",
                translucency.diffusionDistance ?? [1, 1, 1],
                edit("U/R", "rebuild-material")
            )
        );
    }
    const thickness = subsurface?.thickness;
    if (thickness) {
        properties.push(
            property("pbr.thickness.min", "subsurface-thickness", "Minimum", "number", thickness.min ?? 0, edit("U/R", "rebuild-material", FINITE_NUMBER)),
            property("pbr.thickness.max", "subsurface-thickness", "Maximum", "number", thickness.max ?? 1, edit("U/R", "rebuild-material", FINITE_NUMBER)),
            property("pbr.thickness.useGlTFChannel", "subsurface-thickness", "Use glTF Channel", "boolean", thickness.useGlTFChannel ?? false, edit("U/R", "rebuild-material"))
        );
    }
    const tint = subsurface?.tint;
    if (tint) {
        properties.push(
            property("pbr.tint.color", "subsurface-tint", "Color", "vec3", tint.color ?? [1, 1, 1], edit("U/R", "rebuild-material")),
            property("pbr.tint.atDistance", "subsurface-tint", "Distance", "number", tint.atDistance ?? 1, edit("U/R", "rebuild-material", FINITE_NUMBER))
        );
    }
    const refraction = material._transmissive ? subsurface?.refraction : undefined;
    if (refraction) {
        properties.push(
            property(
                "pbr.transmission.intensity",
                "transmission",
                "Intensity",
                "number",
                refraction.intensity ?? 0,
                edit("U/R", "rebuild-material-and-frame-graph", UNIT_INTERVAL)
            ),
            property(
                "pbr.transmission.indexOfRefraction",
                "transmission",
                "Index of Refraction",
                "number",
                refraction.indexOfRefraction ?? 1.5,
                edit("U/R", "rebuild-material-and-frame-graph", FINITE_NUMBER)
            ),
            property(
                "pbr.transmission.useThicknessAsDepth",
                "transmission",
                "Use Thickness as Depth",
                "boolean",
                refraction.useThicknessAsDepth ?? false,
                edit("U/R", "rebuild-material-and-frame-graph")
            )
        );
        if (refraction.dispersion !== undefined) {
            properties.push(property("pbr.transmission.dispersion", "transmission", "Dispersion", "number", refraction.dispersion, edit("U/R", "rebuild-material", FINITE_NUMBER)));
        }
    }
}

function appendSpecialModeProperties(properties: MaterialInspectionProperty[], material: PbrMaterialProps): void {
    const readOnly = (mode: string): MaterialInspectionAccess => ({
        access: "read-only",
        reason: `${mode} is a one-way public mode and has no reversible setter.`,
    });
    if (material._unlit) {
        properties.push(property("pbr.mode.unlit", "special-modes", "Unlit", "boolean", true, readOnly("Unlit")));
    }
    if (material._unlitColor !== undefined) {
        properties.push(property("pbr.mode.unlitColor", "special-modes", "Unlit Color", "vec3", material._unlitColor, readOnly("Unlit tint")));
    }
    if (material._gammaAlbedo) {
        properties.push(property("pbr.mode.gammaAlbedo", "special-modes", "Gamma Albedo", "boolean", true, readOnly("Gamma albedo")));
    }
    if (material._skyboxMode) {
        properties.push(property("pbr.mode.skybox", "special-modes", "Skybox", "boolean", true, readOnly("Skybox")));
    }
    if (material._shadowOnly) {
        properties.push(property("pbr.mode.shadowOnly", "special-modes", "Shadow Only", "boolean", true, readOnly("Shadow-only")));
    }
    if (material._shadowOnlyColor !== undefined) {
        properties.push(property("pbr.mode.shadowOnlyColor", "special-modes", "Shadow Color", "vec3", material._shadowOnlyColor, readOnly("Shadow-only color")));
    }
    if (material._shadowOnlyOpacity !== undefined) {
        properties.push(property("pbr.mode.shadowOnlyOpacity", "special-modes", "Shadow Opacity", "number", material._shadowOnlyOpacity, readOnly("Shadow-only opacity")));
    }
    if (material._shadowOnlyFalloff !== undefined) {
        properties.push(property("pbr.mode.shadowOnlyFalloff", "special-modes", "Shadow Falloff", "number", material._shadowOnlyFalloff, readOnly("Shadow-only falloff")));
    }
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

function edit(
    mutation: "U" | "R" | "U/R",
    postMutation: "none" | "rebuild-material" | "rebuild-material-and-frame-graph",
    number?: InspectionNumberConstraint
): MaterialInspectionAccess {
    return { access: "read-write", mutation, postMutation, number };
}

function createPbrBindings(material: PbrMaterialProps): MaterialTextureBinding[] {
    const bindings = PBR_BINDINGS.map((binding) => createPbrBinding(material, binding));
    if (material.lightmapTexture) {
        bindings.push(createOptionalPbrBinding(material, "pbr.lightmap", "Lightmap Texture", material.lightmapTexture, false));
    }
    if (hasMetallicReflectanceConfiguration(material)) {
        bindings.push(
            createOptionalPbrBinding(material, "pbr.metallicReflectance", "Metallic Reflectance Texture", material._metallicReflectanceTexture, false),
            createOptionalPbrBinding(material, "pbr.reflectance", "Reflectance Texture", material._reflectanceTexture, false)
        );
    }
    const clearCoat = material._clearCoat;
    if (clearCoat) {
        bindings.push(
            createOptionalPbrBinding(material, "pbr.clearCoat", "Clear Coat Texture", clearCoat.texture, true),
            createOptionalPbrBinding(material, "pbr.clearCoatRoughness", "Clear Coat Roughness Texture", clearCoat.roughnessTexture, true),
            createOptionalPbrBinding(material, "pbr.clearCoatBump", "Clear Coat Bump Texture", clearCoat.bumpTexture, true)
        );
    }
    const sheen = material._sheen;
    if (sheen) {
        bindings.push(
            createOptionalPbrBinding(material, "pbr.sheen", "Sheen Color Texture", sheen.texture, true),
            createOptionalPbrBinding(material, "pbr.sheenRoughness", "Sheen Roughness Texture", sheen.roughnessTexture, true)
        );
    }
    const iridescence = material._iridescence;
    if (iridescence) {
        bindings.push(
            createOptionalPbrBinding(material, "pbr.iridescence", "Iridescence Texture", iridescence.texture, true),
            createOptionalPbrBinding(material, "pbr.iridescenceThickness", "Iridescence Thickness Texture", iridescence.thicknessTexture, true)
        );
    }
    const anisotropy = material._anisotropy;
    if (anisotropy) {
        bindings.push(createOptionalPbrBinding(material, "pbr.anisotropy", "Anisotropy Texture", anisotropy.texture, true));
    }
    const subsurface = material._subsurface;
    const translucency = subsurface?.translucency;
    if (translucency) {
        bindings.push(
            createOptionalPbrBinding(material, "pbr.translucencyColor", "Translucency Color Texture", translucency.colorTexture, true),
            createOptionalPbrBinding(material, "pbr.translucencyIntensity", "Translucency Intensity Texture", translucency.intensityTexture, true)
        );
    }
    if (subsurface?.thickness) {
        bindings.push(createOptionalPbrBinding(material, "pbr.thickness", "Thickness Texture", subsurface.thickness.texture, true));
    }
    if (material._transmissive && subsurface?.refraction) {
        bindings.push(createOptionalPbrBinding(material, "pbr.transmission", "Transmission Texture", subsurface.refraction.texture, true));
    }
    return bindings;
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

function createOptionalPbrBinding(
    material: PbrMaterialProps,
    id: MaterialTextureBindingId,
    label: string,
    texture: Texture2D | undefined,
    canClear: boolean
): MaterialTextureBinding {
    const present = texture != null;
    return {
        id,
        label,
        value: present ? { state: "present", value: { entity: texture, kind: "2d" } } : { state: "absent" },
        acceptedKinds: ["2d"],
        sampleCategory: "float",
        viewCategory: "2d",
        directions: present ? (canClear ? ["replace", "clear", "navigate"] : ["replace", "navigate"]) : ["assign"],
        mutation: edit("R", "rebuild-material"),
        transform: createBindingTransform(material, texture),
    };
}

function createBindingTransform(material: PbrMaterialProps, texture: Texture2D | null | undefined): InspectionValue<TextureInspectionTransform> {
    if (!texture) {
        return { state: "absent" };
    }
    if (!material._hasUvTx && !(texture as Texture2D & { _hasTx?: boolean })._hasTx) {
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
        case "pbr.lightmapLevel":
        case "pbr.lightmapCoordIndex":
        case "pbr.useLightmapAsShadowmap":
        case "pbr.gammaLightmap":
            return prepareLightmapPropertyMutation(material, property.id, value);
        case "pbr.metallicReflectanceColor":
        case "pbr.metallicF0Factor":
        case "pbr.specularWeight":
        case "pbr.useOnlyMetallicFromTexture":
            return prepareMetallicReflectancePropertyMutation(material, property.id, value);
        case "pbr.clearCoat.enabled":
        case "pbr.clearCoat.intensity":
        case "pbr.clearCoat.roughness":
        case "pbr.clearCoat.indexOfRefraction":
        case "pbr.clearCoat.useF0Remap":
        case "pbr.clearCoat.bumpTextureScale":
            return prepareClearCoatPropertyMutation(material, property.id, value);
        case "pbr.sheen.enabled":
        case "pbr.sheen.color":
        case "pbr.sheen.roughness":
        case "pbr.sheen.intensity":
        case "pbr.sheen.albedoScaling":
            return prepareSheenPropertyMutation(material, property.id, value);
        case "pbr.iridescence.enabled":
        case "pbr.iridescence.intensity":
        case "pbr.iridescence.indexOfRefraction":
        case "pbr.iridescence.minimumThickness":
        case "pbr.iridescence.maximumThickness":
            return prepareIridescencePropertyMutation(material, property.id, value);
        case "pbr.anisotropy.enabled":
        case "pbr.anisotropy.intensity":
        case "pbr.anisotropy.direction":
            return prepareAnisotropyPropertyMutation(material, property.id, value);
        case "pbr.translucency.intensity":
        case "pbr.translucency.color":
        case "pbr.translucency.diffusionDistance":
        case "pbr.thickness.min":
        case "pbr.thickness.max":
        case "pbr.thickness.useGlTFChannel":
        case "pbr.tint.color":
        case "pbr.tint.atDistance":
            return prepareSubsurfacePropertyMutation(material, property.id, value);
        case "pbr.transmission.intensity":
        case "pbr.transmission.indexOfRefraction":
        case "pbr.transmission.useThicknessAsDepth":
            return prepareTransmissionPropertyMutation(material, property.id, value);
        case "pbr.transmission.dispersion":
            return prepareDispersionPropertyMutation(material, value as number);
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
    const nextTexture = texture as Texture2D | null;
    switch (binding.id) {
        case "pbr.lightmap":
            return prepareLightmapTextureMutation(material, requireTexture(nextTexture, binding.id));
        case "pbr.metallicReflectance":
        case "pbr.reflectance":
            return prepareMetallicReflectanceTextureMutation(material, binding.id, requireTexture(nextTexture, binding.id));
        case "pbr.clearCoat":
        case "pbr.clearCoatRoughness":
        case "pbr.clearCoatBump":
            return prepareClearCoatTextureMutation(material, binding.id, nextTexture ?? undefined);
        case "pbr.sheen":
        case "pbr.sheenRoughness":
            return prepareSheenTextureMutation(material, binding.id, nextTexture ?? undefined);
        case "pbr.iridescence":
        case "pbr.iridescenceThickness":
            return prepareIridescenceTextureMutation(material, binding.id, nextTexture ?? undefined);
        case "pbr.anisotropy":
            return prepareAnisotropyTextureMutation(material, nextTexture ?? undefined);
        case "pbr.translucencyColor":
        case "pbr.translucencyIntensity":
        case "pbr.thickness":
            return prepareSubsurfaceTextureMutation(material, binding.id, nextTexture ?? undefined);
        case "pbr.transmission":
            return prepareTransmissionTextureMutation(material, nextTexture ?? undefined);
        default:
            return rebuildPlan(() => {
                setPbrTexture(material, binding.id, nextTexture);
            });
    }
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

function prepareLightmapPropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const texture = requireConfigured(material.lightmapTexture, "PBR lightmap");
    const options = reconstructLightmap(material);
    switch (id) {
        case "pbr.lightmapLevel":
            options.level = value as number;
            break;
        case "pbr.lightmapCoordIndex":
            options.coordIndex = value as 0 | 1;
            break;
        case "pbr.useLightmapAsShadowmap":
            options.useAsShadowmap = value as boolean;
            break;
        case "pbr.gammaLightmap":
            options.gamma = value as boolean;
            break;
    }
    return optionalFeaturePlan(material, { ...material, ...lightmapPatch(material, texture, options) }, async () => {
        const { enablePbrLightmap, setPbrLightmap } = await import("../material/pbr/enable-pbr-lightmap.js");
        await enablePbrLightmap();
        setPbrLightmap(material, texture, options);
    });
}

function prepareLightmapTextureMutation(material: PbrMaterialProps, texture: Texture2D): MaterialInspectionMutationPlan {
    const options = reconstructLightmap(material);
    return optionalFeaturePlan(material, { ...material, ...lightmapPatch(material, texture, options) }, async () => {
        const { enablePbrLightmap, setPbrLightmap } = await import("../material/pbr/enable-pbr-lightmap.js");
        await enablePbrLightmap();
        setPbrLightmap(material, texture, options);
    });
}

function reconstructLightmap(material: PbrMaterialProps): {
    level: number;
    coordIndex: 0 | 1;
    useAsShadowmap: boolean;
    gamma: boolean;
} {
    return {
        level: material.lightmapLevel ?? 1,
        coordIndex: material.lightmapCoordIndex ?? 1,
        useAsShadowmap: material.useLightmapAsShadowmap ?? false,
        gamma: material.gammaLightmap ?? false,
    };
}

function lightmapPatch(
    material: PbrMaterialProps,
    texture: Texture2D,
    options: { readonly level: number; readonly coordIndex: 0 | 1; readonly useAsShadowmap: boolean; readonly gamma: boolean }
): Partial<PbrMaterialProps> {
    const lightmapUv2Bit = 64;
    const uv2Mask = material._uv2Mask ?? 0;
    return {
        lightmapTexture: texture,
        lightmapLevel: options.level,
        lightmapCoordIndex: options.coordIndex,
        useLightmapAsShadowmap: options.useAsShadowmap,
        gammaLightmap: options.gamma,
        _uv2Mask: options.coordIndex === 1 ? uv2Mask | lightmapUv2Bit : uv2Mask & ~lightmapUv2Bit,
    };
}

function prepareMetallicReflectancePropertyMutation(
    material: PbrMaterialProps,
    id: MaterialInspectionPropertyId,
    value: MaterialInspectionPropertyValue
): MaterialInspectionMutationPlan {
    const options = reconstructMetallicReflectance(material);
    switch (id) {
        case "pbr.metallicReflectanceColor":
            options.color = copyTuple3(value);
            break;
        case "pbr.metallicF0Factor":
            options.f0Factor = value as number;
            break;
        case "pbr.specularWeight":
            options.specularWeight = value as number;
            break;
        case "pbr.useOnlyMetallicFromTexture":
            options.useOnlyMetallicFromTexture = value as boolean;
            break;
    }
    return applyMetallicReflectance(material, options);
}

function prepareMetallicReflectanceTextureMutation(
    material: PbrMaterialProps,
    id: "pbr.metallicReflectance" | "pbr.reflectance",
    texture: Texture2D
): MaterialInspectionMutationPlan {
    const options = reconstructMetallicReflectance(material);
    if (id === "pbr.metallicReflectance") {
        options.texture = texture;
    } else {
        options.reflectanceTexture = texture;
    }
    return applyMetallicReflectance(material, options);
}

function reconstructMetallicReflectance(material: PbrMaterialProps): MetallicReflectanceOptions {
    return {
        color: copyOptionalTuple3(material._metallicReflectanceColor) ?? [1, 1, 1],
        texture: material._metallicReflectanceTexture,
        reflectanceTexture: material._reflectanceTexture,
        f0Factor: material._metallicF0Factor ?? 1,
        specularWeight: material._specularWeight ?? material._metallicF0Factor ?? 1,
        useOnlyMetallicFromTexture: material._useOnlyMetallicFromMetallicReflectanceTexture ?? false,
    };
}

function applyMetallicReflectance(material: PbrMaterialProps, options: MetallicReflectanceOptions): MaterialInspectionMutationPlan {
    const candidate = {
        ...material,
        _metallicReflectanceColor: options.color,
        _metallicReflectanceTexture: options.texture,
        _reflectanceTexture: options.reflectanceTexture,
        _metallicF0Factor: options.f0Factor,
        _specularWeight: options.specularWeight,
        _useOnlyMetallicFromMetallicReflectanceTexture: options.useOnlyMetallicFromTexture,
    };
    return optionalFeaturePlan(material, candidate, async () => {
        const { setPbrMetallicReflectance } = await import("../material/pbr/set-metallic-reflectance.js");
        setPbrMetallicReflectance(material, options);
    });
}

function prepareClearCoatPropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const clearCoat = reconstructClearCoat(requireConfigured(material._clearCoat, "PBR clear coat"));
    switch (id) {
        case "pbr.clearCoat.enabled":
            clearCoat.isEnabled = value as boolean;
            break;
        case "pbr.clearCoat.intensity":
            clearCoat.intensity = value as number;
            break;
        case "pbr.clearCoat.roughness":
            clearCoat.roughness = value as number;
            break;
        case "pbr.clearCoat.indexOfRefraction":
            clearCoat.indexOfRefraction = value as number;
            break;
        case "pbr.clearCoat.useF0Remap":
            clearCoat.useF0Remap = value as boolean;
            break;
        case "pbr.clearCoat.bumpTextureScale":
            clearCoat.bumpTextureScale = value as number;
            break;
    }
    return applyClearCoat(material, clearCoat);
}

function prepareClearCoatTextureMutation(
    material: PbrMaterialProps,
    id: "pbr.clearCoat" | "pbr.clearCoatRoughness" | "pbr.clearCoatBump",
    texture: Texture2D | undefined
): MaterialInspectionMutationPlan {
    const clearCoat = reconstructClearCoat(requireConfigured(material._clearCoat, "PBR clear coat"));
    if (id === "pbr.clearCoat") {
        clearCoat.texture = texture;
    } else if (id === "pbr.clearCoatRoughness") {
        clearCoat.roughnessTexture = texture;
    } else {
        clearCoat.bumpTexture = texture;
    }
    return applyClearCoat(material, clearCoat);
}

function reconstructClearCoat(clearCoat: ClearCoatProps): ClearCoatProps {
    return {
        isEnabled: clearCoat.isEnabled ?? false,
        intensity: clearCoat.intensity ?? 1,
        roughness: clearCoat.roughness ?? 0,
        indexOfRefraction: clearCoat.indexOfRefraction ?? 1.5,
        texture: clearCoat.texture,
        roughnessTexture: clearCoat.roughnessTexture,
        bumpTexture: clearCoat.bumpTexture,
        bumpTextureScale: clearCoat.bumpTextureScale ?? 1,
        useF0Remap: clearCoat.useF0Remap ?? true,
    };
}

function applyClearCoat(material: PbrMaterialProps, clearCoat: ClearCoatProps): MaterialInspectionMutationPlan {
    return optionalFeaturePlan(material, { ...material, _clearCoat: clearCoat }, async () => {
        const { setPbrClearCoat } = await import("../material/pbr/set-clearcoat.js");
        setPbrClearCoat(material, clearCoat);
    });
}

function prepareSheenPropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const sheen = reconstructSheen(requireConfigured(material._sheen, "PBR sheen"));
    switch (id) {
        case "pbr.sheen.enabled":
            sheen.isEnabled = value as boolean;
            break;
        case "pbr.sheen.color":
            sheen.color = copyTuple3(value);
            break;
        case "pbr.sheen.roughness":
            sheen.roughness = value as number;
            break;
        case "pbr.sheen.intensity":
            sheen.intensity = value as number;
            break;
        case "pbr.sheen.albedoScaling":
            sheen.albedoScaling = value as boolean;
            break;
    }
    return applySheen(material, sheen);
}

function prepareSheenTextureMutation(material: PbrMaterialProps, id: "pbr.sheen" | "pbr.sheenRoughness", texture: Texture2D | undefined): MaterialInspectionMutationPlan {
    const sheen = reconstructSheen(requireConfigured(material._sheen, "PBR sheen"));
    if (id === "pbr.sheen") {
        sheen.texture = texture;
    } else {
        sheen.roughnessTexture = texture;
    }
    return applySheen(material, sheen);
}

function reconstructSheen(sheen: SheenProps): SheenProps {
    return {
        isEnabled: sheen.isEnabled ?? false,
        color: copyOptionalTuple3(sheen.color) ?? [1, 1, 1],
        roughness: sheen.roughness ?? 0,
        intensity: sheen.intensity ?? 1,
        texture: sheen.texture,
        roughnessTexture: sheen.roughnessTexture,
        albedoScaling: sheen.albedoScaling ?? false,
    };
}

function applySheen(material: PbrMaterialProps, sheen: SheenProps): MaterialInspectionMutationPlan {
    return optionalFeaturePlan(material, { ...material, _sheen: sheen }, async () => {
        const { setPbrSheen } = await import("../material/pbr/set-sheen.js");
        setPbrSheen(material, sheen);
    });
}

function prepareIridescencePropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const iridescence = reconstructIridescence(requireConfigured(material._iridescence, "PBR iridescence"));
    switch (id) {
        case "pbr.iridescence.enabled":
            iridescence.isEnabled = value as boolean;
            break;
        case "pbr.iridescence.intensity":
            iridescence.intensity = value as number;
            break;
        case "pbr.iridescence.indexOfRefraction":
            iridescence.indexOfRefraction = value as number;
            break;
        case "pbr.iridescence.minimumThickness":
            iridescence.minimumThickness = value as number;
            break;
        case "pbr.iridescence.maximumThickness":
            iridescence.maximumThickness = value as number;
            break;
    }
    return applyIridescence(material, iridescence);
}

function prepareIridescenceTextureMutation(
    material: PbrMaterialProps,
    id: "pbr.iridescence" | "pbr.iridescenceThickness",
    texture: Texture2D | undefined
): MaterialInspectionMutationPlan {
    const iridescence = reconstructIridescence(requireConfigured(material._iridescence, "PBR iridescence"));
    if (id === "pbr.iridescence") {
        iridescence.texture = texture;
    } else {
        iridescence.thicknessTexture = texture;
    }
    return applyIridescence(material, iridescence);
}

function reconstructIridescence(iridescence: IridescenceProps): IridescenceProps {
    return {
        isEnabled: iridescence.isEnabled ?? false,
        intensity: iridescence.intensity ?? 1,
        indexOfRefraction: iridescence.indexOfRefraction ?? 1.3,
        minimumThickness: iridescence.minimumThickness ?? 100,
        maximumThickness: iridescence.maximumThickness ?? 400,
        texture: iridescence.texture,
        thicknessTexture: iridescence.thicknessTexture,
    };
}

function applyIridescence(material: PbrMaterialProps, iridescence: IridescenceProps): MaterialInspectionMutationPlan {
    return optionalFeaturePlan(material, { ...material, _iridescence: iridescence }, async () => {
        const { setPbrIridescence } = await import("../material/pbr/set-iridescence.js");
        setPbrIridescence(material, iridescence);
    });
}

function prepareAnisotropyPropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const anisotropy = reconstructAnisotropy(requireConfigured(material._anisotropy, "PBR anisotropy"));
    if (id === "pbr.anisotropy.enabled") {
        anisotropy.isEnabled = value as boolean;
    } else if (id === "pbr.anisotropy.intensity") {
        anisotropy.intensity = value as number;
    } else {
        anisotropy.direction = copyTuple2(value);
    }
    return applyAnisotropy(material, anisotropy);
}

function prepareAnisotropyTextureMutation(material: PbrMaterialProps, texture: Texture2D | undefined): MaterialInspectionMutationPlan {
    const anisotropy = reconstructAnisotropy(requireConfigured(material._anisotropy, "PBR anisotropy"));
    anisotropy.texture = texture;
    return applyAnisotropy(material, anisotropy);
}

function reconstructAnisotropy(anisotropy: AnisotropyProps): AnisotropyProps {
    return {
        isEnabled: anisotropy.isEnabled ?? false,
        intensity: anisotropy.intensity ?? 1,
        direction: anisotropy.direction ? [...anisotropy.direction] : [1, 0],
        texture: anisotropy.texture,
    };
}

function applyAnisotropy(material: PbrMaterialProps, anisotropy: AnisotropyProps): MaterialInspectionMutationPlan {
    return optionalFeaturePlan(material, { ...material, _anisotropy: anisotropy }, async () => {
        const { setPbrAnisotropy } = await import("../material/pbr/set-anisotropy.js");
        setPbrAnisotropy(material, anisotropy);
    });
}

function prepareSubsurfacePropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const subsurface = reconstructSubsurface(requireConfigured(material._subsurface, "PBR subsurface"));
    switch (id) {
        case "pbr.translucency.intensity":
            requireConfigured(subsurface.translucency, "PBR translucency").intensity = value as number;
            break;
        case "pbr.translucency.color":
            requireConfigured(subsurface.translucency, "PBR translucency").color = copyTuple3(value);
            break;
        case "pbr.translucency.diffusionDistance":
            requireConfigured(subsurface.translucency, "PBR translucency").diffusionDistance = copyTuple3(value);
            break;
        case "pbr.thickness.min":
            requireConfigured(subsurface.thickness, "PBR thickness").min = value as number;
            break;
        case "pbr.thickness.max":
            requireConfigured(subsurface.thickness, "PBR thickness").max = value as number;
            break;
        case "pbr.thickness.useGlTFChannel":
            requireConfigured(subsurface.thickness, "PBR thickness").useGlTFChannel = value as boolean;
            break;
        case "pbr.tint.color":
            requireConfigured(subsurface.tint, "PBR tint").color = copyTuple3(value);
            break;
        case "pbr.tint.atDistance":
            requireConfigured(subsurface.tint, "PBR tint").atDistance = value as number;
            break;
    }
    return applySubsurface(material, subsurface);
}

function prepareSubsurfaceTextureMutation(
    material: PbrMaterialProps,
    id: "pbr.translucencyColor" | "pbr.translucencyIntensity" | "pbr.thickness",
    texture: Texture2D | undefined
): MaterialInspectionMutationPlan {
    const subsurface = reconstructSubsurface(requireConfigured(material._subsurface, "PBR subsurface"));
    if (id === "pbr.translucencyColor") {
        requireConfigured(subsurface.translucency, "PBR translucency").colorTexture = texture;
    } else if (id === "pbr.translucencyIntensity") {
        requireConfigured(subsurface.translucency, "PBR translucency").intensityTexture = texture;
    } else {
        requireConfigured(subsurface.thickness, "PBR thickness").texture = texture;
    }
    return applySubsurface(material, subsurface);
}

function reconstructSubsurface(subsurface: SubSurfaceProps): SubSurfaceProps {
    return {
        translucency: subsurface.translucency ? reconstructTranslucency(subsurface.translucency) : undefined,
        scattering: subsurface.scattering ? { ...subsurface.scattering } : undefined,
        thickness: subsurface.thickness ? reconstructThickness(subsurface.thickness) : undefined,
        tint: subsurface.tint ? reconstructTint(subsurface.tint) : undefined,
        refraction: subsurface.refraction ? reconstructRefraction(subsurface.refraction) : undefined,
    };
}

function reconstructTranslucency(translucency: TranslucencyProps): TranslucencyProps {
    return {
        intensity: translucency.intensity ?? 1,
        color: copyOptionalTuple3(translucency.color) ?? [1, 1, 1],
        colorTexture: translucency.colorTexture,
        intensityTexture: translucency.intensityTexture,
        diffusionDistance: copyOptionalTuple3(translucency.diffusionDistance) ?? [1, 1, 1],
    };
}

function reconstructThickness(thickness: ThicknessProps): ThicknessProps {
    return {
        texture: thickness.texture,
        useGlTFChannel: thickness.useGlTFChannel ?? false,
        min: thickness.min ?? 0,
        max: thickness.max ?? 1,
    };
}

function reconstructTint(tint: TintProps): TintProps {
    return {
        color: copyOptionalTuple3(tint.color) ?? [1, 1, 1],
        atDistance: tint.atDistance,
    };
}

function applySubsurface(material: PbrMaterialProps, subsurface: SubSurfaceProps): MaterialInspectionMutationPlan {
    return optionalFeaturePlan(material, { ...material, _subsurface: subsurface }, async () => {
        const { setPbrSubsurface } = await import("../material/pbr/set-subsurface.js");
        setPbrSubsurface(material, subsurface);
    });
}

function prepareTransmissionPropertyMutation(material: PbrMaterialProps, id: MaterialInspectionPropertyId, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const refraction = reconstructRefraction(requireTransmission(material));
    if (id === "pbr.transmission.intensity") {
        refraction.intensity = value as number;
    } else if (id === "pbr.transmission.indexOfRefraction") {
        refraction.indexOfRefraction = value as number;
    } else {
        refraction.useThicknessAsDepth = value as boolean;
    }
    return applyTransmission(material, refraction);
}

function prepareTransmissionTextureMutation(material: PbrMaterialProps, texture: Texture2D | undefined): MaterialInspectionMutationPlan {
    const refraction = reconstructRefraction(requireTransmission(material));
    refraction.texture = texture;
    return applyTransmission(material, refraction);
}

function reconstructRefraction(refraction: RefractionProps): RefractionProps {
    return {
        intensity: refraction.intensity ?? 0,
        texture: refraction.texture,
        indexOfRefraction: refraction.indexOfRefraction ?? 1.5,
        useThicknessAsDepth: refraction.useThicknessAsDepth ?? false,
        dispersion: refraction.dispersion,
    };
}

function applyTransmission(material: PbrMaterialProps, refraction: RefractionProps): MaterialInspectionMutationPlan {
    const subsurface = { ...material._subsurface, refraction };
    return optionalFeaturePlan(material, { ...material, _subsurface: subsurface, _transmissive: true }, async () => {
        const { setPbrTransmission } = await import("../material/pbr/set-transmission.js");
        setPbrTransmission(material, refraction);
    });
}

function prepareDispersionPropertyMutation(material: PbrMaterialProps, dispersion: number): MaterialInspectionMutationPlan {
    const refraction = { ...reconstructRefraction(requireTransmission(material)), dispersion };
    const candidate = { ...material, _subsurface: { ...material._subsurface, refraction } };
    return optionalFeaturePlan(material, candidate, async () => {
        const { setPbrDispersion } = await import("../material/pbr/set-dispersion.js");
        setPbrDispersion(material, dispersion);
    });
}

function requireTransmission(material: PbrMaterialProps): RefractionProps {
    if (!material._transmissive) {
        throw new Error("PBR transmission is no longer configured.");
    }
    return requireConfigured(material._subsurface?.refraction, "PBR transmission");
}

function optionalFeaturePlan(material: PbrMaterialProps, candidate: PbrMaterialProps, apply: () => void | Promise<void>): MaterialInspectionMutationPlan {
    const before = createPbrFeatureSignature(material);
    const after = createPbrFeatureSignature(candidate);
    return {
        mutation: samePbrFeatureSignature(before, after) ? "U" : "R",
        frameGraphParticipationChanged: before.frameGraphParticipation !== after.frameGraphParticipation,
        apply,
    };
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

function createPbrFeatureSignature(material: PbrMaterialProps): PbrFeatureSignature {
    const clearCoat = material._clearCoat;
    const sheen = material._sheen;
    const iridescence = material._iridescence;
    const anisotropy = material._anisotropy;
    const subsurface = material._subsurface;
    const translucency = subsurface?.translucency;
    const thickness = subsurface?.thickness;
    const refraction = material._transmissive ? subsurface?.refraction : undefined;
    const frameGraphParticipation = !!refraction && (refraction.intensity ?? 0) > 0;
    const volumeEnabled = frameGraphParticipation && subsurface?.tint?.atDistance !== undefined;
    const reflectanceMap = material._metallicReflectanceTexture !== undefined || material._reflectanceTexture !== undefined;
    const reflectanceHasUvTransform =
        reflectanceMap &&
        (!!(material._metallicReflectanceTexture as Texture2DFeatureState | undefined)?._hasTx || !!(material._reflectanceTexture as Texture2DFeatureState | undefined)?._hasTx);
    const reflectanceFactors =
        !reflectanceMap &&
        ((material._metallicF0Factor !== undefined && Math.abs(material._metallicF0Factor - 1) > 1e-6) ||
            (material._metallicReflectanceColor !== undefined &&
                (material._metallicReflectanceColor[0] !== 1 || material._metallicReflectanceColor[1] !== 1 || material._metallicReflectanceColor[2] !== 1)) ||
            (material as PbrMaterialProps & { _occlStrengthAnimated?: boolean })._occlStrengthAnimated === true);

    return {
        core: createPbrCoreFeatureSignature(material),
        optional: [
            material.lightmapTexture,
            material.lightmapTexture ? (material.lightmapCoordIndex ?? 1) : undefined,
            material.lightmapTexture ? material.useLightmapAsShadowmap === true : false,
            material.lightmapTexture ? material.gammaLightmap === true : false,
            material.lightmapTexture ? !!material.lightmapTexture.invertY !== (material.lightmapTexture.uAng === Math.PI) : false,
            material._metallicReflectanceTexture,
            material._reflectanceTexture,
            reflectanceFactors,
            (reflectanceMap || reflectanceFactors) && material._useOnlyMetallicFromMetallicReflectanceTexture === true,
            reflectanceHasUvTransform,
            clearCoat?.isEnabled === true,
            clearCoat?.isEnabled ? clearCoat.texture : undefined,
            clearCoat?.isEnabled ? textureHasTransform(clearCoat.texture) : false,
            clearCoat?.isEnabled ? clearCoat.roughnessTexture : undefined,
            clearCoat?.isEnabled ? textureHasTransform(clearCoat.roughnessTexture) : false,
            clearCoat?.isEnabled ? clearCoat.bumpTexture : undefined,
            clearCoat?.isEnabled ? textureHasTransform(clearCoat.bumpTexture) : false,
            clearCoat?.isEnabled ? clearCoat.useF0Remap === false : false,
            sheen?.isEnabled === true,
            sheen?.isEnabled ? sheen.texture : undefined,
            sheen?.isEnabled ? textureHasTransform(sheen.texture) : false,
            sheen?.isEnabled ? sheen.roughnessTexture : undefined,
            sheen?.isEnabled ? sheen.albedoScaling === true : false,
            iridescence?.isEnabled === true,
            iridescence?.isEnabled ? iridescence.texture : undefined,
            iridescence?.isEnabled ? textureHasTransform(iridescence.texture) : false,
            iridescence?.isEnabled ? textureUsesUv2(iridescence.texture) : false,
            iridescence?.isEnabled ? iridescence.thicknessTexture : undefined,
            iridescence?.isEnabled ? textureHasTransform(iridescence.thicknessTexture) : false,
            iridescence?.isEnabled ? textureUsesUv2(iridescence.thicknessTexture) : false,
            anisotropy?.isEnabled === true,
            anisotropy?.isEnabled ? anisotropy.texture : undefined,
            translucency !== undefined,
            translucency?.colorTexture,
            translucency?.intensityTexture,
            translucency !== undefined ? textureHasTransform(translucency.colorTexture) || textureHasTransform(translucency.intensityTexture) : false,
            translucency !== undefined ? thickness?.texture : undefined,
            translucency !== undefined ? thickness?.useGlTFChannel === true : false,
            frameGraphParticipation,
            frameGraphParticipation ? refraction?.texture : undefined,
            frameGraphParticipation ? thickness?.texture : undefined,
            frameGraphParticipation ? thickness?.useGlTFChannel === true : false,
            volumeEnabled,
            volumeEnabled && !!refraction?.dispersion,
        ],
        frameGraphParticipation,
    };
}

type Texture2DFeatureState = Texture2D & { readonly _hasTx?: boolean; readonly _texCoord?: number };

function textureHasTransform(texture: Texture2D | undefined): boolean {
    return !!(texture as Texture2DFeatureState | undefined)?._hasTx;
}

function textureUsesUv2(texture: Texture2D | undefined): boolean {
    return (texture as Texture2DFeatureState | undefined)?._texCoord === 1;
}

function samePbrFeatureSignature(a: PbrFeatureSignature, b: PbrFeatureSignature): boolean {
    if (!samePbrCoreFeatureSignature(a.core, b.core) || a.optional.length !== b.optional.length) {
        return false;
    }
    for (let index = 0; index < a.optional.length; index++) {
        if (!Object.is(a.optional[index], b.optional[index])) {
            return false;
        }
    }
    return true;
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

function hasMetallicReflectanceConfiguration(material: PbrMaterialProps): boolean {
    return (
        material._metallicReflectanceColor !== undefined ||
        material._metallicF0Factor !== undefined ||
        material._specularWeight !== undefined ||
        material._useOnlyMetallicFromMetallicReflectanceTexture !== undefined ||
        material._metallicReflectanceTexture !== undefined ||
        material._reflectanceTexture !== undefined
    );
}

function requireConfigured<T>(value: T | null | undefined, name: string): T {
    if (value == null) {
        throw new Error(`${name} is no longer configured.`);
    }
    return value;
}

function requireTexture(texture: Texture2D | null, binding: MaterialTextureBindingId): Texture2D {
    if (!texture) {
        throw new Error(`Texture binding "${binding}" cannot be cleared.`);
    }
    return texture;
}

function copyTuple2(value: MaterialInspectionPropertyValue): [number, number] {
    const tuple = value as readonly [number, number];
    return [tuple[0], tuple[1]];
}

function copyTuple3(value: MaterialInspectionPropertyValue): [number, number, number] {
    const tuple = value as readonly [number, number, number];
    return [tuple[0], tuple[1], tuple[2]];
}

function copyOptionalTuple3(value: readonly [number, number, number] | undefined): [number, number, number] | undefined {
    return value ? [value[0], value[1], value[2]] : undefined;
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
