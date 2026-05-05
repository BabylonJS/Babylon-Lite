/** FragCoordBlock — exposes fragment pixel coordinates (`fragmentInputs.position` in BJS WGSL). */

import type { BlockEmitter, NodeValueType } from "../node-types.js";

const OUTPUTS: Record<string, { readonly swizzle: string; readonly type: NodeValueType }> = {
    xyzw: { swizzle: "", type: "vec4f" },
    xyz: { swizzle: ".xyz", type: "vec3f" },
    xy: { swizzle: ".xy", type: "vec2f" },
    x: { swizzle: ".x", type: "f32" },
    y: { swizzle: ".y", type: "f32" },
    z: { swizzle: ".z", type: "f32" },
    w: { swizzle: ".w", type: "f32" },
};

export const emitter: BlockEmitter = {
    className: "FragCoordBlock",
    stage: "fragment",
    emit(_block, outputName, _stage, state) {
        // Babylon.js keeps NME FragCoord aligned with the historical WebGL
        // gl_FragCoord convention (bottom-left origin). WebGPU's fragment
        // position is top-left origin, so flip only the y component here.
        state.usesScreenSize = true;
        const out = OUTPUTS[outputName];
        if (!out) {
            throw new Error(`NodeMaterial: FragCoordBlock has no output "${outputName}"`);
        }
        return { expr: `vec4<f32>(_NME_FRAG_COORD_.x, _NME_SCREEN_SIZE_.y - _NME_FRAG_COORD_.y, _NME_FRAG_COORD_.z, _NME_FRAG_COORD_.w)${out.swizzle}`, type: out.type };
    },
};
