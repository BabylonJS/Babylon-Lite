// Voxel surface material: samples the block atlas, then lights it from baked
// per-vertex terms carried in `color` (r = ambient occlusion, g = skylight
// visibility, b = blocklight) combined in the shader with the dynamic day-night
// sun/ambient and a warm torch tint, and applies linear distance fog toward the
// sky horizon colour. Three variants share one shader via defines:
//   - "opaque": solid blocks (depth write, back-face cull).
//   - "cutout": leaves/cactus — alpha-tested discard, still depth-writing.
//   - "blend":  water/glass/ice — alpha blended, no depth write, gentle wave shimmer.
//
// Vertex positions are world-space (chunk meshes sit at the origin) so fog and the
// water shimmer can use the world coordinate directly.

import { createShaderMaterial, setShaderTexture, setShaderVector3, setShaderFloat, type ShaderMaterial, type Texture2D } from "babylon-lite";

export type VoxelMaterialMode = "opaque" | "cutout" | "blend";

function vertexSource(mode: VoxelMaterialMode): string {
    return `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) ao: vec3<f32>,
  @location(2) viewDepth: f32,
  @location(3) worldPos: vec3<f32>,
  @location(4) normal: vec3<f32>,
  @location(5) fluid: f32,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  var p = input.position;
  ${
      mode === "blend"
          ? `// Drop the fluid (water) surface slightly and ripple it for a liquid feel.
  // Gated by the per-vertex fluid flag so solid translucent blocks (glass, ice)
  // stay perfectly still.
  let fluid = input.color.a;
  let wave = sin(p.x * 0.6 + shaderUniforms.uTime * 1.6) * 0.5 + sin(p.z * 0.7 + shaderUniforms.uTime * 1.3) * 0.5;
  p.y = p.y + (-0.12 + wave * 0.05) * fluid;`
          : mode === "cutout"
            ? `// Gentle wind sway for foliage (leaves), gated by the per-vertex sway flag so
  // solid cutout blocks (cactus) stay rigid.
  let sway = input.color.a;
  let t = shaderUniforms.uTime;
  let sx = sin(p.x * 0.5 + p.y * 0.3 + t * 1.3) + sin(p.z * 0.7 + t * 0.9);
  let sz = sin(p.z * 0.5 + p.y * 0.3 + t * 1.1) + sin(p.x * 0.6 + t * 0.7);
  p.x = p.x + sx * 0.045 * sway;
  p.z = p.z + sz * 0.045 * sway;`
            : ``
  }
  out.position = shaderSystem.worldViewProjection * vec4<f32>(p, 1.0);
  out.viewDepth = (shaderSystem.worldView * vec4<f32>(p, 1.0)).z;
  out.uv = input.uv;
  out.ao = input.color.rgb;
  out.worldPos = p;
  out.normal = input.normal;
  out.fluid = input.color.a;
  return out;
}`;
}

// Fixed Minecraft-style per-face shade derived from the dominant normal axis. Used
// only as an artistic tint on the ambient term (not on direct sun), so the dynamic
// sun direction still reads clearly on geometry.
const FACE_SHADE_FN = `fn mcFaceShade(n: vec3<f32>) -> f32 {
  if (n.y > 0.5) { return 1.0; }
  if (n.y < -0.5) { return 0.5; }
  if (abs(n.x) > 0.5) { return 0.8; }
  return 0.7;
}`;

