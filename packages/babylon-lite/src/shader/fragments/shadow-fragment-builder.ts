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

/**
 * @internal Compose a cascaded (CSM) receiver with the prepared ESM/PCF receiver for a scene that mixes both.
 *
 * Both receivers write `shadowFactors[lightIndex]` and suffix every name with `_<lightIndex>`, so their code
 * composes as is. Bindings are put back in light-slot order, the order `createMaterialShadowBindings` binds
 * the shadow generators in.
 */
export function mergeShadowFragments(id: string, shadowLights: readonly ShadowLightSlot[], csm: ShaderFragment, fallback: ShaderFragment): ShaderFragment {
    const bindings: BindingDecl[] = [];
    for (const slot of shadowLights) {
        const source = slot.shadowType === "csm" ? csm : fallback;
        const suffix = `_${slot.lightIndex}`;
        for (const binding of source._bindings ?? []) {
            if (binding._name.endsWith(suffix)) {
                bindings.push(binding);
            }
        }
    }

    return {
        _id: id,
        _varyings: [...(csm._varyings ?? []), ...(fallback._varyings ?? [])],
        _bindings: bindings,
        _helperFunctions: joinWgsl(csm._helperFunctions, fallback._helperFunctions),
        _vertexHelperFunctions: joinWgsl(csm._vertexHelperFunctions, fallback._vertexHelperFunctions),
        _vertexSlots: mergeSlots(csm._vertexSlots, fallback._vertexSlots),
        _fragmentSlots: mergeSlots(csm._fragmentSlots, fallback._fragmentSlots),
    };
}

function joinWgsl(a: WgslSource | undefined, b: WgslSource | undefined): WgslSource | undefined {
    return a && b ? wgsl`${a}\n${b}` : (a ?? b);
}

function mergeSlots<K extends string>(a: Partial<Record<K, WgslSource>> | undefined, b: Partial<Record<K, WgslSource>> | undefined): Partial<Record<K, WgslSource>> {
    const merged: Partial<Record<K, WgslSource>> = { ...a };
    for (const [slot, code] of Object.entries(b ?? {}) as [K, WgslSource | undefined][]) {
        merged[slot] = joinWgsl(merged[slot], code);
    }
    return merged;
}
