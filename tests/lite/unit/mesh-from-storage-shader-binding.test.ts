import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createMeshFromStorageBuffer } from "../../../packages/babylon-lite/src/mesh/mesh-from-storage";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { createStorageBuffer } from "../../../packages/babylon-lite/src/resource/storage-buffer";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";

const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;

// position (vec3, 12B, padded to 16) + color (vec4, 16B) = 32B/vertex.
const ATTR_STRIDE = 32;
const VERTS = 4;
const INDICES = new Uint32Array([0, 1, 2, 2, 1, 3]);

function makeEngine() {
    const buffers: { label?: string; destroy: ReturnType<typeof vi.fn> }[] = [];
    const createBuffer = vi.fn((d: GPUBufferDescriptor) => {
        const backing = new ArrayBuffer(Number(d.size));
        const buf = {
            label: d.label,
            size: Number(d.size),
            getMappedRange: () => backing,
            unmap: vi.fn(),
            destroy: vi.fn(),
        };
        buffers.push(buf as unknown as (typeof buffers)[number]);
        return buf as unknown as GPUBuffer;
    });
    const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
    const device = {
        createBuffer,
        createBindGroupLayout: vi.fn((d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout),
        createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup),
        createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule),
        createRenderPipeline,
        queue: { writeBuffer: vi.fn() },
        limits: {},
    } as unknown as GPUDevice;
    const engine = { _device: device, canvas: { width: 64, height: 64 } } as unknown as EngineContext;
    return { engine, buffers };
}

/** Records `setVertexBuffer`/`setIndexBuffer`/`drawIndexed` calls made by the ShaderMaterial
 *  draw closure, without needing a real GPURenderPassEncoder. */
function makeMockPass() {
    return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        drawIndexed: vi.fn(),
    } as unknown as GPURenderPassEncoder & {
        setVertexBuffer: ReturnType<typeof vi.fn>;
        drawIndexed: ReturnType<typeof vi.fn>;
    };
}

describe("ShaderMaterial draw binding — slab mesh with attributeOffsets.color", () => {
    it("binds the borrowed slab buffer for `color`, not a freshly-allocated zero-fill buffer", () => {
        const { engine, buffers } = makeEngine();
        const slab = createStorageBuffer(engine, VERTS * ATTR_STRIDE, { writable: true, vertex: true });

        const mesh = createMeshFromStorageBuffer(engine, "slab-chunk", {
            storage: slab,
            indices: INDICES,
            vertexCount: VERTS,
            arrayStride: ATTR_STRIDE,
            attributeOffsets: { position: 0, color: 16 },
        });

        const material = createShaderMaterial({
            vertexSource: "@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1) + vec4f(input.color, 0); }",
            fragmentSource: "@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }",
            attributes: ["position", "color"],
        });
        mesh.material = material;

        const scene = {
            surface: { engine },
            camera: null,
            _meshDisposables: new Map(),
            _meshAuxDisposables: new Map(),
        } as unknown as SceneContext;

        const result = buildShaderMaterialRenderables(scene, [mesh]);
        expect(result.renderables).toHaveLength(1);

        const buffersCreatedBeforeDraw = buffers.length;
        const binding = result.renderables[0]!.bind(engine, signature);
        const pass = makeMockPass();
        binding.draw(pass, engine);

        // location 0 = position, location 1 = color (material.attributes order).
        expect(pass.setVertexBuffer).toHaveBeenCalledWith(0, mesh._gpu.positionBuffer);
        expect(pass.setVertexBuffer).toHaveBeenCalledWith(1, mesh._gpu.colorBuffer);
        // The slab handle IS the position buffer (both borrow the same allocation).
        expect(mesh._gpu.colorBuffer).toBe(mesh._gpu.positionBuffer);

        // No new "shader-zero-color" fallback buffer was allocated for the draw.
        const newBuffers = buffers.slice(buffersCreatedBeforeDraw);
        expect(newBuffers.some((b) => b.label?.startsWith("shader-zero"))).toBe(false);
    });
});
