// Faithful DOOM sky (F_SKY1) backdrop. DOOM leaves sky ceilings and sky-bordering
// walls ungeometried; the engine clear color would otherwise show through as HOM.
//
// We render a camera-centered sphere whose fragments are forced to the reversed-Z
// far plane (clip z = 0). With the default `greater-equal` depth test and no depth
// writes, the sky passes only where the depth buffer is still cleared (0) — i.e.
// exactly the empty/hole pixels — so it fills behind all geometry order-independently.
//
// The sky tiles horizontally with view angle (DOOM repeats SKY1 four times around
// 360°) and is sampled full-bright (colormap row 0), ignoring sector light and
// distance diminishing — matching the original infinite sky.

import { createMeshFromData, createShaderMaterial, createSphereData, setShaderTexture, type EngineContext, type Mesh, type Texture2D } from "babylon-lite";

const SKY_REPEATS = 4.0;

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) dir: vec3<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let clip = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  // Force the reversed-Z far plane (cleared depth = 0) so the sky sits behind everything.
  out.position = vec4<f32>(clip.xy, 0.0, clip.w);
  // Mesh is only translated to the camera, so local position is the view direction.
  out.dir = input.position;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) dir: vec3<f32>,
};
const PI: f32 = 3.14159265;
const HALF_PI: f32 = 1.57079633;
const SKY_REPEATS: f32 = ${SKY_REPEATS.toFixed(1)};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let dir = normalize(input.dir);
  let u = atan2(dir.z, dir.x) / (2.0 * PI) * SKY_REPEATS;
  // Texture bottom (mountains) sits at the horizon; top of texture is the zenith.
  let v = 1.0 - asin(clamp(dir.y, 0.0, 1.0)) / HALF_PI;
  let src = textureSample(srcTex, srcTexSampler, vec2<f32>(u, v));
  let idx = floor(src.r * 255.0 + 0.5);
  // Row 0 of the colormap LUT is full-bright; sky ignores light diminishing.
  let lut = textureSample(colormapTex, colormapTexSampler, vec2<f32>((idx + 0.5) / 256.0, 0.5 / 34.0));
  return vec4<f32>(lut.rgb, 1.0);
}`;

/** Builds a camera-centered sky dome. Caller must call `recenter` each frame before render. */
export function createSky(engine: EngineContext, skyTex: Texture2D, colormapTex: Texture2D): Mesh {
    const data = createSphereData({ segments: 16, diameter: 2000 });
    const mesh = createMeshFromData(engine, "doom_sky", data.positions, data.normals, data.indices, data.uvs);
    const mat = createShaderMaterial({
        name: "doomSky",
        vertexSource,
        fragmentSource,
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
        samplers: ["srcTex", "colormapTex"],
        backFaceCulling: false,
        depthWrite: false,
    });
    setShaderTexture(mat, "srcTex", skyTex);
    setShaderTexture(mat, "colormapTex", colormapTex);
    mesh.material = mat;
    mesh.renderOrder = -1000;
    return mesh;
}
