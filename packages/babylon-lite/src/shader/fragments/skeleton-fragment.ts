/**
 * Skeleton Fragment (shared)
 *
 * Vertex-stage skeletal animation: bone texture sampling + skinning matrix.
 * Material-agnostic — used by both the PBR and Standard material composers.
 * Only bundled when a scene has skeletal animation. Supports 4-bone and 8-bone
 * skinning.
 *
 * The bone texture is declared as a `_vertexBindings` entry (placed by the
 * composer immediately after the mesh UBO, before base bindings) — exactly as
 * the PBR path has always done. The Standard side reuses this same fragment and
 * relocates the single bone binding to `_bindings` (afterBase) in its own
 * wrapper, so no per-call branch lives in this shared module (keeps the PBR
 * skeleton chunk byte-identical to before the move).
 */

import type { ShaderFragment, VertexAttribute } from "../fragment-types.js";

// WebGPU shader stage constants
const STAGE_VERTEX = 0x1;

const SKELETON_HELPERS = `
fn readMatrixFromRawSampler(smp: texture_2d<f32>, index: f32) -> mat4x4<f32> {
let offset = i32(index) * 4;
let m0 = textureLoad(smp, vec2<i32>(offset + 0, 0), 0);
let m1 = textureLoad(smp, vec2<i32>(offset + 1, 0), 0);
let m2 = textureLoad(smp, vec2<i32>(offset + 2, 0), 0);
let m3 = textureLoad(smp, vec2<i32>(offset + 3, 0), 0);
return mat4x4f(m0, m1, m2, m3);
}
`;

function makeSkinningCode(has8Bones: boolean): string {
    let code = `var influence: mat4x4<f32> = readMatrixFromRawSampler(boneSampler, f32(joints[0])) * weights[0];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[1])) * weights[1];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[2])) * weights[2];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints[3])) * weights[3];`;
    if (has8Bones) {
        code += `
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[0])) * weights1[0];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[1])) * weights1[1];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[2])) * weights1[2];
influence = influence + readMatrixFromRawSampler(boneSampler, f32(joints1[3])) * weights1[3];`;
    }
    code += `\nfinalWorld = mesh.world * influence;`;
    return code;
}

/**
 * Create a skeleton fragment.
 * @param has8Bones - Whether to use 8-bone skinning (joints1/weights1).
 */
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
            { _name: "boneSampler", _type: { _kind: "texture", _textureType: "texture_2d<f32>" as const, _sampleType: "unfilterable-float" as const }, _visibility: STAGE_VERTEX },
        ],

        _vertexHelperFunctions: SKELETON_HELPERS,

        _vertexSlots: {
            VW: makeSkinningCode(has8Bones),
        },
    };
}
