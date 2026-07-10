/**
 * Khronos PBR Neutral tone mapping WGSL.
 * Kept in a separate module so scenes using the default exponential (standard)
 * tone mapping don't pay the string cost: `NeutralToneMapping` is only bundled
 * when the app references it (e.g. `setSceneImageProcessing(scene, { toneMapping: NeutralToneMapping })`).
 *
 * Ported from Babylon.js `TONEMAPPING_KHR_PBR_NEUTRAL` (see the Khronos reference
 * at https://modelviewer.dev/examples/tone-mapping). The Neutral operator preserves
 * hue/saturation in the mid-tones and only desaturates the brightest highlights,
 * so albedo colors stay faithful compared to ACES.
 */

import type { ToneMapping } from "./tone-mapping.js";

export const NEUTRAL_HELPERS_WGSL = `
const PBRNeutralStartCompression: f32 = 0.8 - 0.04;
const PBRNeutralDesaturation: f32 = 0.15;
fn PBRNeutralToneMapping(color: vec3<f32>) -> vec3<f32> {
    let x = min(color.r, min(color.g, color.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    var result = color - offset;
    let peak = max(result.r, max(result.g, result.b));
    if (peak < PBRNeutralStartCompression) { return result; }
    let d = 1.0 - PBRNeutralStartCompression;
    let newPeak = 1.0 - d * d / (peak + d - PBRNeutralStartCompression);
    result *= newPeak / peak;
    let g = 1.0 - 1.0 / (PBRNeutralDesaturation * (peak - newPeak) + 1.0);
    return mix(result, newPeak * vec3<f32>(1.0, 1.0, 1.0), g);
}
`;

export const NEUTRAL_TONEMAP_CALL_WGSL = `color *= scene.vImageInfos.x;
color = PBRNeutralToneMapping(color);`;

/** Khronos PBR Neutral tone mapping (Babylon.js `TONEMAPPING_KHR_PBR_NEUTRAL`). */
export const NeutralToneMapping: ToneMapping = {
    id: "neutral",
    helpersWGSL: NEUTRAL_HELPERS_WGSL,
    callWGSL: NEUTRAL_TONEMAP_CALL_WGSL,
};
