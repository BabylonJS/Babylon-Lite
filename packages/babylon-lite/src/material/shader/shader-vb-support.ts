import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderAttributeName, ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";

/** @internal */
export type ShaderRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

/** @internal Minimum packet shape needed to partition merged ShaderMaterial draws. */
export interface ShaderVbPacket {
    readonly mesh: Mesh;
    /** @internal Missing constant streams computed once during validation. */
    _vertexMask?: number;
}

/** @internal Mesh-specific base vertex layout captured for sync/async pipeline creation. */
export interface ShaderVbLayout {
    /** @internal */
    readonly _vbs: readonly GPUVertexBufferLayout[];
    /** @internal */
    readonly _key: string;
}

/** @internal Read authored streams without allocating a fallback. */
export type ShaderAttributeBufferGetter = (mesh: Mesh, name: ShaderAttributeName) => GPUBuffer | null;

/** @internal Opt-in support for non-canonical ShaderMaterial formats and mesh packing. */
export interface ShaderVbSupport {
    /** @internal Validate physical stream compatibility before allocating renderable resources. */
    _validateMesh(material: ShaderMaterial, mesh: Mesh, getAttribute: ShaderAttributeBufferGetter): number;
    /** @internal */
    _layouts(material: ShaderMaterial): readonly GPUVertexBufferLayout[];
    /** @internal */
    _wgslType(material: ShaderMaterial, name: ShaderAttributeName): string | undefined;
    /** @internal */
    _forMesh(material: ShaderMaterial, bindings: ShaderPipelineBindings, mesh: Mesh, missing: number): ShaderVbLayout | null;
    /** @internal */
    _group<T extends ShaderVbPacket>(packets: readonly T[]): Iterable<readonly T[]> | null;
}

let _support: ShaderVbSupport | null = null;

/** @internal */
export function _getShaderVbSupport(): ShaderVbSupport | null {
    return _support;
}

/** @internal Installed synchronously by the storage/format opt-in module. */
export function _installShaderVbSupport(support: ShaderVbSupport): void {
    _support = support;
}

/** @internal Canonical encodings shared by input declarations, layouts and compatibility checks. */
export interface ShaderAttributeInfo {
    /** @internal */
    readonly _stride: number;
    /** @internal */
    readonly _format: GPUVertexFormat;
    /** @internal */
    readonly _type: string;
}

const float2: ShaderAttributeInfo = { _stride: 8, _format: "float32x2", _type: "vec2<f32>" };
const float3: ShaderAttributeInfo = { _stride: 12, _format: "float32x3", _type: "vec3<f32>" };
const float4: ShaderAttributeInfo = { _stride: 16, _format: "float32x4", _type: "vec4<f32>" };
const uint4: ShaderAttributeInfo = { _stride: 16, _format: "uint32x4", _type: "vec4<u32>" };
const attributes = {
    __proto__: null,
    position: float3,
    normal: float3,
    uv: float2,
    uv2: float2,
    tangent: float4,
    color: float4,
    weights: float4,
    weights1: float4,
    joints: uint4,
    joints1: uint4,
};

/** @internal */
export function _attributeInfo(name: ShaderAttributeName): ShaderAttributeInfo {
    return attributes[name];
}

/** @internal Canonical tight layout for one attribute. */
export function _attributeLayout(name: ShaderAttributeName, shaderLocation: number): { arrayStride: number; attributes: [GPUVertexAttribute] } {
    const info = attributes[name];
    return _createAttributeLayout(info._format, info._stride, shaderLocation);
}

/** @internal One layout shape for both canonical and explicitly declared formats. */
export function _createAttributeLayout(format: GPUVertexFormat, arrayStride: number, shaderLocation: number): { arrayStride: number; attributes: [GPUVertexAttribute] } {
    return { arrayStride, attributes: [{ shaderLocation, offset: 0, format }] };
}
