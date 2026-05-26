/** Standard Reflection Texture Fragment — spherical/planar environment reflection. */
import type { ShaderFragment } from "../../../shader/fragment-types.js";

const STAGE_FRAGMENT = 0x2;

const REFLECTION_HELPERS = `
fn computeSphericalCoords(worldPos: vec3<f32>, worldNormal: vec3<f32>) -> vec2<f32> {
let viewDir = normalize((scene.view * vec4<f32>(worldPos, 1.0)).xyz);
let viewNormal = normalize((scene.view * vec4<f32>(worldNormal, 0.0)).xyz);
var r = reflect(viewDir, viewNormal);
r.z = r.z - 1.0;
let m = 2.0 * length(r);
return vec2<f32>(r.x / m + 0.5, r.y / m + 0.5);
}
fn computePlanarCoords(worldPos: vec3<f32>, worldNormal: vec3<f32>) -> vec2<f32> {
let viewDir = worldPos - scene.vEyePosition.xyz;
let coords = normalize(reflect(viewDir, worldNormal));
return vec2<f32>(coords.x, 1.0 - coords.y);
}
`;

export function createStdReflectionFragment(): ShaderFragment {
    return {
        _id: "std-reflection",
        _bindings: [
            { _name: "rT", _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: STAGE_FRAGMENT },
            { _name: "rS", _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: STAGE_FRAGMENT },
        ],
        _helperFunctions: REFLECTION_HELPERS,
        _fragmentSlots: {
            AD: `{
var reflCoords: vec2<f32>;
if (mat.rCm < 1.5) { reflCoords = computeSphericalCoords(input.vp, normalW); }
else { reflCoords = computePlanarCoords(input.vp, normalW); }
reflectionColor = textureSample(rT, rS, reflCoords).rgb * mat.rLvl;
}`,
        },
    };
}

import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_REFLECTION_TEXTURE } from "../standard-flags.js";

export const stdReflectionExt: StdExt = {
    _id: "std-reflection",
    _phase: "mesh",
    _feature: HAS_REFLECTION_TEXTURE,
    _frag: createStdReflectionFragment,
    _bind(mat, entries, b) {
        const tex = mat.reflectionTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    _textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.reflectionTexture) {
            out.push(mat.reflectionTexture);
        }
    },
};
