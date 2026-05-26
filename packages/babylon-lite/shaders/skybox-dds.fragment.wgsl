// DDS Cube Skybox Fragment Shader — samples DDS cube texture with BJS image processing.
// Used by scenes that load backgroundSkybox.dds (createDefaultEnvironment).
// Pipeline: exposure → Reinhard tonemap → gamma → contrast → dither.

struct MeshUniforms {
  world: mat4x4<f32>,
  primaryColor: vec3<f32>,
  exposureLinear: f32,
  contrast: f32,
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
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
  let dir = normalize(input.positionUVW);
  var color = textureSampleLevel(envCubemap, envSampler, dir, 0.0).rgb;

  // BJS BackgroundMaterial: colorBase = reflectionColor.rgb * primaryColor.rgb
  color *= mesh.primaryColor;

  if (scene.vImageInfos.w >= 0.0) {
    // Exposure
    color *= mesh.exposureLinear;
    // Reinhard tonemap (matches BJS toneMappingType 0)
    color = 1.0 - exp2(-1.590579 * color);
    // Gamma
    color = pow(color, vec3<f32>(1.0 / 2.2));
    color = saturate(color);

    // Contrast
    let highContrast = color * color * (3.0 - 2.0 * color);
    color = mix(color, highContrast, mesh.contrast - 1.0);

    // Dithering (enableNoise=true, variance=0.5)
    color = color + vec3<f32>(dither(input.positionW.xy, 0.5));
    color = max(color, vec3<f32>(0.0));
  }

  return vec4<f32>(color, 1.0);
}
