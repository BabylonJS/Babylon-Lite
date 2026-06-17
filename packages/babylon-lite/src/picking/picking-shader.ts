/** WGSL shaders for GPU pick-ID rendering.
 *  Outputs pick ID as rgba8unorm (location 0) and depth as r32float (location 1). */

// ─── Shared structs + fragment shader ───────────────────────────────

const PICK_SHARED = /* wgsl */ `
fn pickClipOne(wp: vec3f, a: vec4f, b: vec4f, c: vec4f) -> bool {
let q = wp.xz - a.xy;
let ds = dot(q, a.zw);
let dp = dot(q, vec2f(-a.w, a.z));
if (abs(dp) > c.y) { return false; }
let y = wp.y - b.x;
let outerHW = b.y + c.x;
if (c.z > 0.5) { return y <= b.z + c.x && abs(ds) <= outerHW; }
if (y <= b.z) { return abs(ds) <= outerHW; }
let outerRise = b.w + c.x;
if (y > b.z + outerRise || outerRise <= 0.0) { return false; }
let ex = ds / max(outerHW, 0.001);
let ey = (y - b.z) / max(outerRise, 0.001);
return ex * ex + ey * ey <= 1.0;
}
`;

// ─── Shared structs + fragment shader ───────────────────────────────

const PICK_FS = /* wgsl */ `
struct VsOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) pickId: u32, @location(1) worldPos: vec3f, @location(2) clipSkip: f32 };
struct FsOut { @location(0) color: vec4f, @location(1) depth: vec4f };
@fragment fn fs(input: VsOut) -> FsOut {
if (input.clipSkip < 0.5 && pickClipHit(input.worldPos)) { discard; }
let id = input.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), vec4f(input.position.z, 0.0, 0.0, 0.0));
}
`;

// ─── Regular mesh picking shader ────────────────────────────────────

export const pickingShaderSource = /* wgsl */ `
struct SceneUniforms { viewProjection: mat4x4f };
struct MeshUniforms {
world: mat4x4f,
pickId: u32,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
@group(1) @binding(1) var<storage, read> clipData: array<vec4f>;
${PICK_SHARED}
fn pickClipHit(wp: vec3f) -> bool {
let n = i32(clipData[0].x);
for (var i = 0; i < n; i = i + 1) {
let base = 1 + i * 3;
if (pickClipOne(wp, clipData[base], clipData[base + 1], clipData[base + 2])) { return true; }
}
return false;
}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f) -> VsOut {
var out: VsOut;
let wp = (mesh.world * vec4f(position, 1.0)).xyz;
out.position = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = mesh.pickId;
out.worldPos = wp;
out.clipSkip = 0.0;
return out;
}
`;

// ─── Thin-instance picking shader ───────────────────────────────────

export const pickingThinInstanceShaderSource = /* wgsl */ `
struct SceneUniforms { viewProjection: mat4x4f };
struct TIMeshUniforms {
baseMeshPickId: u32,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> tiMesh: TIMeshUniforms;
@group(1) @binding(1) var<storage, read> instances: array<mat4x4f>;
@group(1) @binding(2) var<storage, read> clipData: array<vec4f>;
${PICK_SHARED}
fn pickClipHit(wp: vec3f) -> bool {
let n = i32(clipData[0].x);
for (var i = 0; i < n; i = i + 1) {
let base = 1 + i * 3;
if (pickClipOne(wp, clipData[base], clipData[base + 1], clipData[base + 2])) { return true; }
}
return false;
}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f, @builtin(instance_index) instanceIndex: u32) -> VsOut {
let m = instances[instanceIndex];
// Treat the instance placement as an AFFINE transform: force the basis columns' homogeneous w to 0 and the
// translation column's w to 1. Thin-instanced ShaderMaterials may pack per-instance data in those spare w
// lanes (a sanctioned pattern — Lite injects world0..world3 and the app's own vertex shader zeroes them
// before transforming, e.g. a frozen anchor Y in world0.w). Picking only needs the transform, so any packed
// value left in w would corrupt clip.w → wrong depth/rasterisation → the pick returns the wrong instance.
let world = mat4x4f(
vec4f(m[0].xyz, 0.0),
vec4f(m[1].xyz, 0.0),
vec4f(m[2].xyz, 0.0),
vec4f(m[3].xyz, 1.0),
);
var out: VsOut;
let wp = (world * vec4f(position, 1.0)).xyz;
out.position = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = tiMesh.baseMeshPickId + instanceIndex;
out.worldPos = wp;
out.clipSkip = clamp(floor(max(m[2].w, 0.0) * 0.25), 0.0, 1.0);
return out;
}
`;
