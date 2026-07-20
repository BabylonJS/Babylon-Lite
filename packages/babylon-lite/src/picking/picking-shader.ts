/** WGSL shaders for GPU pick-ID rendering.
 *  Outputs pick ID as rgba8unorm (location 0) and depth as r32float (location 1). */

export interface PickingShaderOptions {
    readonly discardWgsl?: string | null;
    /** Optional WGSL replacing `adjustPickWorld` (default: identity). Internal pick pipelines can mirror
     *  world-space vertex displacement using the declared storage, thin-instance index, and spare matrix w lanes. */
    readonly worldAdjustWgsl?: string | null;
    readonly storage?: readonly { readonly name: string; readonly type: string }[];
}

const PICK_DISCARD_INPUT = /* wgsl */ `
struct PickDiscardInput {
worldPos: vec3f,
fragmentCoord: vec2f,
pickId: u32,
thinInstanceIndex: u32,
hasThinInstance: u32,
instanceExtras: vec4f,
};
`;

const DEFAULT_PICK_DISCARD = /* wgsl */ `
fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return false;
}
`;

function pickDiscardSource(opts?: PickingShaderOptions): string {
    return opts?.discardWgsl ?? DEFAULT_PICK_DISCARD;
}

const DEFAULT_PICK_WORLD_ADJUST = /* wgsl */ `
fn adjustPickWorld(worldPos: vec3f, instanceExtras: vec4f, thinInstanceIndex: u32) -> vec3f {
return worldPos;
}
`;

function pickWorldAdjustSource(opts?: PickingShaderOptions): string {
    return opts?.worldAdjustWgsl ?? DEFAULT_PICK_WORLD_ADJUST;
}

function pickStorageDecls(opts?: PickingShaderOptions): string {
    const storage = opts?.storage;
    if (!storage || storage.length === 0) {
        return "";
    }
    return storage.map((s, binding) => `@group(2) @binding(${binding}) var<storage, read> ${s.name}: ${s.type};`).join("\n");
}

// ─── Shared structs + fragment shader ───────────────────────────────

const PICK_SCENE = /* wgsl */ `
struct SceneUniforms {
viewProjection: mat4x4f,
fragmentCoord: vec2f,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
`;

const PICK_FS = /* wgsl */ `
struct VsOut {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) pickId: u32,
@location(1) worldPos: vec3f,
@location(2) @interpolate(flat) thinInstanceIndex: u32,
@location(3) @interpolate(flat) hasThinInstance: u32,
@location(4) @interpolate(flat) instanceExtras: vec4f,
};
struct FsOut { @location(0) color: vec4f, @location(1) depth: vec4f };
@fragment fn fs(input: VsOut) -> FsOut {
if (shouldDiscardPick(PickDiscardInput(input.worldPos, scene.fragmentCoord, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras))) { discard; }
let id = input.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), vec4f(input.p.z, 0.0, 0.0, 0.0));
}
`;

// ─── Regular mesh picking shader ────────────────────────────────────

export function pickingShaderSource(opts?: PickingShaderOptions): string {
    return /* wgsl */ `
${PICK_SCENE}
struct MeshUniforms {
world: mat4x4f,
pickId: u32,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${PICK_DISCARD_INPUT}
${pickStorageDecls(opts)}
${pickDiscardSource(opts)}
${pickWorldAdjustSource(opts)}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f) -> VsOut {
var out: VsOut;
let wp = adjustPickWorld((mesh.world * vec4f(position, 1.0)).xyz, vec4f(0.0), 0xffffffffu);
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = mesh.pickId;
out.worldPos = wp;
out.thinInstanceIndex = 0xffffffffu;
out.hasThinInstance = 0u;
out.instanceExtras = vec4f(0.0);
return out;
}
`;
}

// ─── Thin-instance picking shader ───────────────────────────────────

export function pickingThinInstanceShaderSource(opts?: PickingShaderOptions): string {
    return /* wgsl */ `
${PICK_SCENE}
struct TIMeshUniforms {
baseMeshPickId: u32,
};
@group(1) @binding(0) var<uniform> tiMesh: TIMeshUniforms;
@group(1) @binding(1) var<storage, read> instances: array<mat4x4f>;
${PICK_DISCARD_INPUT}
${pickStorageDecls(opts)}
${pickDiscardSource(opts)}
${pickWorldAdjustSource(opts)}
${PICK_FS}
@vertex fn vs(@location(0) position: vec3f, @builtin(instance_index) instanceIndex: u32) -> VsOut {
let m = instances[instanceIndex];
// Treat the instance placement as an AFFINE transform: force the basis columns' homogeneous w to 0 and the
// translation column's w to 1. Thin-instanced ShaderMaterials may pack per-instance data in those spare w
// lanes (a sanctioned pattern — Lite injects world0..world3 and the app's own vertex shader zeroes them
// before transforming). Picking only needs the transform, so packed values are exposed separately.
let world = mat4x4f(
vec4f(m[0].xyz, 0.0),
vec4f(m[1].xyz, 0.0),
vec4f(m[2].xyz, 0.0),
vec4f(m[3].xyz, 1.0),
);
let extras = vec4f(m[0].w, m[1].w, m[2].w, m[3].w);
var out: VsOut;
let wp = adjustPickWorld((world * vec4f(position, 1.0)).xyz, extras, instanceIndex);
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = tiMesh.baseMeshPickId + instanceIndex;
out.worldPos = wp;
out.thinInstanceIndex = instanceIndex;
out.hasThinInstance = 1u;
out.instanceExtras = extras;
return out;
}
`;
}
