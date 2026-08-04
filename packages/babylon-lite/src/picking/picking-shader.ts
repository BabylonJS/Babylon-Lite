/** WGSL shaders for the basic position-only GPU pick path. */

export interface PickingShaderOptions {
    readonly discardWgsl?: string | null;
    readonly storage?: readonly { readonly name: string; readonly type: string }[];
}

const PICK_INPUT = /* wgsl */ `
struct PickDiscardInput {
worldPos: vec3f,
fragmentCoord: vec2f,
pickId: u32,
thinInstanceIndex: u32,
hasThinInstance: u32,
instanceExtras: vec4f,
};
`;

const DEFAULT_DISCARD = /* wgsl */ `
fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return false;
}
`;

function storageDecls(opts?: PickingShaderOptions): string {
    const storage = opts?.storage;
    return storage?.length ? storage.map((s, binding) => `@group(2) @binding(${binding}) var<storage, read> ${s.name}: ${s.type};`).join("\n") : "";
}

const SCENE = /* wgsl */ `
struct SceneUniforms {
viewProjection: mat4x4f,
fragmentCoord: vec2f,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
`;

const FRAGMENT = /* wgsl */ `
struct VsOut {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) pickId: u32,
@location(1) worldPos: vec3f,
@location(2) @interpolate(flat) thinInstanceIndex: u32,
@location(3) @interpolate(flat) hasThinInstance: u32,
@location(4) @interpolate(flat) instanceExtras: vec4f,
};
struct FsOut { @location(0) color: vec4f, @location(1) depth: f32 };
@fragment fn fs(input: VsOut) -> FsOut {
if (shouldDiscardPick(PickDiscardInput(input.worldPos, scene.fragmentCoord, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras))) { discard; }
let id = input.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), input.p.z);
}
`;

export function pickingShaderSource(opts?: PickingShaderOptions): string {
    return /* wgsl */ `
${SCENE}
struct MeshUniforms {
world: mat4x4f,
pickId: u32,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
${PICK_INPUT}
${storageDecls(opts)}
${opts?.discardWgsl ?? DEFAULT_DISCARD}
${FRAGMENT}
@vertex fn vs(@location(0) position: vec3f) -> VsOut {
var out: VsOut;
let wp = (mesh.world * vec4f(position, 1.0)).xyz;
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
