/** Billboard GPU-picking pipeline — dynamic-imported by `gpu-picker.ts` when a
 *  scene contains a `BillboardSpriteSystem`.
 *
 *  Billboards are world-space, camera-oriented quads drawn inside the scene's 3D
 *  pass, so they must be picked in the SAME depth-sorted 1×1 pass the mesh picker
 *  uses (a billboard occluded by a wall must not win the pick). This mirrors the
 *  Gaussian-splatting picking integration (`gs-picking-pipeline.ts`): the picker
 *  assigns each system a contiguous pick-id range after the meshes + GS meshes,
 *  draws every system into the shared pass with the pick-zoomed view-projection,
 *  and resolves the read-back id back to `{ system, spriteIndex }`.
 *
 *  The vertex stage reproduces the render shader's quad math (`billboard-pipeline.ts`)
 *  exactly — same corner derivation, pivot, rotation, and camera-basis orientation —
 *  so the picked pixel matches what the renderer drew. The camera basis cannot be
 *  read from the pick scene UBO (it carries only the pick-zoomed view-projection),
 *  so the camera right/up world axes are extracted on the CPU and passed in the
 *  per-system pick UBO. The fragment encodes the pick id as RGB and the NDC depth
 *  as `r32float`, matching the mesh picker's two-attachment contract.
 */
