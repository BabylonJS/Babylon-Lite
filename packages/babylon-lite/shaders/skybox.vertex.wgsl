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
  // Yaw the sampling direction by the scene's environment rotation, matching what the PBR IBL
  // does to its reflection/normal vectors — so turning the environment turns the visible sky
  // and the lighting together instead of sliding them out of register.
  let c = cos(scene.envRotationY);
  let s = sin(scene.envRotationY);
  output.positionUVW = vec3<f32>(position.x * c + position.z * s, position.y, -position.x * s + position.z * c);
  // Infinite distance: strip translation (w=0), center at camera.
  // Matches BJS skybox.infiniteDistance = true.
  let worldPos = (mesh.world * vec4<f32>(position, 0.0)).xyz + scene.vEyePosition.xyz;
  output.positionW = worldPos;
  output.clipPos = scene.viewProjection * vec4<f32>(worldPos, 1.0);
  return output;
}
