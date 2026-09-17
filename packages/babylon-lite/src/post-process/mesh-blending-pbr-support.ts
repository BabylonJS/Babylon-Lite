import type { Mesh } from "../mesh/mesh.js";
import { MSH_HAS_TANGENTS } from "../material/mesh-features.js";
import { PBR_HAS_NORMAL_MAP, _registerPbrExt, _registerPbrSceneHook, type _PbrFragCtx } from "../material/pbr/pbr-flags.js";
import type { ShaderFragment } from "../shader/fragment-types.js";
import { wgsl } from "../shader/wgsl.js";

export const _MESH_BLENDING_NON_UNIFORM_SCALING = 1 << 16;

let _installed = false;

function hasNonUniformScaling(mesh: Mesh): boolean {
    const world = mesh.worldMatrix;
    const scaleX2 = world[0]! * world[0]! + world[1]! * world[1]! + world[2]! * world[2]!;
    const scaleY2 = world[4]! * world[4]! + world[5]! * world[5]! + world[6]! * world[6]!;
    const scaleZ2 = world[8]! * world[8]! + world[9]! * world[9]! + world[10]! * world[10]!;
    const maximumScale2 = Math.max(scaleX2, scaleY2, scaleZ2);
    const minimumScale2 = Math.min(scaleX2, scaleY2, scaleZ2);
    const scaleTolerance = Math.max(maximumScale2, 1) * 1e-6;
    const dotXY = world[0]! * world[4]! + world[1]! * world[5]! + world[2]! * world[6]!;
    const dotXZ = world[0]! * world[8]! + world[1]! * world[9]! + world[2]! * world[10]!;
    const dotYZ = world[4]! * world[8]! + world[5]! * world[9]! + world[6]! * world[10]!;
    return (
        maximumScale2 - minimumScale2 > scaleTolerance ||
        Math.abs(dotXY) > Math.max(Math.sqrt(scaleX2 * scaleY2), 1) * 1e-6 ||
        Math.abs(dotXZ) > Math.max(Math.sqrt(scaleX2 * scaleZ2), 1) * 1e-6 ||
        Math.abs(dotYZ) > Math.max(Math.sqrt(scaleY2 * scaleZ2), 1) * 1e-6
    );
}

function createNonUniformNormalFragment(ctx: _PbrFragCtx): ShaderFragment | null {
    if ((ctx._meshFeatures & _MESH_BLENDING_NON_UNIFORM_SCALING) === 0) {
        return null;
    }
    const hasTangentNormal = (ctx._features & PBR_HAS_NORMAL_MAP) !== 0 && (ctx._meshFeatures & MSH_HAS_TANGENTS) !== 0;
    return {
        _id: "mesh-blending-non-uniform-normal",
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
        _pc: (composed) => {
            let vertexWGSL: string = composed._vertexWGSL.replace(
                /out\.worldNormal\s*=\s*\(\s*finalWorld\s*\*\s*vec4<f32>\(\s*normalize\((normal|morphedNorm)\)\s*,\s*0(?:\.0)?\s*\)\s*\)\.xyz\s*;/,
                (_match, normal: string) =>
                    `var normalWorld=mat3x3<f32>(finalWorld[0].xyz,finalWorld[1].xyz,finalWorld[2].xyz);normalWorld=transposeMat3(inverseMat3(normalWorld));out.worldNormal=normalize(normalWorld*normalize(${normal}));`
            );
            if (vertexWGSL === composed._vertexWGSL) {
                throw new Error("Mesh blending: PBR world-normal shader contract changed.");
            }
            let fragmentWGSL: string = composed._fragmentWGSL;
            if (hasTangentNormal) {
                const patchedVertex = vertexWGSL.replace(
                    /out\.worldBitangent\s*=\s*\(\s*finalWorld\s*\*\s*vec4<f32>\(\s*B_local\s*,\s*0(?:\.0)?\s*\)\s*\)\.xyz\s*;/,
                    "out.worldBitangent=(finalWorld*vec4<f32>(B_local,0.0)).xyz;out.worldTangentNormal=(finalWorld*vec4<f32>(N_local,0.0)).xyz;"
                );
                if (patchedVertex === vertexWGSL) {
                    throw new Error("Mesh blending: PBR tangent shader contract changed.");
                }
                vertexWGSL = patchedVertex;
                const patchedFragment = fragmentWGSL.replace(
                    /mat3x3<f32>\(\s*input\.worldTangent\s*,\s*input\.worldBitangent\s*,\s*input\.worldNormal\s*\)/,
                    "mat3x3<f32>(input.worldTangent,input.worldBitangent,input.worldTangentNormal)"
                );
                if (patchedFragment === fragmentWGSL) {
                    throw new Error("Mesh blending: PBR TBN shader contract changed.");
                }
                fragmentWGSL = patchedFragment;
            }
            return { ...composed, _vertexWGSL: wgsl`${vertexWGSL}`, _fragmentWGSL: wgsl`${fragmentWGSL}` };
        },
    };
}

async function prepareMeshBlendingPbrSupport(_scene: unknown, _engine: unknown, meshes: readonly Mesh[]): Promise<void> {
    for (const mesh of meshes) {
        const primitiveFeatures = (mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0;
        (mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures = hasNonUniformScaling(mesh)
            ? primitiveFeatures | _MESH_BLENDING_NON_UNIFORM_SCALING
            : primitiveFeatures & ~_MESH_BLENDING_NON_UNIFORM_SCALING;
    }
    _registerPbrExt({
        id: "mesh-blending-non-uniform-normal",
        phase: "vertex",
        frag: createNonUniformNormalFragment,
    });
}

/** @internal Install PBR parity support only when a mesh-blending task is created. */
export function _installMeshBlendingPbrSupport(): void {
    if (_installed) {
        return;
    }
    _installed = true;
    _registerPbrSceneHook(prepareMeshBlendingPbrSupport);
}