import { F32, U32 } from "../engine/typed-arrays.js";
import { BU, SS, CW } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { BillboardOrientation, BillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import { BILLBOARD_INSTANCE_STRIDE_BYTES } from "../sprite/billboard-sprite.js";
import { getPickingSceneBGL } from "./picking-pipeline.js";
import type { GpuPicker } from "./gpu-picker.js";
import type { PickingInfo } from "./picking-info.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Camera } from "../camera/camera.js";
import { getViewMatrix } from "../camera/camera.js";

/** Result of a successful {@link pickBillboardSprite} hit (re-exported from the public picker). */
export interface BillboardPickInfo {
    /** The billboard system that owns the hit sprite. */
    system: BillboardSpriteSystem;
    /** Index-API slot of the hit sprite within `system` (the value returned by `addBillboardSpriteIndex`). */
    spriteIndex: number;
    /** World-space hit point reconstructed from the pick depth, or `null` if it could not be reconstructed. */
    pickedPoint: [number, number, number] | null;
    /** Distance from the camera to `pickedPoint`, or `0` when unavailable. */
    distance: number;
}

/** Per-pick UBO: 48 bytes. Layout matches the WGSL `BB` struct below. */
const BILLBOARD_PICK_UBO_BYTES = 48;

// Instance vertex attribute byte offsets — must match the render layout in `billboard-pipeline.ts`.
const POSITION_OFFSET_BYTES = 0;
const SIZE_OFFSET_BYTES = 12;
const UV_MIN_OFFSET_BYTES = 20;
const UV_MAX_OFFSET_BYTES = 28;
const ROTATION_OFFSET_BYTES = 36;
const PIVOT_OFFSET_BYTES = 40;

const SHARED_QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

/**
 * Pack the per-pick billboard UBO into `f32`/`u32` (aliased views of one 48-byte buffer).
 * Layout (vec3 + scalar interleave): `[0..2]` camRight, `[3]` baseId (u32), `[4..6]` camUp,
 * `[7]` cutoff, `[8..10]` axis, `[11]` pad. camRight/camUp are rows 0/1 of the column-major
 * view matrix — reproducing the render shader's `normalize(view rowN)` camera basis.
 */
export function packBillboardPickUbo(view: Mat4, baseId: number, cutoff: number, axis: readonly [number, number, number], f32: Float32Array, u32: Uint32Array): void {
    f32[0] = view[0]!;
    f32[1] = view[4]!;
    f32[2] = view[8]!;
    u32[3] = baseId;
    f32[4] = view[1]!;
    f32[5] = view[5]!;
    f32[6] = view[9]!;
    f32[7] = cutoff;
    f32[8] = axis[0];
    f32[9] = axis[1];
    f32[10] = axis[2];
}

function makePickBasisWgsl(orientation: BillboardOrientation): string {
    switch (orientation) {
        case "facing":
            return `fn basis() -> B {
let r = normalize(bb.camRight);
let u = normalize(bb.camUp);
return B(r, -u);
}`;
        case "axis-locked":
            return `fn basis() -> B {
let a = normalize(bb.axis);
let cr = normalize(bb.camRight);
let pr = cr - a * dot(cr, a);
let pl = length(pr);
let f = select(vec3f(0, 0, 1), vec3f(1, 0, 0), abs(a.z) > 0.999);
let fr = cross(a, f);
let r = select(fr / max(length(fr), 1e-4), pr / max(pl, 1e-4), pl > 1e-4);
return B(r, -a);
}`;
    }
}

function makeBillboardPickWgsl(orientation: BillboardOrientation, isCutout: boolean): string {
    const cutoutBindings = isCutout
        ? `@group(1) @binding(1) var atlasTex: texture_2d<f32>;
@group(1) @binding(2) var atlasSamp: sampler;`
        : "";
    const uvVarying = isCutout ? `,\n@location(1) uv: vec2f` : "";
    const uvAssign = isCutout ? `out.uv = mix(in.a, in.b, q);` : "";
    const cutoutDiscard = isCutout
        ? `let s = textureSample(atlasTex, atlasSamp, in.uv);
if (s.a < bb.cutoff) {
discard;
}`
        : "";
    return `struct PickScene { viewProjection: mat4x4f };
@group(0) @binding(0) var<uniform> scene: PickScene;
struct BB {
camRight: vec3f,
baseId: u32,
camUp: vec3f,
cutoff: f32,
axis: vec3f,
_pad: f32,
};
@group(1) @binding(0) var<uniform> bb: BB;
${cutoutBindings}
struct B { r: vec3f, u: vec3f };
${makePickBasisWgsl(orientation)}
struct I {
@builtin(vertex_index) vid: u32,
@builtin(instance_index) iid: u32,
@location(0) p: vec3f,
@location(1) s: vec2f,
@location(2) a: vec2f,
@location(3) b: vec2f,
@location(4) r: f32,
@location(5) o: vec2f,
};
struct O {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) pickId: u32${uvVarying}
};
@vertex
fn vs(in: I) -> O {
let q = vec2f(select(0.0, 1.0, in.vid == 1u || in.vid == 2u), select(0.0, 1.0, in.vid >= 2u));
let l = (q - in.o) * in.s;
let cr = cos(in.r);
let sr = sin(in.r);
let rot = vec2f(l.x * cr - l.y * sr, l.x * sr + l.y * cr);
let bs = basis();
let wp = in.p + bs.r * rot.x + bs.u * rot.y;
var out: O;
out.p = scene.viewProjection * vec4f(wp, 1);
out.pickId = bb.baseId + in.iid;
${uvAssign}
return out;
}
struct FsOut { @location(0) color: vec4f, @location(1) depth: vec4f };
@fragment
fn fs(in: O) -> FsOut {
${cutoutDiscard}
let id = in.pickId;
let r = f32((id >> 16u) & 0xFFu) / 255.0;
let g = f32((id >> 8u) & 0xFFu) / 255.0;
let b = f32(id & 0xFFu) / 255.0;
return FsOut(vec4f(r, g, b, 1.0), vec4f(in.p.z, 0.0, 0.0, 0.0));
}`;
}

interface BillboardPickCache {
    device: GPUDevice;
    /** Pipelines keyed by `${orientation}|${isCutout ? 1 : 0}`. */
    pipelines: Map<string, GPURenderPipeline>;
    /** Group-1 bind-group layouts keyed by `isCutout`. */
    bgls: Map<string, GPUBindGroupLayout>;
}

let _cache: BillboardPickCache | null = null;

function getCache(engine: EngineContext): BillboardPickCache {
    if (_cache && _cache.device === engine._device) {
        return _cache;
    }
    _cache = { device: engine._device, pipelines: new Map(), bgls: new Map() };
    return _cache;
}

function getGroup1Bgl(engine: EngineContext, cache: BillboardPickCache, isCutout: boolean): GPUBindGroupLayout {
    const key = isCutout ? "cutout" : "plain";
    let bgl = cache.bgls.get(key);
    if (!bgl) {
        const entries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } }];
        if (isCutout) {
            entries.push({ binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: "float" } });
            entries.push({ binding: 2, visibility: SS.FRAGMENT, sampler: { type: "filtering" } });
        }
        bgl = engine._device.createBindGroupLayout({ label: `billboard-pick-bgl-${key}`, entries });
        cache.bgls.set(key, bgl);
    }
    return bgl;
}

