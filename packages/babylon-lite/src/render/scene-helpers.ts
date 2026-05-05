/** Scene helpers — shared utilities for renderable builders.
 *
 *  Centralises patterns that PBR and Standard pipelines previously duplicated:
 *  scene BGL creation, mesh world-matrix updates, and pipeline descriptors. */

import type { EngineContextInternal } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";

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
    label: string;
    engine: EngineContextInternal;
    bgls: GPUBindGroupLayout[];
    vertModule: GPUShaderModule;
    fragModule: GPUShaderModule;
    vertexBuffers: GPUVertexBufferLayout[];
    format: GPUTextureFormat;
    /** Depth-stencil format. Default: `"depth24plus-stencil8"` (matches the engine's default RT). */
    depthStencilFormat?: GPUTextureFormat;
    msaaSamples: number;
    depthWriteEnabled?: boolean;
    cullMode?: GPUCullMode;
    blend?: GPUBlendState;
    /** When true, build with `frontFace: "cw"` (offscreen RTT with Y-flipped projection). */
    flipY?: boolean;
}

/** Build a render pipeline descriptor with the engine's default state:
 *  depth24plus-stencil8, less-equal, triangle-list, ccw front face (cw if flipY). */
export function createDefaultPipelineDescriptor(opts: PipelineDescriptorOpts): GPURenderPipelineDescriptor {
    const target: GPUColorTargetState = opts.blend ? { format: opts.format, blend: opts.blend } : { format: opts.format };
    return {
        label: opts.label,
        layout: opts.engine.device.createPipelineLayout({ bindGroupLayouts: opts.bgls }),
        vertex: { module: opts.vertModule, entryPoint: "main", buffers: opts.vertexBuffers },
        fragment: { module: opts.fragModule, entryPoint: "main", targets: [target] },
        depthStencil: { format: opts.depthStencilFormat ?? "depth24plus-stencil8", depthCompare: "less-equal", depthWriteEnabled: opts.depthWriteEnabled ?? true },
        multisample: { count: opts.msaaSamples },
        primitive: { topology: "triangle-list", cullMode: opts.cullMode ?? "back", frontFace: opts.flipY ? "cw" : "ccw" },
    };
}
