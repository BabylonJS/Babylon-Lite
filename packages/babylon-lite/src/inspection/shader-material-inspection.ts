import type { Material } from "../material/material.js";
import {
    _isShaderSystemUniform,
    setShaderTexture,
    setShaderUniform,
    type ShaderMaterial,
    type ShaderSamplerDecl,
    type ShaderUniformDecl,
    type ShaderUniformType,
    type ShaderUniformValue,
} from "../material/shader/shader-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type {
    InspectionNumberConstraint,
    MaterialInspectionAccess,
    MaterialInspectionProperty,
    MaterialInspectionPropertyValue,
    MaterialTextureBinding,
    MaterialTextureMutation,
    TextureBindingKind,
    TextureSampleCategory,
} from "./inspection-types.js";
import type { MaterialInspectionFamilyDescriptor, MaterialInspectionMutationPlan } from "./material-inspection.js";

const FINITE_NUMBER = { finite: true } as const;
const U32_NUMBER = { finite: true, integer: true, min: 0, max: 0xffffffff } as const;
const I32_NUMBER = { finite: true, integer: true, min: -0x80000000, max: 0x7fffffff } as const;

/** @internal Side-effect-free Shader descriptor. Dispatcher wiring is owned by the family convergence task. */
export const shaderMaterialInspectionDescriptor: MaterialInspectionFamilyDescriptor = {
    inspect: inspectShaderMaterial,
    preparePropertyMutation: prepareShaderPropertyMutation,
    prepareTextureMutation: prepareShaderTextureMutation,
};

function inspectShaderMaterial(source: Material) {
    const material = source as ShaderMaterial;
    const properties: MaterialInspectionProperty[] = [];
    for (const declaration of material.uniformDecls) {
        if (!_isShaderSystemUniform(declaration.name)) {
            properties.push(createUniformProperty(material, declaration));
        }
    }
    properties.push({
        id: "shader.configuration",
        section: "configuration",
        label: "Configuration",
        valueType: "summary",
        value: { state: "present", value: summarizeConfiguration(material) },
        access: { access: "read-only", reason: "Shader pipeline configuration is read-only." },
    });
    return {
        properties,
        textureBindings: material.samplerDecls.map((declaration) => createSamplerBinding(material, declaration)),
    };
}

function createUniformProperty(material: ShaderMaterial, declaration: ShaderUniformDecl): MaterialInspectionProperty {
    const slot = material._uniformValues.get(declaration.name);
    return {
        id: `shader.uniform:${declaration.name}`,
        section: "inputs",
        label: declaration.name,
        valueType: uniformValueType(declaration.type),
        value: slot
            ? { state: "present", value: copyUniformValue(declaration.type, slot.value) }
            : { state: "unsupported", reason: `Uniform "${declaration.name}" has no value slot.` },
        access: edit(numberConstraint(declaration.type)),
    };
}

function uniformValueType(type: ShaderUniformType): MaterialInspectionProperty["valueType"] {
    switch (type) {
        case "f32":
        case "u32":
        case "i32":
            return "number";
        case "vec2<f32>":
            return "vec2";
        case "vec3<f32>":
            return "vec3";
        case "vec4<f32>":
            return "vec4";
        case "mat4x4<f32>":
            return "mat4";
    }
}

function numberConstraint(type: ShaderUniformType): InspectionNumberConstraint | undefined {
    switch (type) {
        case "f32":
            return FINITE_NUMBER;
        case "u32":
            return U32_NUMBER;
        case "i32":
            return I32_NUMBER;
        default:
            return undefined;
    }
}

function copyUniformValue(type: ShaderUniformType, value: Float32Array): MaterialInspectionPropertyValue {
    switch (type) {
        case "f32":
        case "u32":
        case "i32":
            return value[0]!;
        case "vec2<f32>":
            return [value[0]!, value[1]!];
        case "vec3<f32>":
            return [value[0]!, value[1]!, value[2]!];
        case "vec4<f32>":
            return [value[0]!, value[1]!, value[2]!, value[3]!];
        case "mat4x4<f32>":
            return [
                value[0]!,
                value[1]!,
                value[2]!,
                value[3]!,
                value[4]!,
                value[5]!,
                value[6]!,
                value[7]!,
                value[8]!,
                value[9]!,
                value[10]!,
                value[11]!,
                value[12]!,
                value[13]!,
                value[14]!,
                value[15]!,
            ];
    }
}

function createSamplerBinding(material: ShaderMaterial, declaration: ShaderSamplerDecl): MaterialTextureBinding {
    const slot = material._textureSlots.get(declaration.name);
    const texture = slot?.current ?? null;
    const expectedKind = samplerKind(declaration);
    const kind = texture ? textureKind(texture) : undefined;
    const value: MaterialTextureBinding["value"] = !slot
        ? { state: "unsupported", reason: `Sampler "${declaration.name}" has no texture slot.` }
        : !texture
          ? { state: "absent" }
          : kind
            ? { state: "present", value: { entity: texture, kind } }
            : { state: "unsupported", reason: `Sampler "${declaration.name}" contains an unsupported texture value.` };
    return {
        id: `shader.sampler:${declaration.name}`,
        label: declaration.name,
        value,
        acceptedKinds: [expectedKind],
        sampleCategory: samplerSampleCategory(declaration),
        viewCategory: expectedKind,
        directions: !slot ? [] : texture ? (kind ? ["replace", "clear", "navigate"] : ["replace", "clear"]) : ["assign"],
        mutation: slot ? edit() : { access: "read-only", reason: `Sampler "${declaration.name}" has no texture slot.` },
        transform: texture ? { state: "unsupported", reason: "Shader samplers do not use standard material UV transforms." } : { state: "absent" },
    };
}

