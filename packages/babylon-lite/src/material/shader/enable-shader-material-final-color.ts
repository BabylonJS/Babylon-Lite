/**
 * Opt-in `getFinalColor(input)` WGSL helper for ShaderMaterial.
 *
 * The helper source and material tracking stay in this module so ShaderMaterial
 * scenes that do not import the enabler keep their existing bundle size.
 */

import type { ShaderMaterial } from "./shader-material.js";
import { _installShaderFinalColorResolver } from "./shader-pipeline.js";
import { wgsl, type WgslSource } from "../../shader/wgsl.js";
import { getMaterialSource } from "../material-view.js";

let enabledMaterials: WeakSet<ShaderMaterial> | null = null;

function finalColorWgsl(material: ShaderMaterial, hasInstanceColor: boolean): WgslSource | undefined {
    if (!enabledMaterials?.has(getMaterialSource(material) as ShaderMaterial)) {
        return undefined;
    }
    const hasVertexColor = material.attributes.includes("color");
    if (hasVertexColor && hasInstanceColor) {
        return wgsl`fn getFinalColor(input: VertexInput) -> vec4<f32> {
return input.color * input.instanceColor;
}
`;
    }
    if (hasVertexColor) {
        return wgsl`fn getFinalColor(input: VertexInput) -> vec4<f32> {
return input.color;
}
`;
    }
    if (hasInstanceColor) {
        return wgsl`fn getFinalColor(input: VertexInput) -> vec4<f32> {
return input.instanceColor;
}
`;
    }
    return wgsl`fn getFinalColor(input: VertexInput) -> vec4<f32> {
return vec4<f32>(1.0);
}
`;
}

/**
 * Add a pipeline-specialized `getFinalColor(input)` helper to one ShaderMaterial.
 * Call before `registerScene()`.
 */
export function enableShaderMaterialFinalColor(material: ShaderMaterial): void {
    (enabledMaterials ??= new WeakSet()).add(material);
    _installShaderFinalColorResolver(finalColorWgsl);
}
