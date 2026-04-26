// Skybox Vertex Shader — matches Babylon BackgroundMaterial (REFLECTIONMAP_SKYBOX)
// Outputs local position as cubemap direction (vPositionUVW) + world position for dithering

struct MeshUniforms {
  world: mat4x4<f32>,
};

@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) positionUVW: vec3<f32>,
  @location(1) positionW: vec3<f32>,
};

@vertex
fn main(@location(0) position: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.positionUVW = position;
  // Infinite distance: strip translation (w=0), center at camera.
  // Matches BJS skybox.infiniteDistance = true.
  let worldPos = (mesh.world * vec4<f32>(position, 0.0)).xyz + scene.vEyePosition.xyz;
  output.positionW = worldPos;
  output.clipPos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
  return output;
}
