/**
 * Morph Target Fragment
 *
 * Vertex-stage morph target animation: texture-based morph deltas
 * applied before skinning. Only bundled when a scene uses morph targets.
 */

import type { ShaderFragment } from "../../../shader/fragment-types.js";

// WebGPU shader stage constants
const STAGE_VERTEX = 0x1;

const MORPH_PRE_SKINNING = `var morphedPos = position;
var morphedNorm = normal;
let mCol = i32(vertexIndex % morph.texWidth);
let mRowInBand = i32(vertexIndex / morph.texWidth);
for (var i = 0u; i < morph.count; i = i + 1u) {
  let w = morph.weights[i];
  let posBase = i32(i * 2u) * i32(morph.rowsPerBand);
  let normBase = i32(i * 2u + 1u) * i32(morph.rowsPerBand);
  morphedPos = morphedPos + w * textureLoad(morphTargets, vec2<i32>(mCol, posBase + mRowInBand), 0).xyz;
  morphedNorm = morphedNorm + w * textureLoad(morphTargets, vec2<i32>(mCol, normBase + mRowInBand), 0).xyz;
}`;

/**
 * Create a morph target fragment.
 * The morph extension modifies position/normal variables before the world
 * transform, using morphedPos/morphedNorm in place of position/normal.
 */
export function createMorphFragment(): ShaderFragment {
    return {
        id: "morph",

        vertexBuiltins: [{ name: "vertexIndex", builtin: "vertex_index", type: "u32" }],

        vertexHelperFunctions: `struct morphUniforms {\nweights: vec4<f32>,\ncount: u32,\ntexWidth: u32,\nrowsPerBand: u32,\n_p0: u32,\n}`,

        vertexBindings: [
            { name: "morphTargets", type: { kind: "texture", textureType: "texture_2d<f32>" as const, sampleType: "unfilterable-float" as const }, visibility: STAGE_VERTEX },
            { name: "morph", type: { kind: "uniform-buffer" as const }, visibility: STAGE_VERTEX },
        ],

        vertexSlots: {
            VR: MORPH_PRE_SKINNING,
        },
    };
}

import type { PbrExt } from "../pbr-flags.js";
import { PBR_HAS_MORPH_TARGETS } from "../pbr-flags.js";

export const morphExt: PbrExt = {
    id: "morph",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx.features & PBR_HAS_MORPH_TARGETS)) {
            return null;
        }
        return createMorphFragment();
    },
    bind(ctx, entries, b) {
        const mesh = ctx.mesh as { morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } } | undefined;
        if (!(ctx.features & PBR_HAS_MORPH_TARGETS) || !mesh?.morphTargets) {
            return b;
        }
        entries.push({ binding: b++, resource: mesh.morphTargets.texture.createView() });
        // Weights UBO is pushed separately by the pipeline (needs engine-side buffer handle).
        // Caller supplies weightsBuffer on mesh.morphTargets.
        if (mesh.morphTargets.weightsBuffer) {
            entries.push({ binding: b++, resource: { buffer: mesh.morphTargets.weightsBuffer } });
        }
        return b;
    },
};
