/**
 * Opt-in `getFinalWorld(input)` WGSL helper for ShaderMaterial.
 *
 * The helper source and material tracking stay in this module so ShaderMaterial
 * scenes that do not import the enabler keep their existing bundle size.
 */

import type { ShaderMaterial } from "./shader-material.js";
import { wgsl, type WgslSource } from "../../shader/wgsl.js";

function finalWorldWgsl(instanced: boolean): WgslSource {
    return instanced
        ? wgsl`fn getFinalWorld(input: VertexInput) -> mat4x4<f32> {
return shaderSystem.world * mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
}
`
        : wgsl`fn getFinalWorld(input: VertexInput) -> mat4x4<f32> {
return shaderSystem.world;
}
`;
}

/**
 * Add a pipeline-specialized `getFinalWorld(input)` helper to one ShaderMaterial.
 * Call before `registerScene()`. The material must declare the `"world"` system uniform.
 */
export function enableShaderMaterialInstanceWorld(material: ShaderMaterial): void {
    if (!material.uniformDecls.some((uniform) => uniform.name === "world")) {
        throw new Error('enableShaderMaterialInstanceWorld requires the ShaderMaterial to declare the "world" system uniform.');
    }
    material._finalWorldWgsl = finalWorldWgsl;
}
