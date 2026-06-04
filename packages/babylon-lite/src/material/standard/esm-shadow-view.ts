/** Standard material view helper that writes ESM shadow color. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { ESM_SHADOW_OUTPUT, MATERIAL_ALPHA_BLEND } from "./standard-flags.js";
import type { StandardMaterialProps } from "./standard-material.js";

export interface StandardEsmShadowMaterialView extends MaterialView {
    /** @internal */
    readonly _esmShadowParamsUBO: GPUBuffer;
    /** @internal */
    readonly _esmShadowDepthCode: string;
}

const STANDARD_ESM_SHADOW_DEPTH_CODE = `let depthMetricSM = (input.clipPos.z + shadowParams.depthValues.x) / shadowParams.depthValues.y + shadowParams.biasAndScale.x;
let depthSM = clamp(exp(-min(87.0, shadowParams.biasAndScale.z * depthMetricSM)), 0.0, 1.0);
return vec4<f32>(depthSM, 1.0, 1.0, 1.0);`;

export function createStandardEsmShadowMaterialView(source: StandardMaterialProps, shadowParamsUBO: GPUBuffer): StandardEsmShadowMaterialView {
    const features = source._renderFeatures ?? { features: 0 };
    const view = createMaterialView(source, { features: (features.features & ~MATERIAL_ALPHA_BLEND) | ESM_SHADOW_OUTPUT }) as StandardEsmShadowMaterialView;
    Object.defineProperty(view, "_esmShadowParamsUBO", { value: shadowParamsUBO, enumerable: false });
    Object.defineProperty(view, "_esmShadowDepthCode", { value: STANDARD_ESM_SHADOW_DEPTH_CODE, enumerable: false });
    return view;
}
