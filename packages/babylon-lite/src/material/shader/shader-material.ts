import { F32 } from "../../engine/typed-arrays.js";
import type { Material } from "../material.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { Mat4 } from "../../math/types.js";
import { shaderGroupBuilder } from "./shader-group-builder.js";

/** Vertex attribute names a ShaderMaterial can bind. */
export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color";
/** WGSL scalar/vector/matrix types supported for ShaderMaterial uniforms. */
export type ShaderUniformType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>" | "mat4x4<f32>";
/** Built-in uniform names automatically populated by the renderer each frame
 *  (transforms, camera position, screen size, alpha cutoff). */
export type ShaderSystemUniformName = "world" | "view" | "projection" | "viewProjection" | "worldView" | "worldViewProjection" | "cameraPosition" | "screenSize" | "alphaCutoff";
/** A uniform entry: either a system uniform name or an explicit custom declaration. */
export type ShaderUniformOption = ShaderSystemUniformName | ShaderUniformDecl;
/** Accepted value shape when setting a ShaderMaterial uniform. */
export type ShaderUniformValue = number | readonly number[] | Float32Array;
/** A sampler entry: either a bare sampler name or an explicit declaration. */
export type ShaderSamplerOption = string | ShaderSamplerDecl;
/** A storage-buffer entry: a read-only WGSL storage binding declaration. */
export type ShaderStorageBufferOption = ShaderStorageBufferDecl;
/** Value of a WGSL preprocessor define — boolean toggle or numeric constant. */
export type ShaderDefineValue = boolean | number;
/** Map of WGSL preprocessor define names to their values. */
export type ShaderDefineMap = Readonly<Record<string, ShaderDefineValue>>;

/** Options describing a ShaderMaterial: WGSL sources, attributes, uniforms,
 *  samplers, defines, and blend/depth state. Passed to `createShaderMaterial()`. */
export interface ShaderMaterialOptions {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniforms?: readonly ShaderUniformOption[];
    readonly samplers?: readonly ShaderSamplerOption[];
    readonly storageBuffers?: readonly ShaderStorageBufferOption[];
    readonly defines?: ShaderDefineMap;
    readonly needAlphaBlending?: boolean;
    /** Blend equation used when `needAlphaBlending` is set. "alpha" (default) is
     *  standard src-over; "additive" adds the fragment's premultiplied-by-alpha
     *  color to the framebuffer, which is the right choice for glows/light FX. */
    readonly blendMode?: "alpha" | "additive";
    /** Mark this surface as transmissive/refractive: the renderer grabs the opaque scene color
     *  behind it just before it draws, so the fragment can sample what is *through* it (water,
     *  glass). Requires `needAlphaBlending` (the surface composites over the grabbed scene
     *  color). Enable the scene-color grab on the surface's render task with
     *  `enableRenderTaskTransmission`, then bind the resulting texture via `setShaderTexture`.
     *  Default false. */
    readonly transmissive?: boolean;
    readonly needAlphaTesting?: boolean;
    readonly backFaceCulling?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
    /** Compile/run the fragment stage even for depth-only render targets (no colour attachments).
     *  Use for depth-only casters that need `discard` (alpha/clip masks). The fragment shader must not
     *  declare colour outputs when drawn into a depth-only target. Default false. */
    readonly depthOnlyFragment?: boolean;
    /** Constant depth-bias added in the pipeline's depth-stencil state (units of the depth format's minimum
     *  representable value). Lets a surface that hugs another (e.g. tiles overlapping a cone, decals) win the
     *  depth test consistently and avoid z-fighting. Default 0 (no bias). */
    readonly depthBias?: number;
    /** Slope-scaled depth bias — extra bias proportional to the depth gradient, so steeply-angled (grazing)
     *  surfaces get more bias. Pairs with `depthBias` to kill z-fighting at oblique angles. Default 0. */
    readonly depthBiasSlopeScale?: number;
}

/** A custom uniform declaration: WGSL identifier, type, and optional default. */
export interface ShaderUniformDecl {
    readonly name: string;
    readonly type: ShaderUniformType;
    readonly defaultValue?: number | readonly number[];
}

