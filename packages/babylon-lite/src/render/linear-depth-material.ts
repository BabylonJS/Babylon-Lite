/** Linear-depth ShaderMaterial — outputs `vec4(linearDepth)` for every fragment.
 *
 *  Lite equivalent of BJS `DepthRenderer` (linear-mode) + `customDepthPixelShader`
 *  post-process collapsed into a single direct-to-swapchain material.  The fragment
 *  writes the grayscale depth visualization directly, so scenes don't need an
 *  offscreen render target + post-process pass.
 *
 *  `linearDepth = (viewZ - near) / (far - near)`, matching BJS's
 *  `DepthRenderer.useOnlyInActiveCamera = true; isPacked = false` path. */

import type { ShaderMaterial } from "../material/shader/shader-material.js";
import { createShaderMaterial } from "../material/shader/shader-material.js";

const VERTEX = /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) viewZ: f32,
};
@vertex
fn mainVertex(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let worldPos = shaderSystem.world * vec4<f32>(input.position, 1.0);
    let viewPos  = shaderSystem.view * worldPos;
    out.position = shaderSystem.projection * viewPos;
    // LH view space: positive z is in front of the camera.
    out.viewZ = viewPos.z;
    return out;
}
`;

const FRAGMENT = /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) viewZ: f32,
};
@fragment
fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
    let near = shaderUniforms.nearFar.x;
    let far  = shaderUniforms.nearFar.y;
    let d = clamp((input.viewZ - near) / (far - near), 0.0, 1.0);
    return vec4<f32>(d, d, d, 1.0);
}
`;

/** Options for `createLinearDepthMaterial()`. */
export interface LinearDepthMaterialOptions {
    /** Camera near plane (defaults to 0.03 to match the source playground). */
    near?: number;
    /** Camera far plane (defaults to 15 to match the source playground). */
    far?: number;
    /** Optional material name. */
    name?: string;
}

/** Create a linear-depth ShaderMaterial that writes `(d, d, d, 1)` per fragment.
 *  The depth is computed from the view-space z, normalized by the supplied
 *  near/far range (or 0.03/15 by default).  Override per material via the
 *  `nearFar` custom uniform. */
export function createLinearDepthMaterial(options: LinearDepthMaterialOptions = {}): ShaderMaterial {
    const near = options.near ?? 0.03;
    const far = options.far ?? 15.0;
    return createShaderMaterial({
        name: options.name ?? "linearDepth",
        vertexSource: VERTEX,
        fragmentSource: FRAGMENT,
        attributes: ["position"],
        uniforms: ["world", "view", "projection", { name: "nearFar", type: "vec2<f32>", defaultValue: [near, far] }],
        backFaceCulling: true,
        depthWrite: true,
        depthCompare: "greater-equal",
    });
}
