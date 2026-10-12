import type { BindingDecl, ShaderFragment, Varying } from "../fragment-types.js";
import { wgsl, type WgslSource } from "../wgsl.js";
import { loadShadowAlgorithms, shadowProjectionCode, type ShadowAlgorithm, type ShadowLightSlot } from "./shadow-algorithms.js";

export type { ShadowAlgorithm, ShadowLightSlot } from "./shadow-algorithms.js";

const STAGE_FRAGMENT = 0x2;
const STAGE_VERTEX = 0x1;

/** @internal Synchronous fragment factory returned after async algorithm preparation. */
export type PreparedShadowFragmentFactory = (id: string, slots: ShadowLightSlot[]) => ShaderFragment;

/** @internal Load only the fallback algorithms present in one scene's immutable shadow slots. */
export async function loadShadowFragmentFactory(shadowLights: readonly ShadowLightSlot[]): Promise<PreparedShadowFragmentFactory> {
    const { esm, pcf } = await loadShadowAlgorithms(shadowLights);
    return (id, slots) => createPreparedShadowFragment(id, slots, esm, pcf);
}

/** @internal Assemble a shadow fragment from already-prepared algorithm modules. */
export function createPreparedShadowFragment(id: string, shadowLights: ShadowLightSlot[], esm: ShadowAlgorithm | undefined, pcf: ShadowAlgorithm | undefined): ShaderFragment {
    const varyings: Varying[] = [];
    const bindings: BindingDecl[] = [];
    const vertexLines: WgslSource[] = [];
    const fragmentLines: WgslSource[] = [];
    const helperParts: WgslSource[] = [];
    const vertexHelperParts: WgslSource[] = [];
    const projection = shadowProjectionCode();

    for (const slot of shadowLights) {
        const lightIndex = slot.lightIndex;
        const suffix = `_${lightIndex}`;
        const shadowInfoDeclaration = wgsl`struct shadowInfo${suffix}Uniforms { lightMatrix: mat4x4<f32>, depthValues: vec4<f32>, shadowsInfo: vec4<f32> };`;
        const algorithm = slot.shadowType === "pcf" ? pcf : esm;
        if (!algorithm) {
            throw new Error(`${slot.shadowType.toUpperCase()} shadow receiver was not prepared.`);
        }

        varyings.push({ _name: `vPosFromLight${suffix}`, _type: "vec4<f32>" }, { _name: `vDepthMetric${suffix}`, _type: "f32" });
        bindings.push(
            { _name: `shadowTex${suffix}`, _type: algorithm.shadowTexture, _group: "shadow", _visibility: STAGE_FRAGMENT },
            {
                _name: `${algorithm.shadowSamplerName}${suffix}`,
                _type: algorithm.shadowSampler,
                _group: "shadow",
                _visibility: STAGE_FRAGMENT,
            },
            { _name: `shadowInfo${suffix}`, _type: { _kind: "uniform-buffer" }, _group: "shadow", _visibility: STAGE_FRAGMENT | STAGE_VERTEX }
        );
        helperParts.push(shadowInfoDeclaration, algorithm.shadowHelper(suffix, projection));
        vertexHelperParts.push(shadowInfoDeclaration);
        vertexLines.push(
            wgsl`out.vPosFromLight${suffix} = shadowInfo${suffix}.lightMatrix * worldPos4;`,
            wgsl`out.vDepthMetric${suffix} = (out.vPosFromLight${suffix}.z + shadowInfo${suffix}.depthValues.x) / shadowInfo${suffix}.depthValues.y;`
        );
        fragmentLines.push(algorithm.shadowFragmentLine(lightIndex, suffix));
    }

    return {
        _id: id,
        _varyings: varyings,
        _bindings: bindings,
        _helperFunctions: wgsl`${helperParts.join("\n")}`,
        _vertexHelperFunctions: wgsl`${vertexHelperParts.join("\n")}`,
        _vertexSlots: {
            VB: wgsl`${vertexLines.join("\n")}`,
        },
        _fragmentSlots: {
            AD: wgsl`${fragmentLines.join("\n")}`,
        },
    };
}
