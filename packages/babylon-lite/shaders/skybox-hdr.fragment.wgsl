// HDR Skybox Fragment Shader — samples HDR environment cubemap with image processing.
// Used when scene has an HDR environment rendered as the background.
// Matches BJS BackgroundMaterial: cubemap at LOD 0 + exposure + gamma + contrast.

struct MeshUniforms {
  world: mat4x4<f32>,
  primaryColor: vec3<f32>,
  _pad: f32,
  skyOutputColor: vec3<f32>,
  _pad2: f32,
  exposureLinear: f32,
  contrast: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
@group(1) @binding(1) var envCubemap: texture_cube<f32>;
@group(1) @binding(2) var envSampler: sampler;

struct FragmentInput {
  @location(0) positionUVW: vec3<f32>,
  @location(1) positionW: vec3<f32>,
};

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
  var dir = normalize(input.positionUVW);
  /*ENV_DIRECTION*/
  var color = textureSampleLevel(envCubemap, envSampler, dir, 0.0/*ENV_LOD*/).rgb;

  // Image processing: exposure → gamma → contrast (matches BJS applyImageProcessing)
  color *= mesh.exposureLinear;
  color = pow(color, vec3<f32>(1.0 / 2.2));
  color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));

  let highContrast = color * color * (3.0 - 2.0 * color);
  if (mesh.contrast < 1.0) { color = mix(vec3<f32>(0.5), color, mesh.contrast); }
  else { color = mix(color, highContrast, mesh.contrast - 1.0); }
  color = max(color, vec3<f32>(0.0));

  return vec4<f32>(color, 1.0);
}
