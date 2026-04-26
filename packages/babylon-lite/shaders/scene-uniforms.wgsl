// Scene-level uniforms: shared across all draw calls in a frame.
// Bind Group 0 for all pipelines.

struct SceneUniforms {
  viewProj: mat4x4<f32>,          // offset 0   (64 bytes)
  cameraPosition: vec3<f32>,      // offset 64  (12 bytes)
  _pad0: f32,                     // offset 76  (4 bytes) — alignment
  lightDirection: vec3<f32>,      // offset 80  (12 bytes)
  lightIntensity: f32,            // offset 92  (4 bytes)
  lightDiffuseColor: vec3<f32>,   // offset 96  (12 bytes)
  _pad1: f32,                     // offset 108 (4 bytes)
  lightGroundColor: vec3<f32>,    // offset 112 (12 bytes)
  _pad2: f32,                     // offset 124 (4 bytes)
};                                // total: 128 bytes

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
