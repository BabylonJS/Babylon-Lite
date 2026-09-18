import { MSH_HAS_MORPH_TARGETS, MSH_HAS_TANGENTS } from "../material/mesh-features.js";
import { PBR_HAS_ALPHA_TEST, PBR_HAS_ANISOTROPY, PBR_HAS_DOUBLE_SIDED, PBR_HAS_NORMAL_MAP, _registerPbrExt, type _PbrFragCtx } from "../material/pbr/pbr-flags.js";
import { _activePbrGeometryAttachments } from "../material/pbr/pbr-geometry-view.js";
import { HAS_DIFFUSE_TEXTURE, VERTEX_ALPHA } from "../material/standard/standard-flags.js";
import type { Mesh } from "../mesh/mesh.js";
import { resolveMeshBlendingTag } from "../mesh/mesh-blending-tag.js";
import type { ShaderFragment } from "../shader/fragment-types.js";
import { wgsl } from "../shader/wgsl.js";
import { GEOMETRY_TEXTURE_DESCRIPTIONS, GeometryTextureType, _installGeometryOutputExtension, type GeometryOutputExtension } from "./geometry-types.js";

let _extension: GeometryOutputExtension | null = null;

function value(mesh: Mesh): number {
    return resolveMeshBlendingTag(mesh);
}

function colorTarget(format: GPUTextureFormat, blend: GPUBlendState | undefined, device: GPUDevice): GPUColorTargetState {
    if (!blend || format === "r8uint") {
        return { format };
    }
    if (format.endsWith("uint") || format.endsWith("sint")) {
        throw new Error(`Transparent geometry output cannot blend integer format "${format}".`);
    }
    if (format.endsWith("32float") && !device.features.has("float32-blendable")) {
        throw new Error(`Transparent geometry output format "${format}" requires the float32-blendable WebGPU feature or a blendable format override.`);
    }
    return { format, blend };
}

function isZeroColor(value: GPUColor): boolean {
    if (Symbol.iterator in Object(value)) {
        const components = Array.from(value as Iterable<number>);
        return components.length === 4 && components.every((component) => component === 0);
    }
    const color = value as { r: number; g: number; b: number; a: number };
    return color.r === 0 && color.g === 0 && color.b === 0 && color.a === 0;
}

function validateAttachment(format: GPUTextureFormat, clearValue: GPUColor, samples: number): void {
    if (format !== "r8uint") {
        throw new Error(`GeometryRendererTask: MESH_BLEND_TAG format must be r8uint, received ${format}.`);
    }
    if (!isZeroColor(clearValue)) {
        throw new Error("GeometryRendererTask: MESH_BLEND_TAG clearValue must be unsigned integer zero.");
    }
    if (samples !== 1) {
        throw new Error("GeometryRendererTask: MESH_BLEND_TAG requires samples: 1.");
    }
}

