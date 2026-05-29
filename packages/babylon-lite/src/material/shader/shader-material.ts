import type { Material } from "../material.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { shaderGroupBuilder } from "./shader-group-builder.js";

export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color";
export type ShaderUniformType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";
export type ShaderSystemUniformName = "world" | "view" | "projection" | "viewProjection" | "worldView" | "worldViewProjection" | "cameraPosition" | "screenSize" | "alphaCutoff";
export type ShaderUniformOption = ShaderSystemUniformName | ShaderUniformDecl;
export type ShaderUniformValue = number | readonly number[] | Float32Array;
export type ShaderSamplerOption = string | ShaderSamplerDecl;
export type ShaderDefineValue = boolean | number;
export type ShaderDefineMap = Readonly<Record<string, ShaderDefineValue>>;

export interface ShaderMaterialOptions {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniforms?: readonly ShaderUniformOption[];
    readonly samplers?: readonly ShaderSamplerOption[];
    readonly defines?: ShaderDefineMap;
    readonly needAlphaBlending?: boolean;
    readonly needAlphaTesting?: boolean;
    readonly backFaceCulling?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
}

export interface ShaderUniformDecl {
    readonly name: string;
    readonly type: ShaderUniformType;
    readonly defaultValue?: number | readonly number[];
}

export interface ShaderSamplerDecl {
    readonly name: string;
    readonly sampleType?: "float" | "unfilterable-float" | "depth";
}

export interface ShaderDefine {
    readonly name: string;
    readonly value: ShaderDefineValue;
}

export interface ShaderUniformSlot {
    readonly decl: ShaderUniformDecl;
    readonly value: Float32Array;
}

export interface ShaderTextureSlot {
    readonly decl: ShaderSamplerDecl;
    current: Texture2D | null;
}

export interface ShaderMaterial extends Material {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniformDecls: readonly ShaderUniformDecl[];
    readonly samplerDecls: readonly ShaderSamplerDecl[];
    readonly defines: readonly ShaderDefine[];
    readonly needAlphaBlending: boolean;
    readonly needAlphaTesting: boolean;
    readonly backFaceCulling: boolean;
    readonly depthWrite: boolean;
    readonly depthCompare: GPUCompareFunction;
    _uniformValues: Map<string, ShaderUniformSlot>;
    _textureSlots: Map<string, ShaderTextureSlot>;
    _uniformVersion: number;
    _resourceVersion: number;
}