/** A sampler declaration: WGSL identifier and the bound texture's sample type. */
export interface ShaderSamplerDecl {
    readonly name: string;
    readonly sampleType?: "float" | "unfilterable-float" | "depth";
    /** Texture view dimension. Default "2d". Use "2d-array" for layered maps such as
     *  cascaded-shadow (CSM) depth arrays. */
    readonly viewDimension?: "2d" | "2d-array";
    /** Bind a hardware comparison sampler (`sampler_comparison`) for depth compare / PCF
     *  filtering. Implies a depth texture. Default false. */
    readonly comparison?: boolean;
}

/** A storage buffer declaration. `type` is the WGSL variable type, e.g. `array<vec4<f32>>`. */
export interface ShaderStorageBufferDecl {
    readonly name: string;
    readonly type: string;
}

/** A resolved WGSL preprocessor define (name + value). */
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

export interface ShaderStorageBufferSlot {
    readonly decl: ShaderStorageBufferDecl;
    current: GPUBuffer | null;
}

/** A custom WGSL material: compiled from user-supplied vertex/fragment sources
 *  with declared attributes, uniforms, samplers, and defines. Update its values
 *  via `setShaderUniform()` / `setShaderTexture()` and friends. */
export interface ShaderMaterial extends Material {
    readonly name?: string;
    readonly vertexSource: string;
    readonly fragmentSource: string;
    readonly attributes: readonly ShaderAttributeName[];
    readonly uniformDecls: readonly ShaderUniformDecl[];
    readonly samplerDecls: readonly ShaderSamplerDecl[];
    readonly storageBufferDecls: readonly ShaderStorageBufferDecl[];
    readonly defines: readonly ShaderDefine[];
    readonly needAlphaBlending: boolean;
    readonly blendMode: "alpha" | "additive";
    /** True for transmissive/refractive surfaces (see `ShaderMaterialOptions.transmissive`). */
    readonly transmissive: boolean;
    readonly needAlphaTesting: boolean;
    readonly backFaceCulling: boolean;
    readonly depthWrite: boolean;
    readonly depthCompare: GPUCompareFunction;
    readonly depthOnlyFragment: boolean;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    /** @internal */
    _uniformValues: Map<string, ShaderUniformSlot>;
    /** @internal */
    _textureSlots: Map<string, ShaderTextureSlot>;
    /** @internal */
    _storageBufferSlots: Map<string, ShaderStorageBufferSlot>;
    /** @internal */
    _uniformVersion: number;
    /** @internal */
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

/** Create a ShaderMaterial from WGSL sources and declarations, validating
 *  attributes, uniforms, samplers, and defines.
 *  @param options - Sources, attributes, uniforms, samplers, defines, and render state.
 *  @returns The constructed `ShaderMaterial`. */
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
        const decl: ShaderSamplerDecl =
            typeof opt === "string"
                ? { name: opt, sampleType: "float" }
                : {
                      name: opt.name,
                      sampleType: opt.sampleType ?? (opt.comparison ? "depth" : "float"),
                      viewDimension: opt.viewDimension ?? "2d",
                      comparison: opt.comparison ?? false,
                  };
        assertIdentifier("sampler", decl.name);
        assertUniqueName(usedNames, "sampler", decl.name);
        assertUniqueName(usedNames, "sampler", `${decl.name}Sampler`);
        samplerDecls.push(decl);
        textureSlots.set(decl.name, { decl, current: null });
    }

    const storageBufferDecls: ShaderStorageBufferDecl[] = [];
    const storageBufferSlots = new Map<string, ShaderStorageBufferSlot>();
    for (const opt of options.storageBuffers ?? []) {
        assertIdentifier("storage buffer", opt.name);
        assertUniqueName(usedNames, "storage buffer", opt.name);
        storageBufferDecls.push(opt);
        storageBufferSlots.set(opt.name, { decl: opt, current: null });
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

    if (options.transmissive && !(options.needAlphaBlending ?? false)) {
        throw new Error("ShaderMaterial: `transmissive` requires `needAlphaBlending` (the surface composites over the grabbed opaque scene color).");
    }

    return {
        name: options.name,
        vertexSource: options.vertexSource,
        fragmentSource: options.fragmentSource,
        attributes,
        uniformDecls,
        samplerDecls,
        storageBufferDecls,
        defines,
        needAlphaBlending: options.needAlphaBlending ?? false,
        blendMode: options.blendMode ?? "alpha",
        transmissive: options.transmissive ?? false,
        needAlphaTesting: options.needAlphaTesting ?? false,
        backFaceCulling: options.backFaceCulling ?? true,
        depthWrite: options.depthWrite ?? true,
        depthCompare: options.depthCompare ?? "greater-equal",
        depthOnlyFragment: options.depthOnlyFragment ?? false,
        depthBias: options.depthBias ?? 0,
        depthBiasSlopeScale: options.depthBiasSlopeScale ?? 0,
        _buildGroup: shaderGroupBuilder as MeshGroupBuilder,
        _uboVersion: 0,
        _uniformValues: uniformValues,
        _textureSlots: textureSlots,
        _storageBufferSlots: storageBufferSlots,
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
    const arr = typeof value === "number" ? new F32([value]) : value instanceof F32 ? new F32(value) : new F32(value);
    if (arr.length !== count) {
        throw new Error(`ShaderMaterial: uniform "${decl.name}" of type ${decl.type} expects ${count} value(s), got ${arr.length}.`);
    }
    return arr;
}

/** Set a declared uniform's value, validating its element count against the
 *  declared type and bumping the material's UBO version.
 *  @param material - Target material.
 *  @param name - Declared uniform name.
 *  @param value - New value (scalar, array, or `Float32Array`). */
export function setShaderUniform(material: ShaderMaterial, name: string, value: ShaderUniformValue): void {
    const slot = material._uniformValues.get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: uniform "${name}" was not declared.`);
    }
    slot.value.set(normalizeUniformValue(slot.decl, value));
    material._uniformVersion++;
    material._uboVersion = material._uniformVersion;
}

/** Bind (or clear) the texture for a declared sampler, enforcing that depth and
 *  non-depth samplers receive a matching `Texture2D`.
 *  @param material - Target material.
 *  @param name - Declared sampler name.
 *  @param texture - Texture to bind, or `null` to clear. */
export function setShaderTexture(material: ShaderMaterial, name: string, texture: Texture2D | null): void {
    const slot = material._textureSlots.get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: sampler "${name}" was not declared.`);
    }
    if (texture) {
        const expectsDepth = slot.decl.sampleType === "depth" || slot.decl.comparison === true;
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

/** Bind (or clear) a declared read-only storage buffer. */
export function setShaderStorageBuffer(material: ShaderMaterial, name: string, buffer: GPUBuffer | null): void {
    const slot = material._storageBufferSlots.get(name);
    if (!slot) {
        throw new Error(`ShaderMaterial: storage buffer "${name}" was not declared.`);
    }
    slot.current = buffer;
    material._resourceVersion++;
}

/** Set a declared `f32` uniform. Convenience wrapper over `setShaderUniform()`. */
export function setShaderFloat(material: ShaderMaterial, name: string, value: number): void {
    setShaderUniform(material, name, value);
}

/** Set a declared `vec3<f32>` uniform. Convenience wrapper over `setShaderUniform()`. */
export function setShaderVector3(material: ShaderMaterial, name: string, value: readonly [number, number, number]): void {
    setShaderUniform(material, name, value);
}

/** Set a declared `mat4x4<f32>` uniform. Convenience wrapper over `setShaderUniform()`.
 *  Accepts a raw `Float32Array` or the engine's branded `Mat4` (e.g. the result of
 *  `getViewProjectionMatrix()` / `mat4Invert()`), so camera/math matrices can be fed
 *  straight into a matrix uniform without laundering through a typed array. */
export function setShaderMatrix(material: ShaderMaterial, name: string, value: Float32Array | Mat4): void {
    setShaderUniform(material, name, value instanceof Float32Array ? value : Array.from(value));
}
