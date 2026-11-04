/** Node shadow bindings and dispatch, with algorithm code prepared asynchronously. */

import { SS } from "../../engine/gpu-flags.js";
import { MAX_LIGHTS } from "../../light/types.js";
import type { Varying } from "../../shader/fragment-types.js";
import { wgsl } from "../../shader/wgsl.js";
import { loadShadowAlgorithms, shadowProjectionCode, type PreparedShadowAlgorithms } from "../../shader/fragments/shadow-algorithms.js";

const SHADOW_FACTORS_TYPE = wgsl`array<f32, ${MAX_LIGHTS}>`;
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

/** @internal A synchronous emitter whose sampling algorithms have already been loaded. */
export type NodeShadowEmitter = (shadowLights: readonly { lightIndex: number; shadowType: "esm" | "pcf" }[], startBinding: number, varyings: Varying[]) => ShadowEmit;

/** @internal Prepare algorithm code before synchronous pipeline or material-view compilation. */
export async function prepareNodeShadowEmitter(shadowLights: Parameters<NodeShadowEmitter>[0]): Promise<NodeShadowEmitter> {
    const algorithms = await loadShadowAlgorithms(shadowLights);
    return (slots, startBinding, varyings) => emitPreparedShadow(slots, startBinding, varyings, algorithms);
}

function appendVarying(varyings: Varying[], name: string, type: Varying["_type"]): void {
    if (!varyings.some((varying) => varying._name === name)) {
        varyings.push({ _name: name, _type: type });
    }
}

/** Emit shadow WGSL + bindings for a NodeMaterial.
 *  Mutates `varyings` (pushes vPosFromLight_i + vDepthMetric_i per light) so
 *  buildVertexOut picks them up.
 */
export function emitPreparedShadow(shadowLights: Parameters<NodeShadowEmitter>[0], startBinding: number, varyings: Varying[], algorithms: PreparedShadowAlgorithms): ShadowEmit {
    const _bindings: ShadowBinding[] = [];
    const wgslDecls: string[] = [];
    const _bglEntries: GPUBindGroupLayoutEntry[] = [];
    const vertLines: string[] = [wgsl`let _shadowWp4 = meshU.world * vec4<f32>(in.position, 1.0);`];
    const dispatchLines: string[] = [wgsl`var _sf = ${SHADOW_FACTORS_ONE};`];
    const projection = shadowProjectionCode();
    let nextBinding = startBinding;
    for (const sl of shadowLights) {
        const suf = `_${sl.lightIndex}`;
        const shadowInfo = `shadowInfo${suf}`;
        appendVarying(varyings, `vPosFromLight${suf}`, "vec4<f32>");
        appendVarying(varyings, `vDepthMetric${suf}`, "f32");
        const _lightIndex = sl.lightIndex;
        const _texBinding = nextBinding++;
        const _sampBinding = nextBinding++;
        const _uboBinding = nextBinding++;
        const _shadowType = sl.shadowType;
        const algorithm = _shadowType === "pcf" ? algorithms.pcf : algorithms.esm;
        if (!algorithm) {
            throw new Error(`${_shadowType.toUpperCase()} shadow receiver was not prepared.`);
        }
        _bindings.push({ _lightIndex, _texBinding, _sampBinding, _uboBinding, _shadowType });
        wgslDecls.push(
            wgsl`struct ${shadowInfo}Uniforms { lightMatrix: mat4x4<f32>, depthValues: vec4<f32>, shadowsInfo: vec4<f32> };`,
            wgsl`@group(1) @binding(${_uboBinding}) var<uniform> ${shadowInfo}: ${shadowInfo}Uniforms;`,
            wgsl`@group(1) @binding(${_texBinding}) var shadowTex${suf}: ${algorithm.shadowTexture._textureType};`,
            wgsl`@group(1) @binding(${_sampBinding}) var ${algorithm.shadowSamplerName}${suf}: ${algorithm.shadowSampler._samplerType};`,
            algorithm.shadowHelper(suf, projection)
        );
        dispatchLines.push(algorithm.shadowFragmentLine(sl.lightIndex, suf, "_sf"));
        _bglEntries.push(
            { binding: _texBinding, visibility: SS.FRAGMENT, texture: { sampleType: algorithm.shadowTexture._sampleType ?? "float", viewDimension: "2d" } },
            { binding: _sampBinding, visibility: SS.FRAGMENT, sampler: { type: algorithm.shadowSampler._samplerType === "sampler_comparison" ? "comparison" : "filtering" } }
        );
        vertLines.push(
            wgsl`out.vPosFromLight${suf} = ${shadowInfo}.lightMatrix * _shadowWp4;`,
            wgsl`out.vDepthMetric${suf} = (out.vPosFromLight${suf}.z + ${shadowInfo}.depthValues.x) / ${shadowInfo}.depthValues.y;`
        );
        _bglEntries.push({
            binding: _uboBinding,
            visibility: SS.VERTEX | SS.FRAGMENT,
            buffer: { type: "uniform", minBindingSize: 96 },
        });
    }
    dispatchLines.push(wgsl`for (var _i = 0u; _i < ${MAX_LIGHTS}u; _i++) { _sf[_i] = mix(1.0, _sf[_i], meshU.receivesShadow.x); }`);
    dispatchLines.push(wgsl`return _sf;`);
    return {
        _bindings,
        _wgslDecls: wgslDecls.join("\n"),
        _fragmentHelper: wgsl`fn nme_computeShadowFactors(input: VertexOut) -> ${SHADOW_FACTORS_TYPE} {\n    ${dispatchLines.join("\n    ")}\n}`,
        _vertexInject: vertLines.join("\n    "),
        _bglEntries,
        _bindingCount: shadowLights.length * 3,
    };
}
