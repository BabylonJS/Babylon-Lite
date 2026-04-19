/**
 * Per-(variant, blendMode) GPU pick pipeline cache for billboard sprites.
 *
 * Each variant ("facing", "yaw", "axis") shares the rendered vertex math so
 * the picked silhouette matches the rendered silhouette exactly (including
 * alpha-cutout `discard`). Non-pickable sprites discard via the
 * `flagsAndPad.z` flag bit packed by `sprite-billboard-shared.packSlot`.
 *
 * The shared pick scene UBO at @group(0) @binding(0) holds the pick-zoomed VP
 * (64 B — same one used by the mesh picker). Each system contributes its own
 * 80-byte UBO at @group(1) @binding(2) holding the camera basis (so we don't
 * need to re-bind `Sprite3DSceneUBO`), the lock axis (axis variant), the base
 * pick ID, and the alpha cutoff.
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { BillboardVariant } from "../sprite-billboard-shared.js";
import { SPRITE_3D_DATA_WGSL } from "../shared/sprite-3d-instance-wgsl.js";

/** Bytes of the per-system pick UBO. */
export const BILLBOARD_PICK_UBO_BYTES = 80;

/** Layout (matches WGSL struct):
 *    0..15  cameraRight (xyz basis; w packs camPos.x)
 *   16..31  cameraUp    (xyz basis; w packs camPos.y)
 *   32..47  cameraForward (xyz basis; w packs camPos.z)
 *   48..63  lockAxis (xyz; w unused, used only by axis variant)
 *   64..67  baseId   (u32 — first pick ID assigned to instance 0)
 *   68..71  alphaCutoff (f32 — used only when cutout)
 *   72..79  _pad
 */

interface PickPipelineEntry {
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    systemBGL: GPUBindGroupLayout;
}

interface DeviceCache {
    device: GPUDevice;
    pipelines: Map<string, PickPipelineEntry>;
    sceneBGL: GPUBindGroupLayout;
    systemBGL: GPUBindGroupLayout;
}

let _cache: DeviceCache | null = null;