function prepareShaderPropertyMutation(source: Material, property: MaterialInspectionProperty, value: MaterialInspectionPropertyValue): MaterialInspectionMutationPlan {
    const material = source as ShaderMaterial;
    const declaration = material.uniformDecls.find((candidate) => !_isShaderSystemUniform(candidate.name) && property.id === `shader.uniform:${candidate.name}`);
    if (!declaration) {
        throw new Error(`Property "${property.id}" is stale, read-only, or unsupported for a Shader material.`);
    }
    return {
        mutation: "A",
        invalidationOwned: true,
        apply: () => {
            setShaderUniform(material, declaration.name, value as ShaderUniformValue);
        },
    };
}

function prepareShaderTextureMutation(source: Material, binding: MaterialTextureBinding, mutation: MaterialTextureMutation): MaterialInspectionMutationPlan {
    const material = source as ShaderMaterial;
    const declaration = material.samplerDecls.find((candidate) => binding.id === `shader.sampler:${candidate.name}`);
    if (!declaration) {
        throw new Error(`Texture binding "${binding.id}" is stale or unsupported for a Shader material.`);
    }
    const texture = mutation.direction === "clear" ? null : mutation.texture;
    if (texture) {
        requireCompatibleTexture(binding.id, declaration, texture);
    }
    return {
        mutation: "A",
        invalidationOwned: true,
        apply: () => {
            setShaderTexture(material, declaration.name, texture as Texture2D | null);
        },
    };
}

function requireCompatibleTexture(binding: MaterialTextureBinding["id"], declaration: ShaderSamplerDecl, texture: object): void {
    const kind = textureKind(texture);
    const expectedKind = samplerKind(declaration);
    if (kind !== expectedKind) {
        throw new TypeError(`Texture binding "${binding}" requires a ${expectedKind === "2d-array" ? "Texture2DArray" : "Texture2D"} value.`);
    }
    const sampleCategory = textureSampleCategory(texture);
    const expectedSampleCategory = samplerSampleCategory(declaration);
    const compatible = expectedSampleCategory === "depth" ? sampleCategory === "depth" : sampleCategory === "float";
    if (!compatible) {
        throw new TypeError(`Texture binding "${binding}" requires a ${expectedSampleCategory} texture sample type.`);
    }
}

function textureKind(texture: object): TextureBindingKind | undefined {
    try {
        const candidate = texture as Partial<Texture2D> & { readonly layers?: unknown };
        if (
            !("texture" in candidate) ||
            !("view" in candidate) ||
            !("sampler" in candidate) ||
            typeof candidate.width !== "number" ||
            !Number.isFinite(candidate.width) ||
            typeof candidate.height !== "number" ||
            !Number.isFinite(candidate.height)
        ) {
            return undefined;
        }
        if ("layers" in candidate && candidate.layers !== undefined) {
            return typeof candidate.layers === "number" && Number.isInteger(candidate.layers) && candidate.layers > 0 ? "2d-array" : undefined;
        }
        return "2d";
    } catch {
        return undefined;
    }
}

function textureSampleCategory(texture: object): "float" | "depth" | undefined {
    try {
        const sampleType = (texture as Texture2D)._sampleType;
        return sampleType === undefined || sampleType === "float" ? "float" : sampleType === "depth" ? "depth" : undefined;
    } catch {
        return undefined;
    }
}

function samplerKind(declaration: ShaderSamplerDecl): "2d" | "2d-array" {
    return declaration.viewDimension === "2d-array" ? "2d-array" : "2d";
}

function samplerSampleCategory(declaration: ShaderSamplerDecl): TextureSampleCategory {
    return declaration.comparison === true ? "depth" : (declaration.sampleType ?? "float");
}

function edit(number?: InspectionNumberConstraint): MaterialInspectionAccess {
    return { access: "read-write", mutation: "A", postMutation: "none", number };
}

function summarizeConfiguration(material: ShaderMaterial): string {
    const attributes = material.attributes.length > 0 ? material.attributes.join(", ") : "none";
    const defines = material.defines.length > 0 ? material.defines.map((define) => `${define.name}=${String(define.value)}`).join(", ") : "none";
    const storageBuffers =
        material.storageBufferDecls.length > 0 ? material.storageBufferDecls.map((declaration) => `${declaration.name}: ${declaration.type}`).join(", ") : "none";
    return [
        `Attributes: ${attributes}`,
        `Defines: ${defines}`,
        `Blend: ${summarizeBlend(material)}`,
        `Transmissive: ${String(material.transmissive)}`,
        `Alpha testing: ${String(material.needAlphaTesting)}`,
        `Back-face culling: ${String(material.backFaceCulling)}`,
        `Depth write: ${String(material.depthWrite)}`,
        `Depth compare: ${material.depthCompare}`,
        `Depth-only fragment: ${String(material.depthOnlyFragment)}`,
        `Depth bias: ${String(material.depthBias)}`,
        `Depth bias slope scale: ${String(material.depthBiasSlopeScale)}`,
        `Topology: ${material._topology ?? "triangle-list"}`,
        `Storage buffers: ${storageBuffers}`,
    ].join("; ");
}

function summarizeBlend(material: ShaderMaterial): string {
    if (material.blend) {
        return `custom color(${summarizeBlendComponent(material.blend.color)}) alpha(${summarizeBlendComponent(material.blend.alpha)})`;
    }
    return material.needAlphaBlending ? material.blendMode : "disabled";
}

function summarizeBlendComponent(component: GPUBlendComponent): string {
    return `${component.srcFactor ?? "one"}, ${component.dstFactor ?? "zero"}, ${component.operation ?? "add"}`;
}
