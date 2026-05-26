/**
 * Shadow Fragment Core — Shared WGSL Generation for Shadows
 *
 * Contains the shadow sampling WGSL codegen shared by both Standard and PBR
 * materials. Each material wrapper calls `createShadowFragment` with its own
 * fragment ID ("std-shadow" / "pbr-shadow"), keeping the generated shader
 * code byte-for-byte identical.
 *
 * Zero module-level side effects — safe for tree-shaking.
 */

import type { ShaderFragment, BindingDecl, Varying } from "../fragment-types.js";

const STAGE_FRAGMENT = 0x2;
const STAGE_VERTEX = 0x1;

/** Describes one shadow-casting light for the fragment generator. */
export interface ShadowLightSlot {
    /** Index of this light in the scene.lights array (0-based). */
    lightIndex: number;
    /** Shadow type for this light. */
    shadowType: "esm" | "pcf";
}

/**
 * Create a per-light shadow fragment.
 * Each shadow-casting light gets its own varying, bindings, and sampling code.
 * The shadow factor for each light is stored in shadowFactors[lightIndex].
 */
export function createShadowFragment(id: string, shadowLights: ShadowLightSlot[]): ShaderFragment {
    const varyings: Varying[] = [];
    const bindings: BindingDecl[] = [];
    const vertexLines: string[] = [];
    const fragmentLines: string[] = [];
    const helperParts: string[] = [];

    for (const slot of shadowLights) {
        const li = slot.lightIndex;
        const suffix = `_${li}`;

        varyings.push({ _name: `vPosFromLight${suffix}`, _type: "vec4<f32>" }, { _name: `vDepthMetric${suffix}`, _type: "f32" });

        if (slot.shadowType === "pcf") {
            bindings.push(
                { _name: `shadowTex${suffix}`, _type: { _kind: "texture", _textureType: "texture_depth_2d", _sampleType: "depth" }, _group: "shadow", _visibility: STAGE_FRAGMENT },
                { _name: `shadowComp${suffix}`, _type: { _kind: "sampler", _samplerType: "sampler_comparison" }, _group: "shadow", _visibility: STAGE_FRAGMENT }
            );
        } else {
            bindings.push(
                { _name: `shadowTex${suffix}`, _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _group: "shadow", _visibility: STAGE_FRAGMENT },
                { _name: `shadowSamp${suffix}`, _type: { _kind: "sampler", _samplerType: "sampler" }, _group: "shadow", _visibility: STAGE_FRAGMENT }
            );
        }
        bindings.push({ _name: `shadowInfo${suffix}`, _type: { _kind: "uniform-buffer" }, _group: "shadow", _visibility: STAGE_FRAGMENT | STAGE_VERTEX });

        vertexLines.push(
            `out.vPosFromLight${suffix} = shadowInfo${suffix}.lightMatrix * worldPos4;`,
            `out.vDepthMetric${suffix} = (out.vPosFromLight${suffix}.z + shadowInfo${suffix}.depthValues.x) / shadowInfo${suffix}.depthValues.y;`
        );

        if (slot.shadowType === "pcf") {
            fragmentLines.push(
                `shadowFactors[${li}] = computeShadowPCF${suffix}(input.vPosFromLight${suffix}, input.vDepthMetric${suffix}, shadowInfo${suffix}.shadowsInfo.x, shadowInfo${suffix}.shadowsInfo.y, shadowInfo${suffix}.shadowsInfo.z);`
            );
        } else {
            fragmentLines.push(
                `shadowFactors[${li}] = computeShadowESM${suffix}(input.vPosFromLight${suffix}, input.vDepthMetric${suffix}, shadowInfo${suffix}.shadowsInfo.x, shadowInfo${suffix}.shadowsInfo.z, shadowInfo${suffix}.shadowsInfo.w);`
            );
        }
    }

    // Helper structs + sampling functions
    for (const slot of shadowLights) {
        const li = slot.lightIndex;
        const suffix = `_${li}`;
        helperParts.push(`struct shadowInfo${suffix}Uniforms { lightMatrix: mat4x4<f32>, depthValues: vec4<f32>, shadowsInfo: vec4<f32> };`);

        if (slot.shadowType === "pcf") {
            helperParts.push(`
fn computeShadowPCF${suffix}(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, mapSz: f32, invMapSz: f32) -> f32 {
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
if (depthMetric < 0.0 || depthMetric > 1.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
let depthRef = clamp(clipSpace.z, 0.0, 1.0);
var tc = uv * mapSz + 0.5;
let st = fract(tc);
let base = (floor(tc) - 0.5) * invMapSz;
let uvw0 = 4.0 - 3.0 * st;
let uvw1 = vec2<f32>(7.0);
let uvw2 = 1.0 + 3.0 * st;
let u = vec3<f32>((3.0 - 2.0 * st.x) / uvw0.x - 2.0, (3.0 + st.x) / uvw1.x, st.x / uvw2.x + 2.0) * invMapSz;
let v = vec3<f32>((3.0 - 2.0 * st.y) / uvw0.y - 2.0, (3.0 + st.y) / uvw1.y, st.y / uvw2.y + 2.0) * invMapSz;
var sh = 0.0;
sh += uvw0.x * uvw0.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[0], v[0]), depthRef);
sh += uvw1.x * uvw0.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[1], v[0]), depthRef);
sh += uvw2.x * uvw0.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[2], v[0]), depthRef);
sh += uvw0.x * uvw1.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[0], v[1]), depthRef);
sh += uvw1.x * uvw1.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[1], v[1]), depthRef);
sh += uvw2.x * uvw1.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[2], v[1]), depthRef);
sh += uvw0.x * uvw2.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[0], v[2]), depthRef);
sh += uvw1.x * uvw2.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[1], v[2]), depthRef);
sh += uvw2.x * uvw2.y * textureSampleCompareLevel(shadowTex${suffix}, shadowComp${suffix}, base + vec2<f32>(u[2], v[2]), depthRef);
sh /= 144.0;
return mix(darkness, 1.0, sh);
}`);
        } else {
            helperParts.push(`
fn computeFallOff${suffix}(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
return mix(value, 1.0, mask);
}
fn computeShadowESM${suffix}(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, depthScale: f32, frustumEdgeFalloff: f32) -> f32 {
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
if (depthMetric < 0.0 || depthMetric > 1.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
let shadowPixelDepth = clamp(depthMetric, 0.0, 1.0);
let shadowMapSample = textureSampleLevel(shadowTex${suffix}, shadowSamp${suffix}, uv, 0.0).x;
let esm = 1.0 - clamp(exp(min(87.0, depthScale * shadowPixelDepth)) * shadowMapSample, 0.0, 1.0 - darkness);
return computeFallOff${suffix}(esm, clipSpace.xy, frustumEdgeFalloff);
}`);
        }
    }

    // Vertex helper: UBO struct declarations (needed for lightMatrix access in vertex shader)
    const vertexHelperParts: string[] = [];
    for (const slot of shadowLights) {
        const suffix = `_${slot.lightIndex}`;
        vertexHelperParts.push(`struct shadowInfo${suffix}Uniforms { lightMatrix: mat4x4<f32>, depthValues: vec4<f32>, shadowsInfo: vec4<f32> };`);
    }

    return {
        _id: id,
        _varyings: varyings,
        _bindings: bindings,
        _helperFunctions: helperParts.join("\n"),
        _vertexHelperFunctions: vertexHelperParts.join("\n"),
        _vertexSlots: {
            VB: vertexLines.join("\n"),
        },
        _fragmentSlots: {
            AD: fragmentLines.join("\n"),
        },
    };
}