function isIdentifier(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function assertIdentifier(kind: string, name: string): void {
    if (!isIdentifier(name)) {
        throw new Error(`ShaderMaterial: ${kind} name "${name}" is not a valid WGSL identifier.`);
    }
}

function isSupportedAttribute(name: string): name is ShaderAttributeName {
    return name === "position" || name === "normal" || name === "uv" || name === "uv2" || name === "tangent" || name === "color";
}

function isSystemUniform(name: string): name is ShaderSystemUniformName {
    return (
        name === "world" ||
        name === "view" ||
        name === "projection" ||
        name === "viewProjection" ||
        name === "worldView" ||
        name === "worldViewProjection" ||
        name === "cameraPosition" ||
        name === "screenSize" ||
        name === "alphaCutoff"
    );
}

function systemUniformType(name: ShaderSystemUniformName): ShaderUniformType {
    if (name === "cameraPosition") {
        return "vec3<f32>";
    }
    if (name === "screenSize") {
        return "vec2<f32>";
    }
    if (name === "alphaCutoff") {
        return "f32";
    }
    return "mat4x4<f32>";
}

export function _isShaderSystemUniform(name: string): name is ShaderSystemUniformName {
    return isSystemUniform(name);
}

export function createShaderMaterial(options: ShaderMaterialOptions): ShaderMaterial {
    if (!options.vertexSource || !options.fragmentSource) {
        throw new Error("ShaderMaterial: vertexSource and fragmentSource must be non-empty WGSL strings.");
    }
    const attributes: ShaderAttributeName[] = [];
    const seenAttributes = new Set<string>();
    for (const attr of options.attributes) {
        if (!isSupportedAttribute(attr)) {
            throw new Error(`ShaderMaterial: unsupported attribute "${String(attr)}". Supported attributes: position, normal, uv, uv2, tangent, color.`);
        }
        if (seenAttributes.has(attr)) {
            throw new Error(`ShaderMaterial: duplicate attribute "${attr}".`);
        }
        seenAttributes.add(attr);
        attributes.push(attr);
    }
    if (!seenAttributes.has("position")) {
        throw new Error('ShaderMaterial: "position" attribute is required for mesh rendering.');
    }

    const uniformDecls: ShaderUniformDecl[] = [];
    const uniformValues = new Map<string, ShaderUniformSlot>();
    const usedNames = new Set<string>();
    for (const opt of options.uniforms ?? []) {
        const decl = typeof opt === "string" ? normalizeSystemUniform(opt) : normalizeCustomUniform(opt);
        assertUniqueName(usedNames, "uniform", decl.name);
        uniformDecls.push(decl);
        uniformValues.set(decl.name, { decl, value: normalizeUniformValue(decl, decl.defaultValue ?? defaultUniformValue(decl)) });
    }

    const samplerDecls: ShaderSamplerDecl[] = [];
    const textureSlots = new Map<string, ShaderTextureSlot>();
    for (const opt of options.samplers ?? []) {
        const decl = typeof opt === "string" ? { name: opt, sampleType: "float" as const } : { name: opt.name, sampleType: opt.sampleType ?? "float" };
        assertIdentifier("sampler", decl.name);
        assertUniqueName(usedNames, "sampler", decl.name);
        assertUniqueName(usedNames, "sampler", `${decl.name}Sampler`);
        samplerDecls.push(decl);
        textureSlots.set(decl.name, { decl, current: null });
    }

    const defines: ShaderDefine[] = [];
    for (const [name, value] of Object.entries(options.defines ?? {})) {
        assertIdentifier("define", name);
        assertUniqueName(usedNames, "define", name);
        if (typeof value !== "boolean" && typeof value !== "number") {
            throw new Error(`ShaderMaterial: define "${name}" must be a boolean or number.`);
        }
        defines.push({ name, value });
    }
    defines.sort((a, b) => a.name.localeCompare(b.name));

    return {
        name: options.name,
        vertexSource: options.vertexSource,
        fragmentSource: options.fragmentSource,
        attributes,
        uniformDecls,
        samplerDecls,
        defines,
        needAlphaBlending: options.needAlphaBlending ?? false,
        needAlphaTesting: options.needAlphaTesting ?? false,
        backFaceCulling: options.backFaceCulling ?? true,
        depthWrite: options.depthWrite ?? true,
        depthCompare: options.depthCompare ?? "greater-equal",
        _buildGroup: shaderGroupBuilder as MeshGroupBuilder,
        _uboVersion: 0,
        _uniformValues: uniformValues,
        _textureSlots: textureSlots,
        _uniformVersion: 0,
        _resourceVersion: 0,
    };
}

function normalizeSystemUniform(name: string): ShaderUniformDecl {
    if (!isSystemUniform(name)) {
        throw new Error(`ShaderMaterial: custom uniform "${name}" must use an explicit typed declaration.`);
    }
    return { name, type: systemUniformType(name) };
}

function normalizeCustomUniform(decl: ShaderUniformDecl): ShaderUniformDecl {
    assertIdentifier("uniform", decl.name);
    if (!isUniformType(decl.type)) {
        throw new Error(`ShaderMaterial: unsupported uniform type "${String(decl.type)}" for "${decl.name}".`);
    }
    return decl;
}

function isUniformType(type: string): type is ShaderUniformType {
    return type === "f32" || type === "u32" || type === "i32" || type === "vec2<f32>" || type === "vec3<f32>" || type === "vec4<f32>" || type === "mat4x4<f32>";
}

function assertUniqueName(usedNames: Set<string>, kind: string, name: string): void {
    if (usedNames.has(name)) {
        throw new Error(`ShaderMaterial: duplicate generated identifier "${name}" while adding ${kind}.`);
    }
    usedNames.add(name);
}

function elementCount(type: ShaderUniformType): number {
    switch (type) {
        case "f32":
        case "u32":
        case "i32":
            return 1;
        case "vec2<f32>":
            return 2;
        case "vec3<f32>":
            return 3;
        case "vec4<f32>":
            return 4;
        case "mat4x4<f32>":
            return 16;
    }
}

function defaultUniformValue(decl: ShaderUniformDecl): ShaderUniformValue {
    if (decl.name === "alphaCutoff") {
        return 0.4;
    }
    const count = elementCount(decl.type);
    return count === 1 ? 0 : new Array(count).fill(0);
}

function normalizeUniformValue(decl: ShaderUniformDecl, value: ShaderUniformValue): Float32Array {
    const count = elementCount(decl.type);
    const arr = typeof value === "number" ? new Float32Array([value]) : value instanceof Float32Array ? new Float32Array(value) : new Float32Array(value);
    if (arr.length !== count) {
        throw new Error(`ShaderMaterial: uniform "${decl.name}" of type ${decl.type} expects ${count} value(s), got ${arr.length}.`);
    }
    return arr;
}

export function setShaderUniform(material: ShaderMaterial, name: string, value: ShaderUniformValue): void {
    const slot = material._uniformValues.get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: uniform "${name}" was not declared.`);
    }
    slot.value.set(normalizeUniformValue(slot.decl, value));
    material._uniformVersion++;
    material._uboVersion = material._uniformVersion;
}

export function setShaderTexture(material: ShaderMaterial, name: string, texture: Texture2D | null): void {
    const slot = material._textureSlots.get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: sampler "${name}" was not declared.`);
    }
    if (texture) {
        const expectsDepth = slot.decl.sampleType === "depth";
        const isDepthTexture = texture._sampleType === "depth";
        if (expectsDepth && !isDepthTexture) {
            throw new Error(`ShaderMaterial: sampler "${name}" expects a depth Texture2D.`);
        }
        if (!expectsDepth && isDepthTexture) {
            throw new Error(`ShaderMaterial: sampler "${name}" cannot use a depth Texture2D.`);
        }
    }
    slot.current = texture;
    material._resourceVersion++;
}

export function setShaderFloat(material: ShaderMaterial, name: string, value: number): void {
    setShaderUniform(material, name, value);
}

export function setShaderVector3(material: ShaderMaterial, name: string, value: readonly [number, number, number]): void {
    setShaderUniform(material, name, value);
}

export function setShaderMatrix(material: ShaderMaterial, name: string, value: Float32Array): void {
    setShaderUniform(material, name, value);
}
