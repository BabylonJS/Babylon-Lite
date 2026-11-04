import { SS } from "../../engine/gpu-flags.js";
import { ESM_SHADOW_OUTPUT, MATERIAL_ALPHA_BLEND, NO_COLOR_OUTPUT } from "../../material/standard/standard-flags.js";
import type { StdExt } from "../../material/standard/standard-flags.js";
import { wgsl } from "../../shader/wgsl.js";
import { _bindMeshOpacity } from "./mesh-opacity.js";

const STD_MESH_OPACITY_BIT = 1 << 30;

/** @internal Standard's binding and fragment orders agree for this leading id. */
export const meshOpacityStandardExt: StdExt = {
    _id: "0-mesh-opacity",
    _phase: "mesh",
    _feature: STD_MESH_OPACITY_BIT,
    _meshFeatures(meshFeatures, material) {
        return meshFeatures & (1 << 22) && !((material?._renderFeatures?.features ?? 0) & (NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT)) ? STD_MESH_OPACITY_BIT | MATERIAL_ALPHA_BLEND : 0;
    },
    _frag() {
        return {
            _id: "0-mesh-opacity",
            _bindings: [{ _name: "meshOpacity", _type: { _kind: "uniform-buffer" }, _visibility: SS.FRAGMENT }],
            _helperFunctions: wgsl`struct meshOpacityUniforms{value:f32}`,
            _fragmentSlots: { BC: wgsl`alpha = alpha * meshOpacity.value; color = vec4<f32>(color.rgb, color.a * meshOpacity.value);` },
        };
    },
    _bind(_material, entries, binding, mesh, scene, disposers) {
        if (!mesh || !scene) {
            throw new Error("Standard mesh opacity binding requires its mesh and scene.");
        }
        return _bindMeshOpacity(mesh, scene.surface.engine, entries, binding, disposers, "Standard");
    },
};
