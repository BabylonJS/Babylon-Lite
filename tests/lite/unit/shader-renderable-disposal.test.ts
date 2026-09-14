import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { _enableShaderVb } from "../../../packages/babylon-lite/src/material/shader/shader-vb";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

// Installs the (otherwise opt-in) per-mesh vertex-packing hooks, so `bind()` takes the
// `_vbRender._forMesh(...)` branch that dereferences `packets[0]` — the exact path that
// crashed when every packet of a merged renderable had been disposed. Without this, `_vbRender`
// stays null and `_vbRender?._forMesh(...)` short-circuits before `packets[0]` is ever read,
// masking the bug this test exists to catch.
_enableShaderVb();

function createFixture(): { engine: EngineContext; scene: SceneContext; meshes: [Mesh, Mesh] } {
    const device = {
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor as unknown as GPUShaderModule),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const engine = {
        _device: device,
        canvas: { width: 64, height: 64 },
    } as unknown as EngineContext;
    const material = createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
        attributes: ["position"],
    });
    const createMesh = (name: string): Mesh =>
        initMeshTransform({
            name,
            children: [],
            material,
            receiveShadows: false,
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                uvBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
            },
        });
    const scene = {
        surface: { engine },
        camera: null,
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
    } as unknown as SceneContext;

    return { engine, scene, meshes: [createMesh("a"), createMesh("b")] };
}

const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;

describe("ShaderMaterial merged-opaque renderable — disposal safety", () => {
    it("stays safe to bind/update/draw after every packet has been disposed", () => {
        const { engine, scene, meshes } = createFixture();
        // Both meshes share one material, so buildShaderMaterialRenderables merges them into ONE
        // opaque renderable whose closure-captured `packets` array is shared (spliced) by disposal —
        // exactly the "combined (multi-mesh) renderable" case documented on ShaderPacket._owner.
        const result = buildShaderMaterialRenderables(scene, meshes);
        expect(result.renderables).toHaveLength(1);
        const renderable = result.renderables[0]!;

        // Sanity: binding/drawing works normally before disposal.
        const pass = { setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), setBindGroup: vi.fn(), drawIndexed: vi.fn() } as unknown as GPURenderPassEncoder;
        const before = renderable.bind(engine, signature);
        expect(before.draw(pass, engine)).toBe(2);

        // Dispose every packet — e.g. both meshes removed from the scene in the same frame —
        // which splices `packets` down to an empty array via ShaderPacket._owner.
        for (const mesh of meshes) {
            const disposers = scene._meshDisposables.get(mesh) ?? [];
            for (const dispose of disposers) {
                dispose();
            }
        }

        // bind() must not throw dereferencing packets[0] on an empty packet list.
        let binding: ReturnType<typeof renderable.bind> | undefined;
        expect(() => {
            binding = renderable.bind(engine, signature);
        }).not.toThrow();
        expect(binding!.pipeline).toBeDefined();

        // update()/draw() must remain no-ops rather than touching destroyed GPU resources.
        expect(() => binding!.update?.({ targetWidth: 64, targetHeight: 64 })).not.toThrow();
        expect(binding!.draw(pass, engine)).toBe(0);
    });
});
