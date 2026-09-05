import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import { createShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import { buildShaderMaterialRenderables } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { _enableShaderVb } from "../../../packages/babylon-lite/src/material/shader/shader-vb";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

// Installs the opt-in per-mesh vertex-packing hooks (`_forMesh`) that resolve
// `MeshGPU._vbLayout` into the pipeline's per-attribute GPUVertexBufferLayout.
_enableShaderVb();

const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 } as RenderTargetSignature;

/**
 * Scene 286 exercises COLOR_0 from a genuinely interleaved glTF bufferView, but the loader
 * (`gltf-interleave.ts`'s `resolveColorVec4`) always materializes COLOR_0 into its own tight
 * buffer before the ShaderMaterial pipeline ever sees it — so no real loader path currently
 * produces a non-zero `MeshGPU._vbLayout._c._offset`. This test exercises the vertex-layout
 * resolution directly against a synthetic `_vbLayout` to prove `_forMesh` genuinely honours a
 * non-zero per-attribute color offset, independent of whether any loader happens to produce one.
 */
describe("ShaderMaterial vertex layout — synthetic non-zero COLOR_0 offset", () => {
    it("resolves a non-zero interleaved color offset/stride into the pipeline's vertex buffer layout", () => {
        const createRenderPipeline = vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor as unknown as GPURenderPipeline);
        const device = {
            createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ size: d.size, destroy: vi.fn() }) as unknown as GPUBuffer),
            createBindGroupLayout: vi.fn((d: GPUBindGroupLayoutDescriptor) => d as unknown as GPUBindGroupLayout),
            createPipelineLayout: vi.fn((d: GPUPipelineLayoutDescriptor) => d as unknown as GPUPipelineLayout),
            createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup),
            createShaderModule: vi.fn((d: GPUShaderModuleDescriptor) => d as unknown as GPUShaderModule),
            createRenderPipeline,
            queue: { writeBuffer: vi.fn() },
        } as unknown as GPUDevice;
        const engine = { _device: device, canvas: { width: 64, height: 64 } } as unknown as EngineContext;

        const material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn mainVertex(input: VertexInput) -> @builtin(position) vec4f { return vec4f(input.position, 1) + vec4f(input.color, 0); }`,
            fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position", "color"],
        });

        // A synthetic interleaved layout: POSITION tight (own buffer/offset), COLOR_0 packed
        // into a shared byteStride-40 buffer starting at a non-zero byte offset (24) — the
        // same shape a genuinely interleaved bufferView with COLOR_0 after POSITION+NORMAL
        // would produce, which no current loader path feeds into the ShaderMaterial pipeline.
        const mesh = initMeshTransform({
            name: "synthetic-interleaved-color",
            children: [],
            material,
            receiveShadows: false,
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                normalBuffer: {} as GPUBuffer,
                uvBuffer: {} as GPUBuffer,
                colorBuffer: {} as GPUBuffer,
                hasColor: true,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint32",
                _vbLayout: { _c: { _stride: 40, _offset: 24 } },
                _vbKey: "synthetic-color-offset",
            },
        });

        const scene = {
            surface: { engine },
            camera: null,
            _meshDisposables: new Map(),
            _meshAuxDisposables: new Map(),
        } as unknown as SceneContext;

        const secondMesh = initMeshTransform({
            ...mesh,
            name: "synthetic-interleaved-color-2",
            children: [],
            _gpu: {
                ...mesh._gpu,
                _vbLayout: { _c: { _stride: 48, _offset: 28 } },
                _vbKey: "synthetic-color-offset-2",
            },
        });
        const result = buildShaderMaterialRenderables(scene, [mesh, secondMesh]);
        expect(result.renderables).toHaveLength(2);
        result.renderables[0]!.bind(engine, signature);

        expect(createRenderPipeline).toHaveBeenCalledTimes(1);
        const vertexBuffers = createRenderPipeline.mock.calls[0]![0]!.vertex.buffers as readonly GPUVertexBufferLayout[];
        expect(vertexBuffers).toHaveLength(2);

        const positionLayout = vertexBuffers[0]!;
        expect(positionLayout.attributes[0]!.offset).toBe(0);

        const colorLayout = vertexBuffers[1]!;
        expect(colorLayout.arrayStride).toBe(40);
        expect(colorLayout.attributes[0]!.offset).toBe(24);
    });
});
