import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";
import type { PickDiscardRule } from "./gpu-picker.js";
import { getPickingSceneBGL } from "./picking-scene-bgl.js";

export interface PickingPipelineSet {
    readonly regularPipeline: GPURenderPipeline;
    readonly thinInstancePipeline: GPURenderPipeline;
    readonly discardBGL: GPUBindGroupLayout | null;
    readonly detailed: true;
}

let _device: GPUDevice | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _sets: Map<string, PickingPipelineSet> | null = null;

function invalidate(engine: EngineContext): void {
    if (_device === engine._device) {
        return;
    }
    _device = engine._device;
    _meshBGL = null;
    _sets = null;
}

function meshBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidate(engine);
    return (_meshBGL ??= createSingleUniformBGL(engine, "picking-mesh-bgl", SS.VERTEX | SS.FRAGMENT));
}

function group2(engine: EngineContext, rule: PickDiscardRule): GPUBindGroupLayout | null {
    if (!rule.storage?.length) {
        return null;
    }
    return engine._device.createBindGroupLayout({
        label: `picking-discard-${rule.key}-bgl`,
        entries: rule.storage.map((_, binding) => ({
            binding,
            visibility: SS.FRAGMENT,
            buffer: { type: "read-only-storage" },
        })),
    });
}

function shader(rule: PickDiscardRule | null): string {
    const declarations = rule?.storage?.map((s, binding) => `@group(2) @binding(${binding}) var<storage, read> ${s.name}: ${s.type};`).join("\n") ?? "";
    const discard =
        rule?.wgsl ??
        `fn shouldDiscardPick(input: PickDiscardInput) -> bool {
return false;
}`;
    const shared = `enable primitive_index;
struct SceneUniforms { viewProjection: mat4x4f, fragmentCoord: vec2f }
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
struct PickDiscardInput {
worldPos: vec3f,
fragmentCoord: vec2f,
pickId: u32,
thinInstanceIndex: u32,
hasThinInstance: u32,
instanceExtras: vec4f,
}
${declarations}
${discard}
struct O {
@builtin(position) p: vec4f,
@location(0) @interpolate(flat) id: u32,
@location(1) w: vec3f,
@location(2) @interpolate(flat) ti: u32,
@location(3) @interpolate(flat) hasTi: u32,
@location(4) @interpolate(flat) extras: vec4f,
@location(5) local: vec3f,
}
struct F { @location(0) color: vec4f, @location(1) depth: f32, @location(2) detail: vec4u }
@fragment fn fs(i: O, @builtin(primitive_index) primitiveIndex: u32) -> F {
if (shouldDiscardPick(PickDiscardInput(i.w, scene.fragmentCoord, i.id, i.ti, i.hasTi, i.extras))) { discard; }
let r = f32((i.id >> 16u) & 255u) / 255.0;
let g = f32((i.id >> 8u) & 255u) / 255.0;
let b = f32(i.id & 255u) / 255.0;
return F(vec4f(r, g, b, 1), i.p.z, vec4u(primitiveIndex, bitcast<u32>(i.local.x), bitcast<u32>(i.local.y), bitcast<u32>(i.local.z)));
}`;
    return `${shared}
struct M { world: mat4x4f, pickId: u32 }
@group(1) @binding(0) var<uniform> m: M;
@vertex fn vs(@location(0) position: vec3f) -> O {
var o: O;
let w = (m.world * vec4f(position, 1)).xyz;
o.p = scene.viewProjection * vec4f(w, 1);
o.id = m.pickId;
o.w = w;
o.ti = 0xffffffffu;
o.hasTi = 0u;
o.extras = vec4f(0);
o.local = position;
return o;
}`;
}

const POSITION: GPUVertexBufferLayout = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
};

function create(engine: EngineContext, rule: PickDiscardRule | null, discardBGL: GPUBindGroupLayout | null, label: string): GPURenderPipeline {
    const device = engine._device;
    const module = device.createShaderModule({ label: `${label}-shader`, code: shader(rule) });
    const bgl1 = meshBGL(engine);
    return device.createRenderPipeline({
        label: `${label}-pipeline`,
        layout: device.createPipelineLayout({
            bindGroupLayouts: discardBGL ? [getPickingSceneBGL(engine), bgl1, discardBGL] : [getPickingSceneBGL(engine), bgl1],
        }),
        vertex: { module, entryPoint: "vs", buffers: [POSITION] },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }, { format: "r32float" }, { format: "rgba32uint" }] },
        depthStencil: { format: "depth24plus", depthCompare: "greater", depthWriteEnabled: true },
        primitive: { topology: "triangle-list", cullMode: "none" },
    });
}

export function getPickingPipelineSet(engine: EngineContext, rule?: PickDiscardRule | null): PickingPipelineSet {
    invalidate(engine);
    const key = rule ? rule.key : "default";
    const sets = (_sets ??= new Map());
    const cached = sets.get(key);
    if (cached) {
        return cached;
    }
    const active = rule ?? null;
    const discardBGL = active ? group2(engine, active) : null;
    const regularPipeline = create(engine, active, discardBGL, active ? `picking-${active.key}-detailed` : "picking-detailed");
    const set = {
        regularPipeline,
        thinInstancePipeline: regularPipeline,
        discardBGL,
        detailed: true as const,
    };
    sets.set(key, set);
    return set;
}
