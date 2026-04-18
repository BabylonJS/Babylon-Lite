/**
 * Skeleton Fragment
 *
 * Vertex-stage skeletal animation: bone texture sampling + skinning matrix.
 * Only bundled when a scene has skeletal animation.
 * Supports 4-bone and 8-bone skinning.
 */

import type { ShaderFragment, VertexAttribute } from "../../../shader/fragment-types.js";

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
 * @param has8Bones Whether to use 8-bone skinning (joints1/weights1).
 */
export function createSkeletonFragment(has8Bones: boolean): ShaderFragment {
    return {
        id: "skeleton",

        vertexAttributes: [
            { name: "joints", type: "vec4<u32>", gpuFormat: "uint32x4" as GPUVertexFormat, arrayStride: 16 },
            { name: "weights", type: "vec4<f32>", gpuFormat: "float32x4" as GPUVertexFormat, arrayStride: 16 },
            ...(has8Bones
                ? [
                      { name: "joints1", type: "vec4<u32>", gpuFormat: "uint32x4" as GPUVertexFormat, arrayStride: 16 },
                      { name: "weights1", type: "vec4<f32>", gpuFormat: "float32x4" as GPUVertexFormat, arrayStride: 16 },
                  ]
                : []),
        ] as VertexAttribute[],

        vertexBindings: [
            { name: "boneSampler", type: { kind: "texture", textureType: "texture_2d<f32>" as const, sampleType: "unfilterable-float" as const }, visibility: STAGE_VERTEX },
        ],

        vertexHelperFunctions: SKELETON_HELPERS,

        vertexSlots: {
            VW: makeSkinningCode(has8Bones),
        },
    };
}

import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_SKELETON, PBR_HAS_SKELETON_8 } from "../pbr-flags.js";

export const skeletonExt: PbrExt = {
    id: "skeleton",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx.features & PBR_HAS_SKELETON)) {
            return null;
        }
        return createSkeletonFragment((ctx.features & PBR_HAS_SKELETON_8) !== 0);
    },
    bind(ctx, entries, b) {
        const mesh = ctx.mesh as { skeleton?: { boneTexture: GPUTexture } } | undefined;
        if (!(ctx.features & PBR_HAS_SKELETON) || !mesh?.skeleton) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.skeleton.boneTexture.createView() });
        return b;
    },
};
