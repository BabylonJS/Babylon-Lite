/** Canonical SceneUniforms — TS counterpart to `shaders/scene-uniforms.wgsl`.
 *
 *  Only the size + the WGSL source are exported. Per-field byte offsets are
 *  hard-coded inline at every write site (see `frame-graph/render-pass-task.ts` and the
 *  light extensions). If the WGSL struct changes, update those offsets. */

import sceneUniformsWgsl from "../../shaders/scene-uniforms.wgsl?raw";
export { SCENE_UBO_BYTES } from "./scene-uniforms-size.js";

/** Canonical WGSL declaration of the SceneUniforms struct + group(0) binding.
 *  Prepend to any standalone shader (skybox, ground, etc.) that samples the
 *  per-pass scene UBO. The composer-driven materials (std + pbr) inject this
 *  same string into their shader templates via the `/*SU* /` slot. */
export const SCENE_UBO_WGSL = sceneUniformsWgsl;
