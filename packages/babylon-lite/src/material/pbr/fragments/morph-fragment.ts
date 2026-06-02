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
        _id: "morph",

        _vertexBuiltins: [{ _name: "vertexIndex", _builtin: "vertex_index", _type: "u32" }],

        _vertexHelperFunctions: `struct morphUniforms {\nweights: vec4<f32>,\ncount: u32,\ntexWidth: u32,\nrowsPerBand: u32,\n_p0: u32,\n}`,

        _vertexBindings: [
            { _name: "morphTargets", _type: { _kind: "texture", _textureType: "texture_2d<f32>" as const, _sampleType: "unfilterable-float" as const }, _visibility: STAGE_VERTEX },
            { _name: "morph", _type: { _kind: "uniform-buffer" as const }, _visibility: STAGE_VERTEX },
        ],

        _vertexSlots: {
            VR: MORPH_PRE_SKINNING,
        },
    };
}

import type { PbrExt } from "../pbr-flags.js";
import { MSH_HAS_MORPH_TARGETS } from "../../mesh-features.js";

export const pbrExt: PbrExt = {
    id: "morph",
    phase: "vertex",
    frag(ctx) {
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS)) {
            return null;
        }
        return createMorphFragment();
    },
    bind(ctx, entries, b) {
        const mesh = ctx._mesh;
        if (!(ctx._meshFeatures & MSH_HAS_MORPH_TARGETS) || !mesh?.morphTargets) {
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
