// PCF Shadow Depth Vertex Shader — renders shadow casters from light's perspective
// Writes only to depth buffer (no color output needed).

struct MeshUniforms {
  world: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

@vertex
fn main(
  @location(0) position: vec3<f32>,
) -> @builtin(position) vec4<f32> {
  let worldPos = mesh.world * vec4<f32>(position, 1.0);
  var clipPos = scene.viewProjection * worldPos;
  clipPos.z = clipPos.z + scene.pcfBias.x * clipPos.w;
  return clipPos;
}
