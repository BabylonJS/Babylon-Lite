// Quake world material: diffuse texture (decoded MIPTEX → sRGB) modulated by a
// grayscale lightmap sampled from the atlas via the second UV set. An overbright
// factor approximates GLQuake's lightmap doubling. Back-face culling is disabled
// so the BSP winding (flipped by the Quake→engine axis swap) renders either way.

import { createShaderMaterial, setShaderTexture, type ShaderMaterial, type Texture2D } from "babylon-lite";

const OVERBRIGHT = 2.5;

// Movers (doors/buttons/lifts) sit coplanar with the static world and with each
// other, so they z-fight. Rather than physically expanding the brush (which tears
// small cuboids like buttons apart), we pull their depth a fixed amount toward the
// camera. The engine uses reverse-Z (depthCompare "greater-equal"), so a larger
// NDC z is nearer — we ADD to clip-space z.
//
// Crucially the term is `DEPTH_BIAS / w`, NOT `DEPTH_BIAS * w`. With reverse-Z the
// NDC shift is `(DEPTH_BIAS / w) / w = DEPTH_BIAS / w²`, and since `w == z_view` this
// translates to a CONSTANT view-space pull of `DEPTH_BIAS / near` world units at all
// distances. A constant *NDC* bias (`* w`) instead pulls by `bias·z²/near`, which
// explodes with distance (≈0.5u at z=20 but ≈190u at z=500) and yanks recessed
// buttons/torches clean through the wall in front of them — the depth bug this fixes.
// `DEPTH_BIAS` is therefore expressed as `pull · near` (world units × near plane).
const vertexSource = (depthBias: number) => `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) uv2: vec2<f32>,
};
const DEPTH_BIAS: f32 = ${depthBias.toExponential(6)};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.position.z = out.position.z + DEPTH_BIAS / out.position.w;
  out.uv = input.uv;
  out.uv2 = input.uv2;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) uv2: vec2<f32>,
};
const OVERBRIGHT: f32 = ${OVERBRIGHT.toFixed(1)};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let diffuse = textureSample(diffuseTex, diffuseTexSampler, input.uv);
  if (diffuse.a < 0.5) { discard; }
  let light = textureSample(lightTex, lightTexSampler, input.uv2).r;
  let lit = clamp(diffuse.rgb * light * OVERBRIGHT, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(lit, 1.0);
}`;

export function createQuakeMaterial(name: string, diffuseTex: Texture2D, lightTex: Texture2D, depthBias = 0): ShaderMaterial {
    const mat = createShaderMaterial({
        name,
        vertexSource: vertexSource(depthBias),
        fragmentSource,
        attributes: ["position", "uv", "uv2"],
        uniforms: ["worldViewProjection"],
        samplers: ["diffuseTex", "lightTex"],
        backFaceCulling: false,
    });
    setShaderTexture(mat, "diffuseTex", diffuseTex);
    setShaderTexture(mat, "lightTex", lightTex);
    return mat;
}
