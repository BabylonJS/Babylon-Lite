/** WGSL generation for advanced GPU mesh-picking variants.
 *
 * Every mesh variant (regular, thin-instanced, interleaved, discarded, or vertex-adjusted)
 * is produced from this owner so ID, depth, primitive identity, and hook inputs cannot drift.
 */

export interface PickingShaderOptions {
    readonly discardWgsl?: string | null;
    readonly worldAdjustWgsl?: string | null;
    readonly storage?: readonly { readonly name: string; readonly type: string; readonly vertex?: boolean }[];
    readonly vertexDataComponents?: 0 | 2 | 3 | 4;
    readonly exposeVertexData?: boolean;
    /** Emit the optional packed detailed result (primitive id + interpolated local position). */
    readonly detailed?: boolean;
    /** @internal Optional material-owned vertex projection composed into this mesh-pick variant. */
    readonly _vertexProjection?: PickingVertexProjectionShader | null;
}

/** @internal Shader half of a lazily loaded mesh-pick vertex projection. Each body defines
 *  `projectedTransform` and `projectedWorld`; the picker then applies the ordinary caller world
 *  adjustment exactly once with the projected transform's basis/origin. */
export interface PickingVertexProjectionShader {
    readonly regularDeclarations: string;
    readonly thinDeclarations: string;
    readonly regularInputs: string;
    readonly thinInputs: string;
    readonly regularBody: string;
    readonly thinBody: string;
}

const PICK_SCENE = /* wgsl */ `
struct SceneUniforms {
viewProjection: mat4x4f,
fragmentCoord: vec2f,
};
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
`;

const DEFAULT_PICK_DISCARD = /* wgsl */ `
fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return false;
}
`;

const DEFAULT_PICK_WORLD_ADJUST = /* wgsl */ `
fn adjustPickWorld(input: PickWorldInput) -> vec3f {
return input.worldPos;
}
`;

function inputStructs(exposeVertexData: boolean): string {
    return /* wgsl */ `
struct PickDiscardInput {
worldPos: vec3f,
fragmentCoord: vec2f,
pickId: u32,
thinInstanceIndex: u32,
hasThinInstance: u32,
instanceExtras: vec4f,
${exposeVertexData ? "vertexData: vec4f," : ""}
};
struct PickWorldInput {
worldPos: vec3f,
localPos: vec3f,
basis0: vec3f,
basis1: vec3f,
basis2: vec3f,
origin: vec3f,
instanceExtras: vec4f,
thinInstanceIndex: u32,
hasThinInstance: u32,
vertexData: vec4f,
};
`;
}

function storageDecls(opts: PickingShaderOptions): string {
    return opts.storage?.length ? opts.storage.map((storage, binding) => `@group(2) @binding(${binding}) var<storage, read> ${storage.name}: ${storage.type};`).join("\n") : "";
}

function fragmentShader(exposeVertexData: boolean, detailed: boolean): string {
    return /* wgsl */ `
struct VsOut {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) pickId: u32,
@location(1) worldPos: vec3f,
@location(2) @interpolate(flat) thinInstanceIndex: u32,
@location(3) @interpolate(flat) hasThinInstance: u32,
@location(4) @interpolate(flat) instanceExtras: vec4f,
${exposeVertexData ? "@location(5) @interpolate(flat) vertexData: vec4f," : ""}
@location(6) @interpolate(flat) excluded: u32,
${detailed ? "@location(7) localPos: vec3f," : ""}
};
struct FsOut {
@location(0) color: vec4f,
@location(1) depth: f32,
${detailed ? "@location(2) detail: vec4u," : ""}
};
@fragment fn fs(input: VsOut${detailed ? ", @builtin(primitive_index) primitiveIndex: u32" : ""}) -> FsOut {
if (input.excluded != 0u) { discard; }
if (shouldDiscardPick(PickDiscardInput(input.worldPos, scene.fragmentCoord, input.pickId, input.thinInstanceIndex, input.hasThinInstance, input.instanceExtras${exposeVertexData ? ", input.vertexData" : ""}))) { discard; }
let id = input.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), input.p.z${detailed ? ", vec4u(primitiveIndex, bitcast<u32>(input.localPos.x), bitcast<u32>(input.localPos.y), bitcast<u32>(input.localPos.z))" : ""});
}
`;
}

function regularInput(components: 0 | 2 | 3 | 4): string {
    return components === 0 ? "" : `, @location(5) vertexData: vec${components}f`;
}

function paddedVertexData(components: 0 | 2 | 3 | 4): string {
    if (components === 2) {
        return "vec4f(vertexData, 0.0, 0.0)";
    }
    if (components === 3) {
        return "vec4f(vertexData, 0.0)";
    }
    if (components === 4) {
        return "vertexData";
    }
    return "vec4f(0.0)";
}

