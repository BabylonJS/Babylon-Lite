/** Canonical SceneUniforms — TS counterpart to `shaders/scene-uniforms.wgsl`.
 *
 *  Only the size + the WGSL source are exported. Per-field byte offsets are
 *  hard-coded inline at every write site (see `scene/scene-ubo.ts` and the
 *  light extensions). If the WGSL struct changes, update those offsets. */

import sceneUniformsWgsl from "../../shaders/scene-uniforms.wgsl?raw";

/** Total size of SceneUniforms in bytes (must equal the WGSL struct size). */
export const SCENE_UBO_BYTES = 416;

/** Canonical WGSL declaration of the SceneUniforms struct + group(0) binding.
 *  Prepend to any standalone shader (skybox, ground, etc.) that samples the
 *  per-pass scene UBO. The composer-driven materials (std + pbr) inject this
 *  same string into their shader templates via the `/*SU* /` slot. */
export const SCENE_UBO_WGSL = sceneUniformsWgsl;
