/** Node Material — shadow emission (dynamically imported).
 *
 *  This module is imported ONLY when `parseNodeMaterialFromSnippet` receives
 *  `shadowGenerators`. Scenes without shadows never bundle it, keeping the
 *  shadow WGSL (PCF/ESM helper fns + binding wiring) off the critical path.
 *
 *  Emits three things per shadow light (texture + sampler + shadowInfo UBO)
 *  plus the vertex-stage varying computations and the fragment-stage
 *  `nme_computeShadowFactors(input)` dispatcher consumed by the LightBlock.
 */

import { SS } from "../../engine/gpu-flags.js";
import { MAX_LIGHTS } from "../../light/types.js";
import type { Varying } from "../../shader/fragment-types.js";

const SHADOW_FACTORS_TYPE = `array<f32, ${MAX_LIGHTS}>`;
const SHADOW_FACTORS_ONE = `${SHADOW_FACTORS_TYPE}(${/* @__PURE__ */ new Array(MAX_LIGHTS).fill("1.0").join(", ")})`;

/** @internal */
export interface ShadowBinding {
    /** @internal */
    readonly _lightIndex: number;
    /** @internal */
    readonly _texBinding: number;
    /** @internal */
    readonly _sampBinding: number;
    /** @internal */
    readonly _uboBinding: number;
    /** @internal */
    readonly _shadowType: "esm" | "pcf";
}

export interface ShadowEmit {
    /** @internal One per shadow-casting light (3 binding slots each). */
    readonly _bindings: readonly ShadowBinding[];
    /** @internal Module-scope WGSL: struct + binding decls + compute fns. */
    readonly _wgslDecls: string;
    /** @internal `nme_computeShadowFactors(input) -> array<f32, MAX_LIGHTS>` called from light blocks. */
    readonly _fragmentHelper: string;
    /** @internal Injected into vs_main body: populates vPosFromLight_i + vDepthMetric_i varyings. */
    readonly _vertexInject: string;
    /** @internal GPU BGL entries for group 1 (append to meshBglEntries). */
    readonly _bglEntries: readonly GPUBindGroupLayoutEntry[];
    /** @internal Total bindings consumed (= shadowLights.length * 3). */
    readonly _bindingCount: number;
}

/** Emit shadow WGSL + bindings for a NodeMaterial.
 *  Mutates `varyings` (pushes vPosFromLight_i + vDepthMetric_i per light) so
 *  buildVertexOut picks them up.
 */