/** Build one regular or thin-instance pick shader variant. */
export function pickingShaderVariantSource(thinInstance: boolean, opts: PickingShaderOptions = {}): string {
    const components = opts.vertexDataComponents ?? 0;
    const exposeVertexData = opts.exposeVertexData ?? false;
    const detailed = opts.detailed ?? false;
    const projection = opts._vertexProjection ?? null;
    const shared = /* wgsl */ `
${detailed ? "enable primitive_index;" : ""}
${PICK_SCENE}
${inputStructs(exposeVertexData)}
${storageDecls(opts)}
${opts.discardWgsl ?? DEFAULT_PICK_DISCARD}
${opts.worldAdjustWgsl ?? DEFAULT_PICK_WORLD_ADJUST}
${thinInstance ? (projection?.thinDeclarations ?? "") : (projection?.regularDeclarations ?? "")}
${fragmentShader(exposeVertexData, detailed)}
`;

    if (!thinInstance) {
        return /* wgsl */ `
${shared}
struct MeshUniforms {
world: mat4x4f,
pickId: u32,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;
@vertex fn vs(@location(0) position: vec3f${regularInput(components)}${projection?.regularInputs ?? ""}) -> VsOut {
var out: VsOut;
let vertexPayload = ${paddedVertexData(components)};
let baseWorld = (mesh.world * vec4f(position, 1.0)).xyz;
${projection?.regularBody ?? "let projectedTransform = mesh.world;\nlet projectedWorld = baseWorld;"}
let wp = adjustPickWorld(PickWorldInput(projectedWorld, position, projectedTransform[0].xyz, projectedTransform[1].xyz, projectedTransform[2].xyz, projectedTransform[3].xyz, vec4f(0.0), 0xffffffffu, 0u, vertexPayload));
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = mesh.pickId;
out.worldPos = wp;
out.thinInstanceIndex = 0xffffffffu;
out.hasThinInstance = 0u;
out.instanceExtras = vec4f(0.0);
out.excluded = 0u;
${detailed ? "out.localPos = position;" : ""}
${exposeVertexData ? "out.vertexData = vertexPayload;" : ""}
return out;
}
`;
    }

    return /* wgsl */ `
${shared}
struct TIMeshUniforms {
world: mat4x4f,
baseMeshPickId: u32,
excludedThinInstanceStart: u32,
excludedThinInstanceCount: u32,
};
@group(1) @binding(0) var<uniform> tiMesh: TIMeshUniforms;
@group(1) @binding(1) var<storage, read> instances: array<mat4x4f>;
@vertex fn vs(@location(0) position: vec3f${projection?.thinInputs ?? ""}, @builtin(instance_index) instanceIndex: u32) -> VsOut {
let packed = instances[instanceIndex];
let instanceWorld = mat4x4f(
vec4f(packed[0].xyz, 0.0),
vec4f(packed[1].xyz, 0.0),
vec4f(packed[2].xyz, 0.0),
vec4f(packed[3].xyz, 1.0),
);
let world = tiMesh.world * instanceWorld;
let extras = vec4f(packed[0].w, packed[1].w, packed[2].w, packed[3].w);
let baseWorld = (world * vec4f(position, 1.0)).xyz;
${projection?.thinBody ?? "let projectedTransform = world;\nlet projectedWorld = baseWorld;"}
let wp = adjustPickWorld(PickWorldInput(projectedWorld, position, projectedTransform[0].xyz, projectedTransform[1].xyz, projectedTransform[2].xyz, projectedTransform[3].xyz, extras, instanceIndex, 1u, vec4f(0.0)));
var out: VsOut;
out.p = scene.viewProjection * vec4f(wp, 1.0);
out.pickId = tiMesh.baseMeshPickId + instanceIndex;
out.worldPos = wp;
out.thinInstanceIndex = instanceIndex;
out.hasThinInstance = 1u;
out.instanceExtras = extras;
let excludedOffset = instanceIndex - tiMesh.excludedThinInstanceStart;
out.excluded = select(0u, 1u, tiMesh.excludedThinInstanceCount > 0u && instanceIndex >= tiMesh.excludedThinInstanceStart && excludedOffset < tiMesh.excludedThinInstanceCount);
${detailed ? "out.localPos = position;" : ""}
${exposeVertexData ? "out.vertexData = vec4f(0.0);" : ""}
return out;
}
`;
}

export function pickingShaderSource(opts?: PickingShaderOptions): string {
    return pickingShaderVariantSource(false, opts);
}

export function pickingThinInstanceShaderSource(opts?: PickingShaderOptions): string {
    return pickingShaderVariantSource(true, opts);
}