function getCache(engine: EngineContextInternal): DeviceCache {
    const device = engine.device;
    if (_cache && _cache.device === device) {
        return _cache;
    }
    const sceneBGL = device.createBindGroupLayout({
        label: "billboard-pick-scene-bgl",
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const systemBGL = device.createBindGroupLayout({
        label: "billboard-pick-system-bgl",
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        ],
    });
    _cache = { device, pipelines: new Map(), sceneBGL, systemBGL };
    return _cache;
}

const SYSTEM_UBO_WGSL = /* wgsl */ `
struct PickSystemUBO {
    cameraRight: vec4<f32>,
    cameraUp: vec4<f32>,
    cameraForward: vec4<f32>,
    lockAxis: vec4<f32>,
    baseId: u32,
    alphaCutoff: f32,
    _pad0: f32,
    _pad1: f32,
};
`;

/** Build the body that converts world position → clip + writes pick id.
 *  `worldExpr` must produce a `vec3<f32>` from `s` (sprite struct) and helpers. */
function vertexShader(variant: BillboardVariant): string {
    let basis: string;
    switch (variant) {
        case "facing":
            basis = `let world = s.worldPos + sysu.cameraRight.xyz * rotated.x + sysu.cameraUp.xyz * rotated.y;`;
            break;
        case "yaw":
            basis = `
let camPos = vec3<f32>(sysu.cameraRight.w, sysu.cameraUp.w, sysu.cameraForward.w);
let toCam = normalize(camPos - s.worldPos);
let up = vec3<f32>(0.0, 1.0, 0.0);
let rightRaw = cross(up, toCam);
let rightLen = length(rightRaw);
let right = select(vec3<f32>(1.0, 0.0, 0.0), rightRaw / max(rightLen, 1e-6), rightLen > 1e-4);
let world = s.worldPos + right * rotated.x + up * rotated.y;
`;
            break;
        case "axis":
            basis = `
let camPos = vec3<f32>(sysu.cameraRight.w, sysu.cameraUp.w, sysu.cameraForward.w);
let a = normalize(sysu.lockAxis.xyz);
let toCam = normalize(camPos - s.worldPos);
let fRaw = toCam - a * dot(toCam, a);
let fLen = length(fRaw);
let fallback = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(a.x) < 0.9);
let f = select(fallback, fRaw / max(fLen, 1e-6), fLen > 1e-4);
let right = normalize(cross(a, f));
let world = s.worldPos + right * rotated.x + a * rotated.y;
`;
            break;
    }
    return /* wgsl */ `
struct PickSceneUBO { viewProjection: mat4x4<f32> };
@group(0) @binding(0) var<uniform> scene: PickSceneUBO;
${SYSTEM_UBO_WGSL}
${SPRITE_3D_DATA_WGSL}

struct VSIn { @builtin(vertex_index) vid: u32, @location(0) sortIndex: u32 };
struct VsOut { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) pickId: u32, @location(1) uv: vec2<f32>, @location(2) @interpolate(flat) pickable: f32 };

fn rotate2(p: vec2<f32>, sinCos: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(p.x * sinCos.y - p.y * sinCos.x, p.x * sinCos.x + p.y * sinCos.y);
}
fn cornerOf(vid: u32) -> vec2<f32> {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0)
    );
    return corners[vid];
}
fn cornerUV(corner: vec2<f32>, rect: vec4<f32>, flipX: f32, flipY: f32) -> vec2<f32> {
    var u = mix(rect.x, rect.z, corner.x);
    var v = mix(rect.y, rect.w, corner.y);
    if (flipX > 0.5) { u = rect.x + rect.z - u; }
    if (flipY > 0.5) { v = rect.y + rect.w - v; }
    return vec2<f32>(u, v);
}

@vertex fn vs(in: VSIn) -> VsOut {
    let s = sprites[in.sortIndex];
    let corner = cornerOf(in.vid);
    let local = (corner - s.pivot) * s.sizePxOrWorld;
    let rotated = rotate2(local, s.sinCos);
    ${basis}
    var out: VsOut;
    out.position = scene.viewProjection * vec4<f32>(world, 1.0);
    out.pickId = sysu.baseId + in.sortIndex;
    out.uv = cornerUV(corner, s.uvRect, s.flagsAndPad.x, s.flagsAndPad.y);
    out.pickable = s.flagsAndPad.z;
    return out;
}
`;
}

function fragmentShader(isCutout: boolean): string {
    const cutoff = isCutout ? `let c = textureSample(atlasTex, atlasSamp, in.uv); if (c.a < sysu.alphaCutoff) { discard; }` : ``;
    return /* wgsl */ `
${SYSTEM_UBO_WGSL}
@group(1) @binding(0) var atlasTex: texture_2d<f32>;
@group(1) @binding(1) var atlasSamp: sampler;
@group(1) @binding(2) var<uniform> sysu: PickSystemUBO;

struct VsOut { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) pickId: u32, @location(1) uv: vec2<f32>, @location(2) @interpolate(flat) pickable: f32 };
struct FsOut { @location(0) color: vec4<f32>, @location(1) depth: vec4<f32> };

@fragment fn fs(in: VsOut) -> FsOut {
    if (in.pickable < 0.5) { discard; }
    ${cutoff}
    let id = in.pickId;
    let r = f32((id >> 16u) & 0xFFu) / 255.0;
    let g = f32((id >> 8u)  & 0xFFu) / 255.0;
    let b = f32(id & 0xFFu) / 255.0;
    return FsOut(vec4<f32>(r, g, b, 1.0), vec4<f32>(in.position.z, 0.0, 0.0, 0.0));
}
`;
}

/** Get (or create) the pick pipeline for a given variant + cutout flag. */
export function getBillboardPickPipeline(
    engine: EngineContextInternal,
    variant: BillboardVariant,
    isCutout: boolean
): { pipeline: GPURenderPipeline; sceneBGL: GPUBindGroupLayout; systemBGL: GPUBindGroupLayout } {
    const cache = getCache(engine);
    const key = `${variant}|${isCutout ? 1 : 0}`;
    let entry = cache.pipelines.get(key);
    if (entry) {
        return entry;
    }
    const device = engine.device;
    const vsModule = device.createShaderModule({ label: `billboard-pick-${key}-vs`, code: vertexShader(variant) });
    const fsModule = device.createShaderModule({ label: `billboard-pick-${key}-fs`, code: fragmentShader(isCutout) });
    const pipeline = device.createRenderPipeline({
        label: `billboard-pick-${key}-pipeline`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [cache.sceneBGL, cache.systemBGL] }),
        vertex: {
            module: vsModule,
            entryPoint: "vs",
            buffers: [{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "uint32" }] }],
        },
        fragment: { module: fsModule, entryPoint: "fs", targets: [{ format: "rgba8unorm" }, { format: "r32float" }] },
        primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
        depthStencil: { format: "depth24plus", depthCompare: "less", depthWriteEnabled: true },
        multisample: { count: 1 },
    });
    entry = { pipeline, sceneBGL: cache.sceneBGL, systemBGL: cache.systemBGL };
    cache.pipelines.set(key, entry);
    return entry;
}
