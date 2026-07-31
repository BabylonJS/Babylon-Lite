/** Standard fog helper and final color blend, loaded only by fog scenes. */

import type { ShaderFragment } from "../../shader/fragment-types.js";
import { WGSL_FOG } from "../../shader/wgsl-fog.js";

export const STD_FOG_HELPER = WGSL_FOG;
export const STD_FOG_BLOCK = `if (scene.vFogInfos.x > 0.0) {
let fog = calcFogFactor(input.vf);
color = vec4<f32>(mix(scene.vFogColor.rgb, color.rgb, fog), color.a);
}`;

/** Build the scene-owned fragment that contributes all Standard fog WGSL. */
export function createStandardFogFragment(): ShaderFragment {
    return {
        _id: "std-fog",
        _varyings: [{ _name: "vf", _type: "vec3<f32>" }],
        _helperFunctions: STD_FOG_HELPER,
        _vertexSlots: { VB: "out.vf = (scene.view * vec4<f32>(out.vp, 1.0)).xyz;" },
        _fragmentSlots: { BA: STD_FOG_BLOCK },
    };
}
