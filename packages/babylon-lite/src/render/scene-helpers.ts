/** Scene helpers — shared utilities for renderable builders.
 *
 *  Centralises patterns that PBR and Standard pipelines previously duplicated:
 *  scene BGL creation, mesh world-matrix updates, and pipeline descriptors. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import { REVERSE_DEPTH_COMPARE } from "../engine/render-target.js";

// ── Scene bind group layout (group 0) ────────────────────────────

let _cachedSceneBGL: GPUBindGroupLayout | null = null;
let _cachedDevice: GPUDevice | null = null;

/** Shared scene bind group layout:
 *  binding 0: per-pass SceneUniforms UBO
 *  binding 1: scene-owned LightsUniforms UBO */
export function getSceneBindGroupLayout(engine: EngineContextInternal): GPUBindGroupLayout {
    const device = engine.device;
    if (_cachedSceneBGL && _cachedDevice === device) {
        return _cachedSceneBGL;
    }
    _cachedDevice = device;
    _cachedSceneBGL = device.createBindGroupLayout({
        label: "scene",
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        ],
    });
    return _cachedSceneBGL;
}

/** Clear the cached scene BGL (called on disposal / device change). */
export function clearSceneBGLCache(): void {
    _cachedSceneBGL = null;
    _cachedDevice = null;
}

// ── Mesh world-matrix UBO update ─────────────────────────────────

/** Packet-style record for world-matrix dirty checking. */
export interface WorldMatrixPacket {
    readonly mesh: Mesh;
    readonly meshUBO: GPUBuffer;
    _lastWorldVersion: number;
}

/** Write world matrices to UBOs for packets whose version has changed. */
export function updateWorldMatrixUBOs(engine: EngineContextInternal, packets: WorldMatrixPacket[]): void {
    const device = engine.device;
    for (const p of packets) {
        const wm = p.mesh.worldMatrix;
        if (p.mesh.worldMatrixVersion !== p._lastWorldVersion) {
            device.queue.writeBuffer(p.meshUBO, 0, wm as unknown as Float32Array<ArrayBuffer>);
            p._lastWorldVersion = p.mesh.worldMatrixVersion;
        }
    }
}

// ── Pipeline descriptor builder ──────────────────────────────────

export interface PipelineDescriptorOpts {
    _label: string;
    _engine: EngineContextInternal;
    _bgls: GPUBindGroupLayout[];
    _vertModule: GPUShaderModule;
    _fragModule: GPUShaderModule;
    _vertexBuffers: GPUVertexBufferLayout[];
    _format: GPUTextureFormat;
    /** Depth-stencil format. Default: `"depth24plus-stencil8"` (matches the engine's default RT). */
    _depthStencilFormat?: GPUTextureFormat;
    /** Depth compare. Default: reverse-Z `"greater-equal"`. */
    _depthCompare?: GPUCompareFunction;
    _msaaSamples: number;
    _depthWriteEnabled?: boolean;
    _cullMode?: GPUCullMode;
    _blend?: GPUBlendState;
    /** When true, build with `frontFace: "cw"` (offscreen RTT with Y-flipped projection). */
    _flipY?: boolean;
}

/** Build a render pipeline descriptor with the engine's default reverse-Z state:
 *  depth24plus-stencil8, greater-equal, triangle-list, ccw front face (cw if flipY). */
export function createDefaultPipelineDescriptor(opts: PipelineDescriptorOpts): GPURenderPipelineDescriptor {
    const target: GPUColorTargetState = opts._blend ? { format: opts._format, blend: opts._blend } : { format: opts._format };
    return {
        label: opts._label,
        layout: opts._engine.device.createPipelineLayout({ bindGroupLayouts: opts._bgls }),
        vertex: { module: opts._vertModule, entryPoint: "main", buffers: opts._vertexBuffers },
        fragment: { module: opts._fragModule, entryPoint: "main", targets: [target] },
        depthStencil: {
            format: opts._depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: opts._depthCompare ?? REVERSE_DEPTH_COMPARE,
            depthWriteEnabled: opts._depthWriteEnabled ?? true,
        },
        multisample: { count: opts._msaaSamples },
        primitive: { topology: "triangle-list", cullMode: opts._cullMode ?? "back", frontFace: opts._flipY ? "cw" : "ccw" },
    };
}
