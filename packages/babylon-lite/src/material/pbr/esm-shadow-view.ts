/** PBR material view helper that writes ESM shadow color. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { PBR_HAS_ALPHA_BLEND, PBR2_ESM_SHADOW_OUTPUT } from "./pbr-flags.js";
import type { PbrMaterialProps } from "./pbr-material.js";

export interface PbrEsmShadowMaterialView extends MaterialView {
    readonly _esmShadowParamsUBO: GPUBuffer;
    readonly _esmShadowDepthCode: string;
}

const PBR_ESM_SHADOW_DEPTH_CODE = `let depthMetricSM = (input.clipPos.z + shadowParams.depthValues.x) / shadowParams.depthValues.y + shadowParams.biasAndScale.x;
let depthSM = clamp(exp(-min(87.0, shadowParams.biasAndScale.z * depthMetricSM)), 0.0, 1.0);
return vec4<f32>(depthSM, 1.0, 1.0, 1.0);`;

export function createPbrEsmShadowMaterialView(source: PbrMaterialProps, shadowParamsUBO: GPUBuffer): PbrEsmShadowMaterialView {
    const features = source._renderFeatures ?? { features: 0, features2: 0 };
    const view = createMaterialView(source, {
        features: features.features & ~PBR_HAS_ALPHA_BLEND,
        features2: (features.features2 ?? 0) | PBR2_ESM_SHADOW_OUTPUT,
    }) as PbrEsmShadowMaterialView;
    Object.defineProperty(view, "_esmShadowParamsUBO", { value: shadowParamsUBO, enumerable: false });
    Object.defineProperty(view, "_esmShadowDepthCode", { value: PBR_ESM_SHADOW_DEPTH_CODE, enumerable: false });
    return view;
}