function fragmentSource(mode: VoxelMaterialMode): string {
    const alphaTest = mode === "cutout" ? `if (tex.a < 0.5) { discard; }` : ``;
    let outColor: string;
    if (mode === "blend") {
        outColor = `let shimmer = 1.0 - input.fluid * (0.08 - 0.08 * sin(input.worldPos.x * 0.8 + input.worldPos.z * 0.8 + shaderUniforms.uTime * 2.0));
  var surf = tex.rgb;
  var outA = tex.a;
  if (input.fluid > 0.5) {
    // Depth-darkened water: shallows stay bright, deeps turn a richer blue, and
    // get a touch more opaque so deep water reads as a real body of water.
    let depth = clamp((30.0 - input.worldPos.y) / 9.0, 0.0, 1.0);
    surf = mix(surf, surf * vec3<f32>(0.35, 0.5, 0.7), depth * 0.8);
    outA = clamp(outA + depth * 0.18, 0.0, 1.0);
    // Animated ripple normal for moving sun sparkle on the surface.
    let t = shaderUniforms.uTime;
    let nx = 0.35 * sin(input.worldPos.x * 1.7 + t * 2.3) + 0.25 * sin(input.worldPos.z * 2.3 - t * 1.7);
    let nz = 0.35 * sin(input.worldPos.z * 1.9 + t * 2.1) + 0.25 * sin(input.worldPos.x * 2.1 + t * 1.3);
    let rn = normalize(vec3<f32>(nx, 4.0, nz));
    let hvec = normalize(normalize(shaderUniforms.sunDir) + vec3<f32>(0.0, 1.0, 0.0));
    let spec = pow(max(dot(rn, hvec), 0.0), 48.0);
    let sunUpW = smoothstep(-0.04, 0.12, shaderUniforms.sunDir.y);
    surf = surf + shaderUniforms.sunColor * spec * 1.6 * sunUpW;
    // Fresnel sky reflection: at grazing angles the surface mirrors the sky
    // horizon colour, giving water a reflective sheen that strengthens with the
    // ripple normal. Brighter by day, subdued at night.
    let viewDir = normalize(shaderUniforms.cameraPos - input.worldPos);
    let fres = pow(1.0 - clamp(dot(rn, viewDir), 0.0, 1.0), 5.0);
    let skyRefl = mix(shaderUniforms.fogColor, vec3<f32>(0.55, 0.7, 0.95), 0.35) * (0.35 + 0.65 * sunUpW);
    surf = mix(surf, skyRefl, fres * 0.5);
    outA = clamp(outA + fres * 0.22, 0.0, 1.0);
  }
  let lit = surf * input.ao.r * irradiance * shimmer;
  let foggy = mix(lit, shaderUniforms.fogColor, fogAmt);
  return vec4<f32>(foggy, outA * shaderUniforms.alpha);`;
    } else {
        outColor = `let lit = tex.rgb * input.ao.r * irradiance;
  let foggy = mix(lit, shaderUniforms.fogColor, fogAmt);
  return vec4<f32>(foggy, 1.0);`;
    }
    return `${FACE_SHADE_FN}
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) ao: vec3<f32>,
  @location(2) viewDepth: f32,
  @location(3) worldPos: vec3<f32>,
  @location(4) normal: vec3<f32>,
  @location(5) fluid: f32,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  let tex = textureSample(atlasTex, atlasTexSampler, input.uv);
  ${alphaTest}
  let fogStart = shaderUniforms.fogParams.x;
  let fogEnd = shaderUniforms.fogParams.y;
  let fog = clamp((input.viewDepth - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  // Atmospheric height-haze: low-lying distant terrain (valleys, shorelines, water)
  // gains a little extra aerial perspective, deepening the sense of distance without
  // washing out nearby blocks.
  let haze = clamp((36.0 - input.worldPos.y) / 26.0, 0.0, 1.0)
           * clamp((input.viewDepth - fogStart * 0.4) / (fogEnd - fogStart * 0.4), 0.0, 1.0) * 0.22;
  let fogAmt = clamp(fog + haze, 0.0, 1.0);
  // Directional sun (gated by sun altitude) + face-tinted ambient sky light,
  // both scaled by per-vertex skylight visibility, plus warm blocklight (torches)
  // and a tiny floor so fully-enclosed dug-out areas read near-black.
  let n = normalize(input.normal);
  let L = normalize(shaderUniforms.sunDir);
  let sunUp = smoothstep(-0.04, 0.12, L.y);
  let ndl = max(dot(n, L), 0.0) * sunUp;
  let ambientFace = mix(1.0, mcFaceShade(n), 0.55);
  // Shape the skylight so it falls off fast: a covered tunnel that loses a few
  // levels of skylight goes genuinely dark instead of merely dim (cube curve),
  // while fully sky-lit surfaces (skyVis == 1) stay at full brightness.
  let skyVis = input.ao.g;
  let skyShaped = skyVis * skyVis * skyVis;
  let blockVis = input.ao.b;
  let skyTerm = (shaderUniforms.ambientColor * ambientFace + shaderUniforms.sunColor * ndl) * skyShaped;
  let torchTerm = vec3<f32>(1.5, 0.86, 0.42) * (blockVis * blockVis);
  let irradiance = skyTerm + torchTerm + vec3<f32>(0.006, 0.007, 0.011);
  ${outColor}
}`;
}

