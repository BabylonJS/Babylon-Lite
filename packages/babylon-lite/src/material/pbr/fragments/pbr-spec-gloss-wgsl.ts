/** Specular-glossiness workflow WGSL — dynamically imported.
 *
 *  Loaded by pbr-renderable only when a material in the group has a specular-glossiness
 *  texture, so metallic-roughness scenes bundle none of it.
 */
import { wgsl } from "../../../shader/wgsl.js";

/** Roughness/metallic from the specular-glossiness texture (glossiness in alpha). */
export function specGlossRoughness(specGlossUV: string): string {
    return wgsl`let specGloss=textureSample(specGlossTexture,specGlossSampler,${specGlossUV});
var roughness=clamp(1.0-specGloss.a,0.0,1.0);
var metallic=0.0;`;
}

/** F0 from the specular color, with energy conservation against the max specular channel. */
export const SPEC_GLOSS_F0 = wgsl`var colorF0=specGloss.rgb;
let colorF90=vec3<f32>(1.0);
let maxSpecular=max(colorF0.r,max(colorF0.g,colorF0.b));
var surfaceAlbedo=baseColor*(1.0-maxSpecular);`;
