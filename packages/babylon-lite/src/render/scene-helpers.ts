/** Scene helpers — shared utilities for renderable builders.
 *
 *  Centralises patterns that PBR and Standard pipelines previously duplicated:
 *  scene BGL creation, mesh world-matrix updates, and pipeline descriptors. */

import { SS } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import { REVERSE_DEPTH_COMPARE } from "../engine/render-target.js";

// ── Scene bind group layout (group 0) ────────────────────────────

let _cachedSceneBGL: GPUBindGroupLayout | null = null;
let _cachedDevice: GPUDevice | null = null;

/** Shared scene bind group layout:
 *  binding 0: per-pass SceneUniforms UBO
 *  binding 1: scene-owned LightsUniforms UBO */
export function getSceneBindGroupLayout(engine: EngineContext): GPUBindGroupLayout {
    const device = engine._device;
    if (_cachedSceneBGL && _cachedDevice === device) {
        return _cachedSceneBGL;
    }
    _cachedDevice = device;
    _cachedSceneBGL = device.createBindGroupLayout({
        label: "scene",
        entries: [
            { binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } },
            { binding: 1, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
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
    /** @internal */
    _lastWorldVersion: number;
}

/** Write world matrices to UBOs for packets whose version has changed. */
export function updateWorldMatrixUBOs(engine: EngineContext, packets: WorldMatrixPacket[]): void {
    const device = engine._device;
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
    /** @internal */
    _label: string;
    /** @internal */
    _engine: EngineContext;
    /** @internal */
    _bgls: GPUBindGroupLayout[];
    /** @internal */
    _vertModule: GPUShaderModule;
    /** @internal */
    _fragModule: GPUShaderModule;
    /** @internal */
    _vertexBuffers: GPUVertexBufferLayout[];
    /** @internal */
    _format: GPUTextureFormat;
    /** @internal Depth-stencil format. Default: `"depth24plus-stencil8"` (matches the engine's default RT). */
    _depthStencilFormat?: GPUTextureFormat;
    /** @internal Depth compare. Default: reverse-Z `"greater-equal"`. */
    _depthCompare?: GPUCompareFunction;
    /** @internal */
    _msaaSamples: number;
    /** @internal */
    _depthWriteEnabled?: boolean;
    /** @internal */
    _cullMode?: GPUCullMode;
    /** @internal */
    _blend?: GPUBlendState;
}

/** Build a render pipeline descriptor with the engine's default reverse-Z state:
 *  depth24plus-stencil8, greater-equal, triangle-list, ccw front face. */
export function createDefaultPipelineDescriptor(opts: PipelineDescriptorOpts): GPURenderPipelineDescriptor {
    const target: GPUColorTargetState = opts._blend ? { format: opts._format, blend: opts._blend } : { format: opts._format };
    return {
        label: opts._label,
        layout: opts._engine._device.createPipelineLayout({ bindGroupLayouts: opts._bgls }),
        vertex: { module: opts._vertModule, entryPoint: "main", buffers: opts._vertexBuffers },
        fragment: { module: opts._fragModule, entryPoint: "main", targets: [target] },
        depthStencil: {
            format: opts._depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: opts._depthCompare ?? REVERSE_DEPTH_COMPARE,
            depthWriteEnabled: opts._depthWriteEnabled ?? true,
        },
        multisample: { count: opts._msaaSamples },
        primitive: { topology: "triangle-list", cullMode: opts._cullMode ?? "back", frontFace: "ccw" },
    };
}
