import { SS } from "../../engine/gpu-flags.js";
import { PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT, PBR_HAS_ALPHA_BLEND } from "../../material/pbr/pbr-flags.js";
import type { PbrExt } from "../../material/pbr/pbr-flags.js";
import { PBR2_HAS_SHADOW_ONLY } from "../../material/pbr/fragments/shadow-only-fragment.js";
import { wgsl } from "../../shader/wgsl.js";
import { _bindMeshOpacity } from "./mesh-opacity.js";

const MESH_OPACITY_MESH_BIT = 1 << 22;

/** @internal The trailing id keeps BC after refraction's closing brace and alpha after shadow-only. */
export const meshOpacityPbrExt: PbrExt = {
    id: "z-mesh-opacity",
    phase: "fragment",
    frag(ctx) {
        if (!(ctx._meshFeatures & MESH_OPACITY_MESH_BIT) || ctx._features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) {
            return null;
        }
        return {
            _id: "z-mesh-opacity",
            _dependencies: ctx._features2 & PBR2_HAS_SHADOW_ONLY ? ["shadow-only"] : undefined,
            _bindings: [{ _name: "meshOpacity", _type: { _kind: "uniform-buffer" }, _visibility: SS.FRAGMENT }],
            _helperFunctions: wgsl`struct meshOpacityUniforms{value:f32}`,
            _fragmentSlots: ctx._features & PBR_HAS_ALPHA_BLEND ? { FA: wgsl`finalAlpha = finalAlpha * meshOpacity.value;` } : { BC: wgsl`alpha = alpha * meshOpacity.value;` },
        };
    },
    bind(ctx, entries, binding) {
        if (!ctx._mesh) {
            throw new Error("PBR mesh opacity binding requires its mesh.");
        }
        return _bindMeshOpacity(ctx._mesh, ctx._engine, entries, binding, ctx._disposers, "PBR");
    },
};
