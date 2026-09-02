/**
 * Material-agnostic skeletal skinning fragment shared by PBR and Standard.
 * Supports four or eight bone influences per vertex.
 */

import type { ShaderFragment, VertexAttribute } from "../fragment-types.js";
import { wgsl } from "../wgsl.js";

const STAGE_VERTEX = 0x1;

/** Bone-matrix texture reader. Shared verbatim with the GPU picker's deformation projection so a pick
 *  resolves bones exactly the way the render path does. */
export const SKELETON_HELPERS = wgsl`
fn readMatrixFromRawSampler(smp: texture_2d<f32>, index: f32) -> mat4x4<f32> {
let offset = i32(index) * 4;
let m0 = textureLoad(smp, vec2<i32>(offset + 0, 0), 0);
let m1 = textureLoad(smp, vec2<i32>(offset + 1, 0), 0);
let m2 = textureLoad(smp, vec2<i32>(offset + 2, 0), 0);
let m3 = textureLoad(smp, vec2<i32>(offset + 3, 0), 0);
return mat4x4f(m0, m1, m2, m3);
}
`;

/** Emit the bone-blend body. Assigns `finalWorld` from `worldExpr` and the accumulated influence, so
 *  callers must have `finalWorld` in scope. `worldExpr` names the mesh world matrix in the consuming
 *  shader — the render path and the picker's regular/detailed variants use `mesh.world`, while the
 *  picker's thin-instance variant uses the per-instance `world`. */
export function makeSkinningCode(has8Bones: boolean, worldExpr = "mesh.world"): string {
    let code = wgsl`var influence: mat4x4<f32> = readMatrixFromRawSampler(boneSampler, f32(joints[0])) * weights[0];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[1])) * weights[1];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[2])) * weights[2];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[3])) * weights[3];`;
    if (has8Bones) {
        code += wgsl`
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[0])) * weights1[0];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[1])) * weights1[1];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[2])) * weights1[2];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[3])) * weights1[3];`;
    }
    return wgsl`${code}
finalWorld = ${worldExpr} * influence;`;
}

/** Create the shared skeletal skinning shader fragment. */
export function createSkeletonFragment(has8Bones: boolean): ShaderFragment {
    return {
        _id: "skeleton",
        _vertexAttributes: [
            { _name: "joints", _type: "vec4<u32>", _gpuFormat: "uint32x4" as GPUVertexFormat, _arrayStride: 16 },
            { _name: "weights", _type: "vec4<f32>", _gpuFormat: "float32x4" as GPUVertexFormat, _arrayStride: 16 },
            ...(has8Bones
                ? [
                      { _name: "joints1", _type: "vec4<u32>", _gpuFormat: "uint32x4" as GPUVertexFormat, _arrayStride: 16 },
                      { _name: "weights1", _type: "vec4<f32>", _gpuFormat: "float32x4" as GPUVertexFormat, _arrayStride: 16 },
                  ]
                : []),
        ] as VertexAttribute[],
        _vertexBindings: [
            {
                _name: "boneSampler",
                _type: { _kind: "texture", _textureType: "texture_2d<f32>" as const, _sampleType: "unfilterable-float" as const },
                _visibility: STAGE_VERTEX,
            },
        ],
        _vertexHelperFunctions: SKELETON_HELPERS,
        _vertexSlots: { VW: makeSkinningCode(has8Bones) },
    };
}
