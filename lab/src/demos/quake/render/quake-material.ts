// Quake world material: diffuse texture (decoded MIPTEX → sRGB) modulated by a
// grayscale lightmap sampled from the atlas via the second UV set. An overbright
// factor approximates GLQuake's lightmap doubling. Back-face culling is disabled
// so the BSP winding (flipped by the Quake→engine axis swap) renders either way.

import { createShaderMaterial, setShaderTexture, type ShaderMaterial, type Texture2D } from "babylon-lite";

const OVERBRIGHT = 2.5;
// A small ambient floor keeps pitch-black corners (e.g. the cramped start nook)
// faintly visible so the player can navigate; mild gamma lifts mid-tones. Both
// are negligible where the lightmap is already bright, so the atmosphere holds.
const AMBIENT = 0.12;
const GAMMA = 1.25;

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) uv2: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
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
const AMBIENT: f32 = ${AMBIENT.toFixed(2)};
const INV_GAMMA: f32 = ${(1 / GAMMA).toFixed(4)};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let diffuse = textureSample(diffuseTex, diffuseTexSampler, input.uv);
  if (diffuse.a < 0.5) { discard; }
  let light = textureSample(lightTex, lightTexSampler, input.uv2).r;
  let lit = clamp(diffuse.rgb * (light * OVERBRIGHT + AMBIENT), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(pow(lit, vec3<f32>(INV_GAMMA)), 1.0);
}`;

export function createQuakeMaterial(name: string, diffuseTex: Texture2D, lightTex: Texture2D): ShaderMaterial {
    const mat = createShaderMaterial({
        name,
        vertexSource,
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
