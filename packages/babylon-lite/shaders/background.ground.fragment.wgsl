// Background Ground Fragment Shader
// Matches BJS shd_16: DIFFUSE, OPACITYFRESNEL, PREMULTIPLYALPHA (no REFLECTION)
// Verified via Spector.GPU capture of BJS scene 1

struct MeshUniforms {
  world: mat4x4<f32>,
  primaryColor: vec3<f32>,
  alpha: f32,
  backgroundCenter: vec3<f32>,
  _pad: f32,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

@group(1) @binding(1) var groundTexture: texture_2d<f32>;
@group(1) @binding(2) var groundSampler: sampler;

struct FragmentInput {
  @location(0) vPositionW: vec3<f32>,
  @location(1) vNormalW: vec3<f32>,
  @location(2) vUV: vec2<f32>,
};

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
  let normalW = normalize(input.vNormalW);

  // Sample diffuse texture (BJS backgroundGround.png: white RGB, radial alpha gradient)
  let diffuseMap = textureSample(groundTexture, groundSampler, input.vUV);

  // BJS: reflectionColor = vec4(1) (no REFLECTION define)
  let diffuseColor = diffuseMap.rgb;
  let colorBase = max(diffuseColor, vec3<f32>(0.0));
  let mainColor = mesh.primaryColor;
  let finalColor = colorBase * mainColor;

  // Alpha starts from material alpha, multiplied by texture alpha
  var finalAlpha = mesh.alpha * diffuseMap.a;

  // OPACITYFRESNEL — BJS shd_16 lines 367-370
  let viewAngleToFloor = dot(normalW, normalize(scene.vEyePosition.xyz - mesh.backgroundCenter));
  const startAngle: f32 = 0.1;
  let fadeFactor = clamp(viewAngleToFloor / startAngle, 0.0, 1.0);
  finalAlpha *= fadeFactor * fadeFactor;

  // Image processing (preserves alpha)
  var color = vec4<f32>(finalColor, finalAlpha);
  if (scene.vImageInfos.w >= 0.0) {
    color = applyImageProcessing(color);
  }

  // PREMULTIPLYALPHA — BJS shd_16 line 373
  color = vec4<f32>(color.rgb * color.a, color.a);

  // Dithering
  color = vec4<f32>(color.rgb + vec3<f32>(dither(input.vPositionW.xy, 0.5)), color.a);
  color = max(color, vec4<f32>(0.0));

  return color;
}
