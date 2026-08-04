/** Basic position-only picking pipelines. */
import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { pickingShaderSource } from "./picking-shader.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";
import { getPickingSceneBGL } from "./picking-scene-bgl.js";

let _device: GPUDevice | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _sets: Map<string, PickingPipelineSet> | null = null;

export interface PickingDiscardPipelineOptions {
    readonly key: string;
    readonly wgsl: string;
    readonly storage?: readonly { readonly name: string; readonly type: string }[];
}

export interface PickingPipelineSet {
    readonly regularPipeline: GPURenderPipeline;
    readonly thinInstancePipeline: GPURenderPipeline;
    readonly discardBGL: GPUBindGroupLayout | null;
}

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

function discardBGL(engine: EngineContext, discard: PickingDiscardPipelineOptions): GPUBindGroupLayout {
    return engine._device.createBindGroupLayout({
        label: `picking-discard-${discard.key}-bgl`,
        entries: (discard.storage ?? []).map((_, binding) => ({
            binding,
            visibility: SS.FRAGMENT,
            buffer: { type: "read-only-storage" },
        })),
    });
}

const POSITION: GPUVertexBufferLayout = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
};

function pipeline(engine: EngineContext, discard: PickingDiscardPipelineOptions | null, group2: GPUBindGroupLayout | null, label: string): GPURenderPipeline {
    const device = engine._device;
    const module = device.createShaderModule({
        label: `${label}-shader`,
        code: pickingShaderSource(discard ? { discardWgsl: discard.wgsl, storage: discard.storage } : undefined),
    });
    const group1 = meshBGL(engine);
    const layout = device.createPipelineLayout({
        label: `${label}-pipeline-layout`,
        bindGroupLayouts: group2 ? [getPickingSceneBGL(engine), group1, group2] : [getPickingSceneBGL(engine), group1],
    });
    return device.createRenderPipeline({
        label: `${label}-pipeline`,
        layout,
        vertex: { module, entryPoint: "vs", buffers: [POSITION] },
        fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }, { format: "r32float" }] },
        depthStencil: { format: "depth24plus", depthCompare: "greater", depthWriteEnabled: true },
        primitive: { topology: "triangle-list", cullMode: "none" },
        multisample: { count: 1 },
    });
}

export function getPickingPipelineSet(engine: EngineContext, discard?: PickingDiscardPipelineOptions | null): PickingPipelineSet {
    invalidate(engine);
    const key = discard ? `discard:${discard.key}` : "default";
    const sets = (_sets ??= new Map());
    const cached = sets.get(key);
    if (cached) {
        return cached;
    }
    const active = discard ?? null;
    const group2 = active?.storage?.length ? discardBGL(engine, active) : null;
    const regularPipeline = pipeline(engine, active, group2, active ? `picking-${active.key}` : "picking");
    const set = {
        regularPipeline,
        thinInstancePipeline: regularPipeline,
        discardBGL: group2,
    };
    sets.set(key, set);
    return set;
}
