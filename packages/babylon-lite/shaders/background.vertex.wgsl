// Background Ground Vertex Shader
// Matches BJS shd_15: DIFFUSE, OPACITYFRESNEL, PREMULTIPLYALPHA (no REFLECTION)

struct MeshUniforms {
  world: mat4x4<f32>,
};

@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) vPositionW: vec3<f32>,
  @location(1) vNormalW: vec3<f32>,
  @location(2) vUV: vec2<f32>,
};

@vertex
fn main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let finalWorld = mesh.world;
  let worldPos4 = finalWorld * vec4<f32>(input.position, 1.0);
  output.vPositionW = worldPos4.xyz;
  output.clipPos = scene.viewProjection * worldPos4;
  let normalWorld = mat3x3<f32>(finalWorld[0].xyz, finalWorld[1].xyz, finalWorld[2].xyz);
  output.vNormalW = normalize(normalWorld * input.normal);
  output.vUV = input.uv;
  return output;
}
