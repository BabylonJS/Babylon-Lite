import { SS } from "../engine/gpu-flags.js";
import type { PbrExt } from "../material/pbr/pbr-flags.js";
import { _registerPbrExt } from "../material/pbr/pbr-flags.js";
import { CLUSTERED_LIGHT_STRUCTS, _clusteredPointLightBlock } from "../material/pbr/fragments/clustered-light-wgsl.js";
import type { ClusteredLightGpuState } from "./clustered.js";

const PBR2_HAS_CLUSTERED_LIGHTS = 1 << 17;

const clusteredPointPbrExt: PbrExt = {
    id: "clustered-lights",
    phase: "fragment",
    detect(mat: unknown) {
        const state = (mat as { _clusteredLightState?: ClusteredLightGpuState })._clusteredLightState;
        return state && !state._hasSpots ? { f: 0, f2: PBR2_HAS_CLUSTERED_LIGHTS } : { f: 0, f2: 0 };
    },
    frag(ctx) {
        if ((ctx._features2 & PBR2_HAS_CLUSTERED_LIGHTS) === 0) {
            return null;
        }
        const block = _clusteredPointLightBlock();
        return {
            _id: "clustered-lights",
            _bindings: [
                { _name: "clusteredLightParams", _type: { _kind: "uniform-buffer" }, _visibility: SS.FRAGMENT },
                { _name: "clusteredLights", _type: { _kind: "texture", _textureType: "texture_2d<f32>", _sampleType: "unfilterable-float" }, _visibility: SS.FRAGMENT },
                { _name: "clusteredCells", _type: { _kind: "texture", _textureType: "texture_2d<u32>" }, _visibility: SS.FRAGMENT },
                { _name: "clusteredIndices", _type: { _kind: "texture", _textureType: "texture_2d<u32>" }, _visibility: SS.FRAGMENT },
            ],
            _helperFunctions: CLUSTERED_LIGHT_STRUCTS,
            _fragmentSlots: { AD: block, BL: block },
        };
    },
    bind(ctx, entries, b) {
        const state = (ctx._material as { _clusteredLightState?: ClusteredLightGpuState })._clusteredLightState;
        if (!state) {
            return b;
        }
        entries.push({ binding: b++, resource: { buffer: state.paramsBuffer } });
        entries.push({ binding: b++, resource: state.lightsView });
        entries.push({ binding: b++, resource: state.cellsView });
        entries.push({ binding: b++, resource: state.indicesView });
        return b;
    },
};

/** @internal Register the point-only clustered PBR extension. */
export function _enableClusteredPointSupport(): void {
    _registerPbrExt(clusteredPointPbrExt);
}
