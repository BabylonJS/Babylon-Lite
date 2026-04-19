import type { EngineContextInternal } from "../engine/engine.js";
import { pickingShaderSource, pickingThinInstanceShaderSource } from "./picking-shader.js";
import { createSingleUniformBGL } from "../shader/bgl-helpers.js";

// ─── Cache state (auto-invalidate on device change) ─────────────────

let _cachedDevice: GPUDevice | null = null;
let _pipeline: GPURenderPipeline | null = null;
let _tiPipeline: GPURenderPipeline | null = null;
let _sceneBGL: GPUBindGroupLayout | null = null;
let _meshBGL: GPUBindGroupLayout | null = null;
let _tiMeshBGL: GPUBindGroupLayout | null = null;

function invalidateIfNeeded(engine: EngineContextInternal): void {
    const device = engine.device;
    if (device !== _cachedDevice) {
        _pipeline = null;
        _tiPipeline = null;
        _sceneBGL = null;
        _meshBGL = null;
        _tiMeshBGL = null;
        _cachedDevice = device;
    }
}

// ─── Bind group layouts ─────────────────────────────────────────────

/** Group 0: scene-level viewProjection uniform. */
export function getPickingSceneBGL(engine: EngineContextInternal): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    if (!_sceneBGL) {
        _sceneBGL = createSingleUniformBGL(engine, "picking-scene-bgl", GPUShaderStage.VERTEX);
    }
    return _sceneBGL;
}

/** Group 1: per-mesh world matrix + pickId uniform (regular meshes). */
export function getPickingMeshBGL(engine: EngineContextInternal): GPUBindGroupLayout {
    invalidateIfNeeded(engine);
    if (!_meshBGL) {
        _meshBGL = createSingleUniformBGL(engine, "picking-mesh-bgl", GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT);
    }
    return _meshBGL;
}

/** Group 1: per-mesh baseMeshPickId uniform + instance storage buffer (thin instances). */
export function getPickingTIMeshBGL(engine: EngineContextInternal): GPUBindGroupLayout {
    const device = engine.device;
    invalidateIfNeeded(engine);
    if (!_tiMeshBGL) {
        _tiMeshBGL = device.createBindGroupLayout({
            label: "picking-ti-mesh-bgl",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: "read-only-storage" },
                },
            ],
        });
    }
    return _tiMeshBGL;
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
    label: string;
}

function createPickingPipelineInternal(engine: EngineContextInternal, opts: PickingPipelineOptions): GPURenderPipeline {
    const device = engine.device;
    const module = device.createShaderModule({ label: `${opts.label}-shader`, code: opts.shader });
    const layout = device.createPipelineLayout({
        label: `${opts.label}-pipeline-layout`,
        bindGroupLayouts: [getPickingSceneBGL(engine), opts.meshBGL],
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
            depthCompare: "less",
            depthWriteEnabled: true,
        },
        primitive: {
            topology: "triangle-list",
            cullMode: "back",
            frontFace: "ccw",
        },
        multisample: { count: 1 },
    });
}

/** Get (or create) the picking pipeline for regular meshes. */
export function getPickingPipeline(engine: EngineContextInternal): GPURenderPipeline {
    invalidateIfNeeded(engine);
    if (!_pipeline) {
        _pipeline = createPickingPipelineInternal(engine, {
            shader: pickingShaderSource,
            meshBGL: getPickingMeshBGL(engine),
            label: "picking",
        });
    }
    return _pipeline;
}

/** Get (or create) the picking pipeline for thin-instanced meshes. */
export function getPickingTIPipeline(engine: EngineContextInternal): GPURenderPipeline {
    invalidateIfNeeded(engine);
    if (!_tiPipeline) {
        _tiPipeline = createPickingPipelineInternal(engine, {
            shader: pickingThinInstanceShaderSource,
            meshBGL: getPickingTIMeshBGL(engine),
            label: "picking-ti",
        });
    }
    return _tiPipeline;
}
