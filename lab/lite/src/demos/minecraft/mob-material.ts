// Mob surface material: solid per-vertex RGB albedo (no texture atlas) lit by the
// same dynamic day-night sun + ambient sky model as the voxel terrain, so blocky
// animals sit naturally in the world. Unlike the voxel material (which always
// samples the block atlas) this one takes its base colour straight from the vertex
// `color`, which is how we paint cows/pigs/sheep/chickens from a handful of solid
// hues without needing any animal textures.
//
// Normals are transformed by the world matrix (`shaderSystem.world`) so a mob that
// is yaw-rotated to face its heading is still lit correctly from the world sun —
// the terrain shader skips this because its chunk meshes never rotate.

import { createShaderMaterial, setShaderVector3, type ShaderMaterial } from "babylon-lite";

const FACE_SHADE_FN = `fn mobFaceShade(n: vec3<f32>) -> f32 {
  if (n.y > 0.5) { return 1.0; }
  if (n.y < -0.5) { return 0.5; }
  if (abs(n.x) > 0.5) { return 0.82; }
  return 0.72;
}`;

const VERTEX_SRC = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) albedo: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) viewDepth: f32,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  let p = input.position;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(p, 1.0);
  out.viewDepth = (shaderSystem.worldView * vec4<f32>(p, 1.0)).z;
  // Rotate the normal into world space (mobs only ever rotate + uniformly scale,
  // so the upper 3x3 needs no inverse-transpose correction).
  let wn = shaderSystem.world * vec4<f32>(input.normal, 0.0);
  out.worldNormal = wn.xyz;
  out.albedo = input.color.rgb;
  return out;
}`;

const FRAGMENT_SRC = `${FACE_SHADE_FN}
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) albedo: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) viewDepth: f32,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let n = normalize(input.worldNormal);
  let L = normalize(shaderUniforms.sunDir);
  let sunUp = smoothstep(-0.04, 0.12, L.y);
  let ndl = max(dot(n, L), 0.0) * sunUp;
  let ambientFace = mix(1.0, mobFaceShade(n), 0.55);
  let irradiance = shaderUniforms.ambientColor * ambientFace + shaderUniforms.sunColor * ndl + vec3<f32>(0.03, 0.035, 0.045);
  let lit = input.albedo * irradiance;
  let fogStart = shaderUniforms.fogParams.x;
  let fogEnd = shaderUniforms.fogParams.y;
  let fogAmt = clamp((input.viewDepth - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  let foggy = mix(lit, shaderUniforms.fogColor, fogAmt);
  return vec4<f32>(foggy, 1.0);
}`;

export interface MobMaterialOptions {
    fogColor?: [number, number, number];
    fogStart?: number;
    fogEnd?: number;
    ambientColor?: [number, number, number];
    sunColor?: [number, number, number];
    sunDir?: [number, number, number];
}

export function createMobMaterial(name: string, options: MobMaterialOptions = {}): ShaderMaterial {
    const fogColor = options.fogColor ?? [0.7, 0.82, 0.92];
    const fogStart = options.fogStart ?? 40;
    const fogEnd = options.fogEnd ?? 120;
    const ambientColor = options.ambientColor ?? [0.45, 0.48, 0.55];
    const sunColor = options.sunColor ?? [0.55, 0.5, 0.42];
    const sunDir = options.sunDir ?? [0.45, 0.8, 0.35];

    const mat = createShaderMaterial({
        name,
        vertexSource: VERTEX_SRC,
        fragmentSource: FRAGMENT_SRC,
        attributes: ["position", "normal", "color"],
        uniforms: [
            "world",
            "worldView",
            "worldViewProjection",
            { name: "fogColor", type: "vec3<f32>", defaultValue: fogColor },
            { name: "fogParams", type: "vec2<f32>", defaultValue: [fogStart, fogEnd] },
            { name: "ambientColor", type: "vec3<f32>", defaultValue: ambientColor },
            { name: "sunColor", type: "vec3<f32>", defaultValue: sunColor },
            { name: "sunDir", type: "vec3<f32>", defaultValue: sunDir },
        ],
        samplers: [],
        backFaceCulling: false,
        depthWrite: true,
    });
    setShaderVector3(mat, "fogColor", fogColor);
    setShaderVector3(mat, "ambientColor", ambientColor);
    setShaderVector3(mat, "sunColor", sunColor);
    setShaderVector3(mat, "sunDir", sunDir);
    return mat;
}

/** Push the current day-night lighting to the mob material (call once per frame). */
export function setMobLighting(
    mat: ShaderMaterial,
    sunDir: [number, number, number],
    sunColor: [number, number, number],
    ambientColor: [number, number, number],
    fogColor: [number, number, number]
): void {
    setShaderVector3(mat, "sunDir", sunDir);
    setShaderVector3(mat, "sunColor", sunColor);
    setShaderVector3(mat, "ambientColor", ambientColor);
    setShaderVector3(mat, "fogColor", fogColor);
}
