/** Unified SceneUniforms — JS-side mirror of `shaders/scene-uniforms.wgsl`.
 *
 *  Hard-coded byte offsets are inlined at every consumer site (scene/scene-ubo.ts
 *  and the per-light PBR extensions) to keep the bundle small. Keep the WGSL
 *  struct in sync with those offsets — see `tests/unit/shader-integration.test.ts`. */

import sceneUniformsWgsl from "../../shaders/scene-uniforms.wgsl?raw";

/** Total byte size of the SceneUniforms struct (104 floats = 416 bytes). */
export const SCENE_UBO_BYTES = 416;

/** Full WGSL text — `struct SceneUniforms { ... };` plus the
 *  `@group(0) @binding(0) var<uniform> scene: SceneUniforms;` binding. */
export const SCENE_UBO_WGSL: string = sceneUniformsWgsl;
