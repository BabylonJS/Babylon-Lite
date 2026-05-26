/** NodeMaterial view helper that writes ESM shadow color. */

import { createMaterialView } from "../material-view.js";
import type { MaterialView } from "../material.js";
import { NODE_ESM_SHADOW_OUTPUT } from "./node-flags.js";
import type { NodeMaterial } from "./node-material.js";

export interface NodeEsmShadowMaterialView extends MaterialView {
    readonly _esmShadowParamsUBO: GPUBuffer;
    readonly _esmShadowDepthCode: string;
}

const NODE_ESM_SHADOW_DEPTH_CODE = `let depthMetricSM = (in.position.z + nmeShadowParams.depthValues.x) / nmeShadowParams.depthValues.y + nmeShadowParams.biasAndScale.x;
let depthSM = clamp(exp(-min(87.0, nmeShadowParams.biasAndScale.z * depthMetricSM)), 0.0, 1.0);
return vec4<f32>(depthSM, 1.0, 1.0, 1.0);`;

export function createNodeEsmShadowMaterialView(source: NodeMaterial, shadowParamsUBO: GPUBuffer): NodeEsmShadowMaterialView {
    const features = source._renderFeatures ?? { features: 0 };
    const view = createMaterialView(source, { features: features.features | NODE_ESM_SHADOW_OUTPUT }) as NodeEsmShadowMaterialView;
    Object.defineProperty(view, "_esmShadowParamsUBO", { value: shadowParamsUBO, enumerable: false });
    Object.defineProperty(view, "_esmShadowDepthCode", { value: NODE_ESM_SHADOW_DEPTH_CODE, enumerable: false });
    return view;
}
