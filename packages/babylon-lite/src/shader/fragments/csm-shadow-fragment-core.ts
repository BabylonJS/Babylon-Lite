/**
 * CSM Shadow Fragment Core — Cascaded Shadow Map receiver WGSL.
 *
 * Generates the per-light WGSL that selects a cascade for the shaded fragment,
 * samples the cascade's depth layer of a `texture_depth_2d_array` with a 5×5 PCF
 * kernel, and (optionally) blends with the next cascade across the slice
 * boundary — matching Babylon.js `computeShadowWithCSMPCF5` + the cascade-select
 * logic in `lightFragment.fx`.
 *
 * This module is isolated from the plain ESM/PCF `shadow-fragment-core` so that
 * scenes without a CSM light never bundle the cascade math.
 *
 * Zero module-level side effects — safe for tree-shaking.
 */

import type { ShaderFragment, BindingDecl, Varying } from "../fragment-types.js";

const STAGE_FRAGMENT = 0x2;

/** Describes one cascaded-shadow light for the fragment generator. */
export interface CsmShadowLightSlot {
    /** Index of this light in the scene.lights array (0-based). */
    lightIndex: number;
}

/**
 * Family-specific knobs for the CSM receiver. Defaults match the Standard
 * material so the Standard path (and its emitted bytes) is unchanged.
 */
export interface CsmShadowFragmentOptions {
    /** WGSL expression yielding the fragment world position (vec3). Default `input.vp` (Standard). */
    worldPosExpr?: string;
    /** WGSL expression yielding the camera view-space z used for cascade selection. Default `input.vf.z` (Standard). */
    viewZExpr?: string;
    /** Fragment slot to emit the per-light shadow code into. Default `AD` (Standard). */
    outputSlot?: "AD" | "AS";
}

/**
 * Create a per-light CSM shadow fragment.
 * The shadow factor for each light is stored in `shadowFactors[lightIndex]`.
 *
 * The receiver reuses base varyings for world position and camera view-space z
 * (instead of emitting per-cascade light-space varyings): the view-space z
 * selects the cascade and the world position is transformed by the selected
 * cascade matrix in the fragment shader. The exact varying expressions and the
 * output slot are supplied per material family via {@link CsmShadowFragmentOptions}
 * (defaults match Standard: `input.vp` / `input.vf.z` / slot `AD`).
 */
export function createCsmShadowFragment(id: string, shadowLights: CsmShadowLightSlot[], opts: CsmShadowFragmentOptions = {}): ShaderFragment {
    const worldPosExpr = opts.worldPosExpr ?? "input.vp";
    const viewZExpr = opts.viewZExpr ?? "input.vf.z";
    const outputSlot = opts.outputSlot ?? "AD";
    const varyings: Varying[] = [];
    const bindings: BindingDecl[] = [];
    const fragmentLines: string[] = [];
    const helperParts: string[] = [];

    for (const slot of shadowLights) {
        const li = slot.lightIndex;
        const suffix = `_${li}`;

        bindings.push(
            { _name: `csmTex${suffix}`, _type: { _kind: "texture", _textureType: "texture_depth_2d_array", _sampleType: "depth" }, _group: "shadow", _visibility: STAGE_FRAGMENT },
            { _name: `csmComp${suffix}`, _type: { _kind: "sampler", _samplerType: "sampler_comparison" }, _group: "shadow", _visibility: STAGE_FRAGMENT },
            { _name: `csmInfo${suffix}`, _type: { _kind: "uniform-buffer" }, _group: "shadow", _visibility: STAGE_FRAGMENT }
        );

        helperParts.push(
            `struct csmInfo${suffix}Uniforms { cascadeTransforms: array<mat4x4<f32>, 4>, viewFrustumZ: vec4<f32>, frustumLengths: vec4<f32>, shadowsInfo: vec4<f32>, csmParams: vec4<f32> };`
        );
        helperParts.push(`
fn computeFallOffCsm${suffix}(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
return mix(value, 1.0, mask);
}
fn csmSample${suffix}(layer: i32, worldPos: vec4<f32>) -> f32 {
let posFromLight = csmInfo${suffix}.cascadeTransforms[layer] * worldPos;
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);
let mapSz = csmInfo${suffix}.shadowsInfo.y;
let invMapSz = csmInfo${suffix}.shadowsInfo.z;
var tc = uv * mapSz + 0.5;
let st = fract(tc);
let base = (floor(tc) - 0.5) * invMapSz;
let uvw0 = 4.0 - 3.0 * st;
let uvw1 = vec2<f32>(7.0);
let uvw2 = 1.0 + 3.0 * st;
let u = vec3<f32>((3.0 - 2.0 * st.x) / uvw0.x - 2.0, (3.0 + st.x) / uvw1.x, st.x / uvw2.x + 2.0) * invMapSz;
let v = vec3<f32>((3.0 - 2.0 * st.y) / uvw0.y - 2.0, (3.0 + st.y) / uvw1.y, st.y / uvw2.y + 2.0) * invMapSz;
var sh = 0.0;
sh += uvw0.x * uvw0.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[0], v[0]), layer, depthRef);
sh += uvw1.x * uvw0.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[1], v[0]), layer, depthRef);
sh += uvw2.x * uvw0.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[2], v[0]), layer, depthRef);
sh += uvw0.x * uvw1.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[0], v[1]), layer, depthRef);
sh += uvw1.x * uvw1.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[1], v[1]), layer, depthRef);
sh += uvw2.x * uvw1.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[2], v[1]), layer, depthRef);
sh += uvw0.x * uvw2.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[0], v[2]), layer, depthRef);
sh += uvw1.x * uvw2.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[1], v[2]), layer, depthRef);
sh += uvw2.x * uvw2.y * textureSampleCompareLevel(csmTex${suffix}, csmComp${suffix}, base + vec2<f32>(u[2], v[2]), layer, depthRef);
sh /= 144.0;
sh = mix(csmInfo${suffix}.shadowsInfo.x, 1.0, sh);
return computeFallOffCsm${suffix}(sh, clipSpace.xy, csmInfo${suffix}.shadowsInfo.w);
}
fn computeShadowCSM${suffix}(worldPos: vec4<f32>, viewZ: f32) -> f32 {
let nCascades = i32(csmInfo${suffix}.csmParams.x);
var idx = -1;
var diff = 0.0;
for (var i = 0; i < nCascades; i = i + 1) {
diff = csmInfo${suffix}.viewFrustumZ[i] - viewZ;
if (diff >= 0.0) { idx = i; break; }
}
if (idx < 0) { idx = nCascades - 1; }
var shadow = csmSample${suffix}(idx, worldPos);
let frustumLength = csmInfo${suffix}.frustumLengths[idx];
let diffRatio = clamp(diff / frustumLength, 0.0, 1.0) * csmInfo${suffix}.csmParams.y;
if (idx < nCascades - 1 && diffRatio < 1.0) {
let nextShadow = csmSample${suffix}(idx + 1, worldPos);
shadow = mix(nextShadow, shadow, diffRatio);
}
return shadow;
}`);

        fragmentLines.push(`shadowFactors[${li}] = computeShadowCSM${suffix}(vec4<f32>(${worldPosExpr}, 1.0), ${viewZExpr});`);
    }

    return {
        _id: id,
        _varyings: varyings,
        _bindings: bindings,
        _helperFunctions: helperParts.join("\n"),
        _fragmentSlots: {
            [outputSlot]: fragmentLines.join("\n"),
        },
    };
}