function getPickPipeline(engine: EngineContext, system: BillboardSpriteSystem): GPURenderPipeline {
    const cache = getCache(engine);
    const orientation = system._orientation;
    const isCutout = system._depthMode === "cutout";
    const key = `${orientation}|${isCutout ? 1 : 0}`;
    const cached = cache.pipelines.get(key);
    if (cached) {
        return cached;
    }
    const device = engine._device;
    const module = device.createShaderModule({ label: `billboard-pick-${key}`, code: makeBillboardPickWgsl(orientation, isCutout) });
    const group1Bgl = getGroup1Bgl(engine, cache, isCutout);
    const pipeline = device.createRenderPipeline({
        label: `billboard-pick-pipeline-${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [getPickingSceneBGL(engine), group1Bgl] }),
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [
                {
                    arrayStride: BILLBOARD_INSTANCE_STRIDE_BYTES,
                    stepMode: "instance",
                    attributes: [
                        { shaderLocation: 0, offset: POSITION_OFFSET_BYTES, format: "float32x3" },
                        { shaderLocation: 1, offset: SIZE_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 2, offset: UV_MIN_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 3, offset: UV_MAX_OFFSET_BYTES, format: "float32x2" },
                        { shaderLocation: 4, offset: ROTATION_OFFSET_BYTES, format: "float32" },
                        { shaderLocation: 5, offset: PIVOT_OFFSET_BYTES, format: "float32x2" },
                    ],
                },
            ],
        },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm", writeMask: CW.ALL }, { format: "r32float" }] },
        // Match the mesh picker: reverse-Z depth (clear 0, "greater") so a billboard occluded by a
        // mesh — or by a nearer billboard — loses the pick. Write depth so billboards occlude too.
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthCompare: "greater", depthWriteEnabled: true },
        multisample: { count: 1 },
    });
    cache.pipelines.set(key, pipeline);
    return pipeline;
}

/** Per-system GPU resources allocated on first pick of that system. */
export interface BillboardPickResources {
    ubo: GPUBuffer;
    uboScratch: ArrayBuffer;
    uboF32: Float32Array;
    uboU32: Uint32Array;
    instanceBuffer: GPUBuffer;
    instanceCapacity: number;
    indexBuffer: GPUBuffer;
    bindGroup: GPUBindGroup;
}

export function createBillboardPickResources(engine: EngineContext, system: BillboardSpriteSystem): BillboardPickResources {
    const device = engine._device;
    const cache = getCache(engine);
    const isCutout = system._depthMode === "cutout";

    const ubo = device.createBuffer({ label: "billboard-pick-ubo", size: BILLBOARD_PICK_UBO_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    const uboScratch = new ArrayBuffer(BILLBOARD_PICK_UBO_BYTES);

    const instanceCapacity = Math.max(1, system._capacity);
    const instanceBuffer = device.createBuffer({
        label: "billboard-pick-instances",
        size: instanceCapacity * BILLBOARD_INSTANCE_STRIDE_BYTES,
        usage: BU.VERTEX | BU.COPY_DST,
    });

    const indexBuffer = device.createBuffer({ label: "billboard-pick-indices", size: SHARED_QUAD_INDICES.byteLength, usage: BU.INDEX | BU.COPY_DST });
    device.queue.writeBuffer(indexBuffer, 0, SHARED_QUAD_INDICES);

    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: ubo } }];
    if (isCutout) {
        entries.push({ binding: 1, resource: system.atlas.texture.view });
        entries.push({ binding: 2, resource: system.atlas.texture.sampler });
    }
    const bindGroup = device.createBindGroup({ label: "billboard-pick-bg", layout: getGroup1Bgl(engine, cache, isCutout), entries });

    return {
        ubo,
        uboScratch,
        uboF32: new F32(uboScratch),
        uboU32: new U32(uboScratch),
        instanceBuffer,
        instanceCapacity,
        indexBuffer,
        bindGroup,
    };
}

export function disposeBillboardPickResources(res: BillboardPickResources): void {
    res.ubo.destroy();
    res.instanceBuffer.destroy();
    res.indexBuffer.destroy();
}

/**
 * Draw one billboard system into the shared pick pass with consecutive pick ids `[baseId, baseId + count)`.
 * The caller must have already bound the pick scene UBO (pick-zoomed view-projection) at group 0.
 * `view` is the camera's column-major view matrix (for the billboard basis).
 */
export function drawBillboardForPicking(
    pass: GPURenderPassEncoder,
    engine: EngineContext,
    system: BillboardSpriteSystem,
    res: BillboardPickResources,
    baseId: number,
    view: Mat4
): void {
    const device = engine._device;
    const count = system.count;
    if (count === 0) {
        return;
    }

    // Grow the pick instance buffer if the system outgrew it since the last pick.
    if (system._capacity > res.instanceCapacity) {
        res.instanceBuffer.destroy();
        res.instanceCapacity = system._capacity;
        res.instanceBuffer = device.createBuffer({
            label: "billboard-pick-instances",
            size: res.instanceCapacity * BILLBOARD_INSTANCE_STRIDE_BYTES,
            usage: BU.VERTEX | BU.COPY_DST,
        });
    }
    // Upload the system's CPU instance data in logical order, so pick id − baseId == sprite index.
    const data = system._instanceData;
    device.queue.writeBuffer(res.instanceBuffer, 0, data.buffer, data.byteOffset, count * BILLBOARD_INSTANCE_STRIDE_BYTES);

    // Per-pick UBO: camera basis + axis + baseId + alpha cutoff (cutout only).
    const cutoff = system._depthMode === "cutout" ? system.alphaCutoff : 0;
    packBillboardPickUbo(view, baseId, cutoff, system._axis, res.uboF32, res.uboU32);
    device.queue.writeBuffer(res.ubo, 0, res.uboScratch, 0, BILLBOARD_PICK_UBO_BYTES);

    pass.setPipeline(getPickPipeline(engine, system));
    pass.setBindGroup(1, res.bindGroup);
    pass.setIndexBuffer(res.indexBuffer, "uint16");
    pass.setVertexBuffer(0, res.instanceBuffer);
    pass.drawIndexed(6, count);
}

// ─── Contributor orchestration ──────────────────────────────────────────────
// These run the whole billboard pass on behalf of the GPU picker. They live here (the
// dynamic-imported pick module) rather than in `gpu-picker.ts` so a picker scene with no
// billboards never fetches this code — `gpu-picker.ts` keeps only a thin guarded dispatch.

/**
 * Draw every billboard system in `scene` into the shared pick pass and return the next free pick id.
 * Reads `scene._billboardSystems` and computes the camera view internally, so the caller
 * (`gpu-picker`) ships none of that. Each system consumes a contiguous id range
 * `[baseId, baseId + count)`; ids advance by `count` even for a hidden system so id↔system mapping
 * stays positional with {@link resolveAndAttachBillboard}. Per-system GPU resources are created on
 * demand and cached on the picker.
 */
export function drawBillboardsForPicking(
    picker: GpuPicker,
    pass: GPURenderPassEncoder,
    engine: EngineContext,
    scene: SceneContext,
    camera: Camera,
    nextId: number,
    sceneBG: GPUBindGroup
): number {
    const systems = scene._billboardSystems;
    // GS may have rebound group 0 to its own pick matrix; restore the shared pick-zoomed VP.
    pass.setBindGroup(0, sceneBG);
    const view = getViewMatrix(camera);
    const resMap = picker._billboardResources ?? (picker._billboardResources = new Map());
    for (let i = 0; i < systems.length; i++) {
        const system = systems[i]!;
        const baseId = nextId;
        nextId += system.count;
        if (!system.visible || system.count === 0) {
            continue;
        }
        let res = resMap.get(system);
        if (!res) {
            res = createBillboardPickResources(engine, system);
            resMap.set(system, res);
        }
        drawBillboardForPicking(pass, engine, system, res, baseId, view);
    }
    return nextId;
}

/**
 * Resolve a read-back pick id to its owning billboard system + sprite index and attach the sprite
 * payload to `info` (read by `pickBillboardSprite`). Scans `count` exactly as
 * {@link drawBillboardsForPicking} advanced ids, so the mapping is positional. Pure CPU; a no-op if
 * the id matches no system. The caller has already classified the id as in-range (a numeric compare
 * against the billboard range start), so this only finds *which* system owns it.
 */
export function resolveAndAttachBillboard(info: PickingInfo, scene: SceneContext, pickId: number, startId: number): void {
    const systems = scene._billboardSystems;
    let scanId = startId;
    for (let i = 0; i < systems.length; i++) {
        const system = systems[i]!;
        const count = system.count;
        if (pickId >= scanId && pickId < scanId + count) {
            info._spritePick = { system, spriteIndex: pickId - scanId, pickedPoint: info.pickedPoint, distance: info.distance };
            return;
        }
        scanId += count;
    }
}

/** Dispose all per-system pick resources held by the picker (and clear the cache). */
export function disposeBillboardResources(picker: GpuPicker): void {
    const resMap = picker._billboardResources;
    if (!resMap) {
        return;
    }
    for (const res of resMap.values()) {
        disposeBillboardPickResources(res);
    }
    picker._billboardResources = null;
}
