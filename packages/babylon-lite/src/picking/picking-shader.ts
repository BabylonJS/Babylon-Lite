/** WGSL shaders for GPU pick-ID rendering.
 *  Outputs pick ID as rgba8unorm (location 0) and depth as r32float (location 1). */

// ─── Shared structs + fragment shader ───────────────────────────────

const PICK_FS = /* wgsl */ `
struct VsOut { @builtin(position) position: vec4f, @location(0) @interpolate(flat) pickId: u32 };
struct FsOut { @location(0) color: vec4f, @location(1) depth: vec4f };
@fragment fn fs(input: VsOut) -> FsOut {
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
struct MeshUniforms { world: mat4x4f, pickId: u32 };
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f) -> VsOut {
var out: VsOut;
out.position = scene.viewProjection * mesh.world * vec4f(position, 1.0);
out.pickId = mesh.pickId;
return out;
}
`;

// ─── Thin-instance picking shader ───────────────────────────────────

export const pickingThinInstanceShaderSource = /* wgsl */ `
struct SceneUniforms { viewProjection: mat4x4f };
struct TIMeshUniforms { baseMeshPickId: u32 };
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(1) @binding(0) var<uniform> tiMesh: TIMeshUniforms;
@group(1) @binding(1) var<storage, read> instances: array<mat4x4f>;
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
out.position = scene.viewProjection * world * vec4f(position, 1.0);
out.pickId = tiMesh.baseMeshPickId + instanceIndex;
return out;
}
`;