function createNonUniformNormalFragment(ctx: _PbrFragCtx): ShaderFragment | null {
    if (!_activePbrGeometryAttachments?.includes(GeometryTextureType.MESH_BLEND_TAG)) {
        return null;
    }
    const hasTangentNormal = (ctx._features & PBR_HAS_NORMAL_MAP) !== 0 && (ctx._meshFeatures & MSH_HAS_TANGENTS) !== 0;
    const localNormal = (ctx._meshFeatures & MSH_HAS_MORPH_TARGETS) !== 0 ? "morphedNorm" : "normal";
    const tangentNormalAssignment = hasTangentNormal ? wgsl`out.worldTangentNormal=(finalWorld*vec4<f32>(normalize(${localNormal}),0.0)).xyz;` : "";
    const doubleSidedCorrection = (ctx._features & PBR_HAS_DOUBLE_SIDED) !== 0 ? wgsl`if(!frontFacing){N=-N;}` : "";
    const anisotropyCorrection = (ctx._features & PBR_HAS_ANISOTROPY) !== 0 ? wgsl`anisoB=normalize(cross(N,anisoT));` : "";
    return {
        _id: "mesh-blend-normal",
        _varyings: hasTangentNormal ? [{ _name: "worldTangentNormal", _type: "vec3<f32>" }] : undefined,
        _vertexHelperFunctions: wgsl`fn transposeMat3(inMatrix:mat3x3<f32>)->mat3x3<f32>{
let i0=inMatrix[0];let i1=inMatrix[1];let i2=inMatrix[2];
return mat3x3<f32>(vec3<f32>(i0.x,i1.x,i2.x),vec3<f32>(i0.y,i1.y,i2.y),vec3<f32>(i0.z,i1.z,i2.z));
}
fn inverseMat3(inMatrix:mat3x3<f32>)->mat3x3<f32>{
let a00=inMatrix[0][0];let a01=inMatrix[0][1];let a02=inMatrix[0][2];
let a10=inMatrix[1][0];let a11=inMatrix[1][1];let a12=inMatrix[1][2];
let a20=inMatrix[2][0];let a21=inMatrix[2][1];let a22=inMatrix[2][2];
let b01=a22*a11-a12*a21;let b11=-a22*a10+a12*a20;let b21=a21*a10-a11*a20;
let det=a00*b01+a01*b11+a02*b21;
return mat3x3<f32>(b01/det,(-a22*a01+a02*a21)/det,(a12*a01-a02*a11)/det,b11/det,(a22*a00-a02*a20)/det,(-a12*a00+a02*a10)/det,b21/det,(-a21*a00+a01*a20)/det,(a11*a00-a01*a10)/det);
}`,
        _vertexSlots: {
            VB: wgsl`var meshBlendNormalWorld=mat3x3<f32>(finalWorld[0].xyz,finalWorld[1].xyz,finalWorld[2].xyz);
meshBlendNormalWorld=transposeMat3(inverseMat3(meshBlendNormalWorld));
out.worldNormal=normalize(meshBlendNormalWorld*normalize(${localNormal}));
${tangentNormalAssignment}`,
        },
        _fragmentSlots: hasTangentNormal
            ? {
                  AC: wgsl`N=normalize(mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldTangentNormal)*normalMapNorm);
${doubleSidedCorrection}
${anisotropyCorrection}`,
              }
            : undefined,
    };
}

/** @internal Install mesh-blending geometry output only when the typed attachment is requested. */
export function _installMeshBlendingGeometrySupport() {
    if (_extension) {
        return _extension;
    }
    const extension = {
        type: GeometryTextureType.MESH_BLEND_TAG,
        field: (index) => wgsl`@location(${index}) meshBlendTag${index}: u32,`,
        standardWrite: (index, features) =>
            wgsl`out.meshBlendTag${index} = ${
                (features & (HAS_DIFFUSE_TEXTURE | VERTEX_ALPHA)) !== 0
                    ? "select(select(0u, mesh.lc >> 8u, alpha > 0.4), mesh.lc >> 8u, mat.aCut > 0.0)"
                    : "select(0u, mesh.lc >> 8u, alpha > 0.4)"
            };`,
        pbrWrite: (index, features) =>
            wgsl`out.meshBlendTag${index} = ${(features & PBR_HAS_ALPHA_TEST) !== 0 ? "mesh.lc >> 8u" : "select(0u, mesh.lc >> 8u, alpha * material.materialAlpha > 0.4)"};`,
        nodeWrite: (index) => wgsl`out.meshBlendTag${index} = u32(meshU.receivesShadow.x);`,
        value,
        colorTarget,
        validateNode(material) {
            if (material._needsAlphaBlending) {
                throw new Error(
                    "GeometryRendererTask: transparent Node materials cannot write MESH_BLEND_TAG because their graph alpha is unavailable to the geometry terminal. Exclude transparent meshes or omit the tag attachment."
                );
            }
        },
    } satisfies GeometryOutputExtension;
    _extension = extension;
    _installGeometryOutputExtension(extension);
    GEOMETRY_TEXTURE_DESCRIPTIONS[extension.type]!._validate = validateAttachment;
    _registerPbrExt({
        id: "mesh-blend-normal",
        phase: "vertex",
        frag: createNonUniformNormalFragment,
    });
    return extension;
}
