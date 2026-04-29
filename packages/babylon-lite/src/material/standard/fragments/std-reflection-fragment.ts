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
        id: "std-reflection",
        bindings: [
            { name: "reflectionTex", type: { kind: "texture", textureType: "texture_2d<f32>" }, visibility: STAGE_FRAGMENT },
            { name: "reflectionSampler", type: { kind: "sampler", samplerType: "sampler" }, visibility: STAGE_FRAGMENT },
        ],
        helperFunctions: REFLECTION_HELPERS,
        fragmentSlots: {
            AD: `{
var reflCoords: vec2<f32>;
if (mat.rCm < 1.5) { reflCoords = computeSphericalCoords(input.vPositionW, normalW); }
else { reflCoords = computePlanarCoords(input.vPositionW, normalW); }
reflectionColor = textureSample(reflectionTex, reflectionSampler, reflCoords).rgb * mat.rLvl;
}`,
        },
    };
}

import type { StandardMaterialProps } from "../standard-material.js";
import type { Texture2D } from "../../../texture/texture-2d.js";
import type { StdExt } from "../standard-flags.js";
import { HAS_REFLECTION_TEXTURE } from "../standard-flags.js";

export const stdReflectionExt: StdExt = {
    id: "std-reflection",
    phase: "mesh",
    feature: HAS_REFLECTION_TEXTURE,
    frag: createStdReflectionFragment,
    bind(mat, entries, b) {
        const tex = mat.reflectionTexture!;
        entries.push({ binding: b++, resource: tex.texture.createView() });
        entries.push({ binding: b++, resource: tex.sampler });
        return b;
    },
    textures(mat: StandardMaterialProps, out: Texture2D[]): void {
        if (mat.reflectionTexture) {
            out.push(mat.reflectionTexture);
        }
    },
};
