/**
 * Babylon.js `MaterialHelper` free functions from `@babylonjs/core`'s
 * `materialHelper.functions`. These are thin capability adapters — they read the
 * compat engine's reported {@link WebGPUEngine.getCaps | caps} and return a number;
 * no rendering or material behaviour lives here.
 */

import type { Scene } from "../scene/scene.js";

// The vertex stage always binds Scene, Mesh, Material and LeftOver uniform buffers in
// addition to the per-light ones. This is the exact BJS reservation used to work out
// how many lights still fit within the device's per-stage uniform-buffer limit.
const NON_LIGHT_VERTEX_UNIFORM_BUFFER_COUNT = 4;

/**
 * Babylon.js `GetSupportedSimultaneousLights(scene, maxSimultaneousLights)`.
 *
 * Returns the number of simultaneous lights the engine can actually render, which
 * may be lower than the requested maximum. Engines that declare one uniform buffer
 * per light in the vertex shader (WebGPU) are bounded by
 * `maxUniformBuffersPerShaderStage`; past that limit every pipeline creation is
 * rejected by the validator and nothing renders. Engines that do not report the
 * limit leave the requested count untouched.
 */
export function GetSupportedSimultaneousLights(scene: Scene, maxSimultaneousLights: number): number {
    const maxUniformBuffersPerShaderStage = scene.getEngine().getCaps().maxUniformBuffersPerShaderStage as number | undefined;

    // Engines that do not report the limit do not enforce it: leave the count untouched.
    // Tested against null rather than for truthiness so a limit of 0 still clamps.
    if (maxUniformBuffersPerShaderStage == null) {
        return maxSimultaneousLights;
    }

    // Each light claims one more uniform buffer on top of the reserved non-light ones.
    // Clamp to whatever budget is left, which may be zero: past the limit every pipeline
    // creation is rejected by the validator, so a material that renders unlit is strictly
    // better than one that returns a light count the device cannot honour. Real WebGPU
    // devices guarantee at least 12 buffers per stage, so this floor only bites the
    // pathological low-cap case the null path below cannot reach.
    const supported = Math.max(maxUniformBuffersPerShaderStage - NON_LIGHT_VERTEX_UNIFORM_BUFFER_COUNT, 0);

    return Math.min(maxSimultaneousLights, supported);
}