export function emitShadow(shadowLights: readonly { lightIndex: number; shadowType: "esm" | "pcf" }[], startBinding: number, varyings: Varying[]): ShadowEmit {
    const _bindings: ShadowBinding[] = [];
    const wgslDecls: string[] = [];
    const _bglEntries: GPUBindGroupLayoutEntry[] = [];
    for (const sl of shadowLights) {
        const suf = `_${sl.lightIndex}`;
        if (!varyings.some((v) => v._name === `vPosFromLight${suf}`)) {
            varyings.push({ _name: `vPosFromLight${suf}`, _type: "vec4<f32>" });
        }
        if (!varyings.some((v) => v._name === `vDepthMetric${suf}`)) {
            varyings.push({ _name: `vDepthMetric${suf}`, _type: "f32" });
        }
    }
    const vertLines: string[] = [`let _shadowWp4 = meshU.world * vec4<f32>(in.position, 1.0);`];
    const dispatchLines: string[] = [`var _sf = ${SHADOW_FACTORS_ONE};`];
    let nextBinding = startBinding;
    for (const sl of shadowLights) {
        const suf = `_${sl.lightIndex}`;
        const _lightIndex = sl.lightIndex;
        const _texBinding = nextBinding++;
        const _sampBinding = nextBinding++;
        const _uboBinding = nextBinding++;
        const _shadowType = sl.shadowType;
        _bindings.push({ _lightIndex, _texBinding, _sampBinding, _uboBinding, _shadowType });
        wgslDecls.push(
            `struct shadowInfo${suf}Uniforms { lightMatrix: mat4x4<f32>, depthValues: vec4<f32>, shadowsInfo: vec4<f32> };`,
            `@group(1) @binding(${_uboBinding}) var<uniform> shadowInfo${suf}: shadowInfo${suf}Uniforms;`
        );
        if (sl.shadowType === "pcf") {
            wgslDecls.push(
                `@group(1) @binding(${_texBinding}) var shadowTex${suf}: texture_depth_2d;`,
                `@group(1) @binding(${_sampBinding}) var shadowComp${suf}: sampler_comparison;`,
                `fn computeShadowPCF${suf}(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, mapSz: f32, invMapSz: f32) -> f32 {
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
    sh += uvw0.x * uvw0.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[0], v[0]), depthRef);
    sh += uvw1.x * uvw0.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[1], v[0]), depthRef);
    sh += uvw2.x * uvw0.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[2], v[0]), depthRef);
    sh += uvw0.x * uvw1.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[0], v[1]), depthRef);
    sh += uvw1.x * uvw1.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[1], v[1]), depthRef);
    sh += uvw2.x * uvw1.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[2], v[1]), depthRef);
    sh += uvw0.x * uvw2.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[0], v[2]), depthRef);
    sh += uvw1.x * uvw2.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[1], v[2]), depthRef);
    sh += uvw2.x * uvw2.y * textureSampleCompareLevel(shadowTex${suf}, shadowComp${suf}, base + vec2<f32>(u[2], v[2]), depthRef);
    sh /= 144.0;
    return mix(darkness, 1.0, sh);
}`
            );
            dispatchLines.push(
                `_sf[${sl.lightIndex}] = computeShadowPCF${suf}(input.vPosFromLight${suf}, input.vDepthMetric${suf}, shadowInfo${suf}.shadowsInfo.x, shadowInfo${suf}.shadowsInfo.y, shadowInfo${suf}.shadowsInfo.z);`
            );
            _bglEntries.push(
                { binding: _texBinding, visibility: SS.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d" } },
                { binding: _sampBinding, visibility: SS.FRAGMENT, sampler: { type: "comparison" } }
            );
        } else {
            wgslDecls.push(
                `@group(1) @binding(${_texBinding}) var shadowTex${suf}: texture_2d<f32>;`,
                `@group(1) @binding(${_sampBinding}) var shadowSamp${suf}: sampler;`,
                `fn computeFallOff${suf}(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
    let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
    return mix(value, 1.0, mask);
}
fn computeShadowESM${suf}(posFromLight: vec4<f32>, depthMetric: f32, darkness: f32, depthScale: f32, frustumEdgeFalloff: f32) -> f32 {
    let clipSpace = posFromLight.xyz / posFromLight.w;
    let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
    if (depthMetric < 0.0 || depthMetric > 1.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }
    let shadowPixelDepth = clamp(depthMetric, 0.0, 1.0);
    let shadowMapSample = textureSampleLevel(shadowTex${suf}, shadowSamp${suf}, uv, 0.0).x;
    let esm = 1.0 - clamp(exp(min(87.0, depthScale * shadowPixelDepth)) * shadowMapSample, 0.0, 1.0 - darkness);
    return computeFallOff${suf}(esm, clipSpace.xy, frustumEdgeFalloff);
}`
            );
            dispatchLines.push(
                `_sf[${sl.lightIndex}] = computeShadowESM${suf}(input.vPosFromLight${suf}, input.vDepthMetric${suf}, shadowInfo${suf}.shadowsInfo.x, shadowInfo${suf}.shadowsInfo.z, shadowInfo${suf}.shadowsInfo.w);`
            );
            _bglEntries.push(
                { binding: _texBinding, visibility: SS.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
                { binding: _sampBinding, visibility: SS.FRAGMENT, sampler: { type: "filtering" } }
            );
        }
        vertLines.push(
            `out.vPosFromLight${suf} = shadowInfo${suf}.lightMatrix * _shadowWp4;`,
            `out.vDepthMetric${suf} = (out.vPosFromLight${suf}.z + shadowInfo${suf}.depthValues.x) / shadowInfo${suf}.depthValues.y;`
        );
        _bglEntries.push({
            binding: _uboBinding,
            visibility: SS.VERTEX | SS.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: 96 },
        });
    }
    dispatchLines.push(`for (var _i = 0u; _i < ${MAX_LIGHTS}u; _i++) { _sf[_i] = mix(1.0, _sf[_i], meshU.receivesShadow.x); }`);
    dispatchLines.push(`return _sf;`);
    return {
        _bindings,
        _wgslDecls: wgslDecls.join("\n"),
        _fragmentHelper: `fn nme_computeShadowFactors(input: VertexOut) -> ${SHADOW_FACTORS_TYPE} {\n    ${dispatchLines.join("\n    ")}\n}`,
        _vertexInject: vertLines.join("\n    "),
        _bglEntries,
        _bindingCount: shadowLights.length * 3,
    };
}
