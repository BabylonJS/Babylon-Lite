import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { pickingShaderSource, pickingThinInstanceShaderSource } from "./picking-shader.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

// ─── Cache state (auto-invalidate on device change) ─────────────────

let _cachedDevice: GPUDevice | null = null;
let _sceneBGL: GPUBindGroupLayout | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _tiMeshBGL: GPUBindGroupLayout | null = null;
let _pipelineSets: Map<string, PickingPipelineSet> | null = null;

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

function invalidateIfNeeded(engine: EngineContext): void {
    const device = engine._device;
    if (device !== _cachedDevice) {
        _sceneBGL = null;
        _meshBGL = null;
        _tiMeshBGL = null;
        _pipelineSets = null;
        _cachedDevice = device;
    }
}

// ─── Bind group layouts ─────────────────────────────────────────────

/** Group 0: scene-level viewProjection uniform. */
export function getPickingSceneBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    if (!_sceneBGL) {
        _sceneBGL = createSingleUniformBGL(engine, "picking-scene-bgl", SS.VERTEX | SS.FRAGMENT);
    }
    return _sceneBGL;
}

/** Group 1: per-mesh world matrix + pickId uniform (regular meshes). */
function getPickingMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    if (!_meshBGL) {
        _meshBGL = createSingleUniformBGL(engine, "picking-mesh-bgl", SS.VERTEX | SS.FRAGMENT);
    }
    return _meshBGL;
}

/** Group 1: per-mesh baseMeshPickId uniform + instance storage buffer (thin instances). */
function getPickingTIMeshBGL(engine: EngineContext): GPUBindGroupLayout {
    const device = engine._device;
    invalidateIfNeeded(engine);
    if (!_tiMeshBGL) {
        _tiMeshBGL = device.createBindGroupLayout({
            label: "picking-ti-mesh-bgl",
            entries: [
                {
                    binding: 0,
                    visibility: SS.VERTEX | SS.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: SS.VERTEX,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });
    }
    return _tiMeshBGL;
}

function createDiscardBGL(engine: EngineContext, discard: PickingDiscardPipelineOptions): GPUBindGroupLayout {
    return engine._device.createBindGroupLayout({
        label: `picking-discard-${discard.key}-bgl`,
        entries: (discard.storage ?? []).map((_, binding) => ({
            binding,
            visibility: SS.FRAGMENT,
            buffer: { type: "read-only-storage" },
        })),
    });
}

// ─── Position-only vertex layout ────────────────────────────────────

const POSITION_VERTEX_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: 12,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
};

// ─── Pipeline creation ──────────────────────────────────────────────

interface PickingPipelineOptions {
    shader: string;
    meshBGL: GPUBindGroupLayout;
    discardBGL: GPUBindGroupLayout | null;
    label: string;
}

function createPickingPipelineInternal(engine: EngineContext, opts: PickingPipelineOptions): GPURenderPipeline {
    const device = engine._device;
    const module = device.createShaderModule({ label: `${opts.label}-shader`, code: opts.shader });
    const bindGroupLayouts = opts.discardBGL ? [getPickingSceneBGL(engine), opts.meshBGL, opts.discardBGL] : [getPickingSceneBGL(engine), opts.meshBGL];
    const layout = device.createPipelineLayout({
        label: `${opts.label}-pipeline-layout`,
        bindGroupLayouts,
    });
    return device.createRenderPipeline({
        label: `${opts.label}-pipeline`,
        layout,
        vertex: {
            module,
            entryPoint: "vs",
            buffers: [POSITION_VERTEX_LAYOUT],
        },
        fragment: {
            module,
            entryPoint: "fs",
            targets: [{ format: "rgba8unorm" }, { format: "r32float" }],
        },
        depthStencil: {
            format: "depth24plus",
            depthCompare: "greater",
            depthWriteEnabled: true,
        },
        primitive: {
            topology: "triangle-list",
            // Pick the NEAREST surface regardless of facing (matches Babylon.js Scene.pick, which intersects
            // both triangle sides). Culling back faces here would make any DOUBLE-SIDED mesh
            // unpickable wherever the renderer shows its back face.
            cullMode: "none",
        },
        multisample: { count: 1 },
    });
}

/** Get (or create) the picking pipeline set for the default path or a caller-provided discard rule. */
export function getPickingPipelineSet(engine: EngineContext, discard?: PickingDiscardPipelineOptions | null): PickingPipelineSet {
    invalidateIfNeeded(engine);
    const key = discard ? `discard:${discard.key}` : "default";
    const pipelineSets = _pipelineSets ?? (_pipelineSets = new Map());
    const cached = pipelineSets.get(key);
    if (cached) {
        return cached;
    }

    const discardBGL = discard?.storage?.length ? createDiscardBGL(engine, discard) : null;
    const shaderOptions = discard ? { discardWgsl: discard.wgsl, storage: discard.storage } : undefined;
    const regularPipeline = createPickingPipelineInternal(engine, {
        shader: pickingShaderSource(shaderOptions),
        meshBGL: getPickingMeshBGL(engine),
        discardBGL,
        label: discard ? `picking-${discard.key}` : "picking",
    });
    const thinInstancePipeline = createPickingPipelineInternal(engine, {
        shader: pickingThinInstanceShaderSource(shaderOptions),
        meshBGL: getPickingTIMeshBGL(engine),
        discardBGL,
        label: discard ? `picking-ti-${discard.key}` : "picking-ti",
    });
    const set = { regularPipeline, thinInstancePipeline, discardBGL };
    pipelineSets.set(key, set);
    return set;
}
