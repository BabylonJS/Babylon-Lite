import type { PbrExt } from "../pbr-flags.js";
import type { SingleLightShaderSource, MultiLightShaderSource } from "../../../light/lighting-extension.js";
import { areaLightBindings } from "../../../light/area-light-wgsl.js";
import { areaLightEmissionBindings, areaLightEmissionWgsl } from "../../../light/area-light-emission-wgsl.js";
import { bindAreaLightLtc } from "../../../light/area-light-ltc.js";
import { bindAreaLightEmission } from "../../../light/area-light-emission.js";
import { rectAreaPbrExt, rectAreaSingleLightSource, rectAreaMultiLightSource } from "./rect-area-light-fragment.js";
import { _installPbrBindingContext } from "../pbr-pipeline.js";

/** @internal Reserved scene bit, owned by this lazy extension only. */
export const RECT_AREA_PBR_EMISSION = 1 << 8;
const EVALUATION = "evaluateAreaLtc(N,V,input.worldPos,areaEntry,roughness,lightIndex)";

/** @internal Only the lazy feature populates its scene-owned binding context. */
export function installRectAreaEmissionPbr(): void {
    _installPbrBindingContext((context, id, disposers) => {
        context._lightingId = id;
        context._disposers = disposers;
    });
}

/** @internal */
export function rectAreaEmissionSingle(type: string): SingleLightShaderSource | undefined {
    return rectAreaSingleLightSource(type, EVALUATION);
}
/** @internal */
export function rectAreaEmissionMulti(): MultiLightShaderSource {
    return rectAreaMultiLightSource(EVALUATION);
}

/** @internal Textured variants retain the original restriction checks, not broader restrictions. */
export const rectAreaEmissionPbrExt: PbrExt = {
    id: "rect-area-emission",
    phase: "fragment",
    frag(ctx) {
        if (!((ctx._sceneFeatures ?? 0) & RECT_AREA_PBR_EMISSION)) {
            return null;
        }
        const solid = rectAreaPbrExt.frag!({ ...ctx, _sceneFeatures: (ctx._sceneFeatures ?? 0) & ~RECT_AREA_PBR_EMISSION });
        return solid ? { _id: "rect-area-emission", _bindings: [...areaLightBindings(), ...areaLightEmissionBindings()], _helperFunctions: areaLightEmissionWgsl() } : null;
    },
    bind(ctx, entries, binding) {
        binding = bindAreaLightLtc(ctx._engine, entries, binding);
        return bindAreaLightEmission(ctx._lightingId, ctx._engine._device, entries, binding, ctx._disposers);
    },
};