export interface VoxelMaterialOptions {
    fogColor?: [number, number, number];
    fogStart?: number;
    fogEnd?: number;
    /** Blend-mode constant alpha multiplier (water/glass translucency). */
    alpha?: number;
    /** Initial ambient/sky light colour. */
    ambientColor?: [number, number, number];
    /** Initial sun colour. */
    sunColor?: [number, number, number];
    /** Initial direction TO the sun (need not be normalised). */
    sunDir?: [number, number, number];
}

const DEFAULT_AMBIENT: [number, number, number] = [0.45, 0.48, 0.55];
const DEFAULT_SUN_COLOR: [number, number, number] = [0.55, 0.5, 0.42];
const DEFAULT_SUN_DIR: [number, number, number] = [0.45, 0.8, 0.35];

export function createVoxelMaterial(name: string, atlas: Texture2D, mode: VoxelMaterialMode, options: VoxelMaterialOptions = {}): ShaderMaterial {
    const fogColor = options.fogColor ?? [0.62, 0.74, 0.86];
    const fogStart = options.fogStart ?? 40;
    const fogEnd = options.fogEnd ?? 120;
    const alpha = options.alpha ?? 1;
    const ambientColor = options.ambientColor ?? DEFAULT_AMBIENT;
    const sunColor = options.sunColor ?? DEFAULT_SUN_COLOR;
    const sunDir = options.sunDir ?? DEFAULT_SUN_DIR;

    const mat = createShaderMaterial({
        name,
        vertexSource: vertexSource(mode),
        fragmentSource: fragmentSource(mode),
        attributes: ["position", "normal", "uv", "color"],
        uniforms: [
            "worldViewProjection",
            "worldView",
            { name: "fogColor", type: "vec3<f32>", defaultValue: fogColor },
            { name: "fogParams", type: "vec2<f32>", defaultValue: [fogStart, fogEnd] },
            { name: "uTime", type: "f32", defaultValue: 0 },
            { name: "alpha", type: "f32", defaultValue: alpha },
            { name: "ambientColor", type: "vec3<f32>", defaultValue: ambientColor },
            { name: "sunColor", type: "vec3<f32>", defaultValue: sunColor },
            { name: "sunDir", type: "vec3<f32>", defaultValue: sunDir },
            { name: "cameraPos", type: "vec3<f32>", defaultValue: [0, 0, 0] },
        ],
        samplers: ["atlasTex"],
        backFaceCulling: mode !== "blend",
        depthWrite: mode !== "blend",
        needAlphaBlending: mode === "blend",
    });
    setShaderTexture(mat, "atlasTex", atlas);
    setShaderVector3(mat, "fogColor", fogColor);
    setShaderVector3(mat, "ambientColor", ambientColor);
    setShaderVector3(mat, "sunColor", sunColor);
    setShaderVector3(mat, "sunDir", sunDir);
    setShaderFloat(mat, "alpha", alpha);
    return mat;
}

/** Update the animated time uniform (call once per frame for blend materials). */
export function setVoxelTime(mat: ShaderMaterial, t: number): void {
    setShaderFloat(mat, "uTime", t);
}

/** Update the camera world position (used by water Fresnel reflection). */
export function setVoxelCameraPos(mat: ShaderMaterial, pos: [number, number, number]): void {
    setShaderVector3(mat, "cameraPos", pos);
}

/** Update the fog/horizon colour (e.g. for day-night tinting). */
export function setVoxelFogColor(mat: ShaderMaterial, color: [number, number, number]): void {
    setShaderVector3(mat, "fogColor", color);
}

/** Update the directional sun: direction-to-sun and colour. */
export function setVoxelSun(mat: ShaderMaterial, dir: [number, number, number], color: [number, number, number]): void {
    setShaderVector3(mat, "sunDir", dir);
    setShaderVector3(mat, "sunColor", color);
}

/** Update the ambient/sky light colour. */
export function setVoxelAmbient(mat: ShaderMaterial, color: [number, number, number]): void {
    setShaderVector3(mat, "ambientColor", color);
}
