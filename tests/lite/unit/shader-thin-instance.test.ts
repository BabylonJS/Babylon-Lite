import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTargetSignature } from "../../../packages/babylon-lite/src/engine/render-target";
import type { ShaderMaterial } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import type { ShaderPacket } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { buildShaderRenderablesWithInstancing } from "../../../packages/babylon-lite/src/material/shader/shader-thin-instance";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { UboSpec } from "../../../packages/babylon-lite/src/shader/fragment-types";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & {
    GPUBufferUsage?: { VERTEX: number; COPY_DST: number; STORAGE: number; INDIRECT: number };
};
gpuGlobals.GPUBufferUsage ??= { VERTEX: 0x20, COPY_DST: 0x8, STORAGE: 0x80, INDIRECT: 0x100 } as unknown as GPUBufferUsage;

function makeThinInstances(): ThinInstanceData {
    return {
        matrices: new Float32Array(16),
        count: 0,
        _capacity: 1,
        _version: 1,
        _gpuBuffer: null,
        _gpuBufferStorage: false,
        _gpuVersion: 0,
        _dirtyMin: 0,
        _dirtyMax: 0,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

describe("ShaderMaterial thin instances", () => {
    it("marks material-override packets as auxiliary", () => {
        const engine = {
            _device: {
                createBuffer: vi.fn(),
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const material = {
            attributes: ["position"],
            needAlphaBlending: false,
        } as unknown as ShaderMaterial;
        const override = {
            attributes: ["position"],
            needAlphaBlending: false,
        } as unknown as ShaderMaterial;
        const mesh = {
            material,
            thinInstances: makeThinInstances(),
            _gpu: { positionBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, indexFormat: "uint16" },
            worldMatrix: new Float32Array(16),
        } as unknown as Mesh;
        const scene = { surface: { engine } } as unknown as SceneContext;
        const systemSpec = { _totalBytes: 16, _offsets: new Map(), _structBody: "" };
        const packet = {
            mesh,
            systemUBO: {} as GPUBuffer,
            systemData: new Float32Array(4),
            _bindGroup: {} as GPUBindGroup,
            _lastResourceVersion: 0,
            _boundTextures: [],
            _boundStorageBuffers: [],
        } as ShaderPacket;
        const createPacket = vi.fn((_scene: SceneContext, _material: ShaderMaterial, _systemSpec: UboSpec, _mesh: Mesh, _aux?: boolean): ShaderPacket => packet);
        const result = buildShaderRenderablesWithInstancing(
            scene,
            [mesh],
            () => {
                throw new Error("plain builder should not run");
            },
            createPacket,
            vi.fn(),
            vi.fn(),
            () => mesh._gpu.positionBuffer,
            () => ({}) as GPURenderPipeline,
            () => ({
                group1BGL: {} as GPUBindGroupLayout,
                systemSpec,
                customSpec: null,
                vertexBuffers: [],
                pipelines: new Map(),
                _pipelineLayout: {} as GPUPipelineLayout,
            })
        );

        result.rebuildSingle(scene, mesh, override);

        expect(createPacket).toHaveBeenLastCalledWith(scene, override, systemSpec, mesh, true);
    });

    it("promotes a cached direct draw to indirect after the instance count changes", () => {
        const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({ size: descriptor.size, destroy: vi.fn() }) as unknown as GPUBuffer);
        const engine = {
            _device: {
                createBuffer,
                queue: { writeBuffer: vi.fn() },
            },
        } as unknown as EngineContext;
        const material = {
            attributes: ["position"],
            needAlphaBlending: false,
        } as unknown as ShaderMaterial;
        const positionBuffer = {} as GPUBuffer;
        const mesh = {
            material,
            thinInstances: makeThinInstances(),
            _gpu: { positionBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, indexFormat: "uint16" },
            worldMatrix: new Float32Array(16),
        } as unknown as Mesh;
        const scene = { surface: { engine } } as unknown as SceneContext;
        const systemSpec = { _totalBytes: 16, _offsets: new Map(), _structBody: "" };
        const packet = {
            mesh,
            systemUBO: {} as GPUBuffer,
            systemData: new Float32Array(4),
            _bindGroup: {} as GPUBindGroup,
            _lastResourceVersion: 0,
            _boundTextures: [],
            _boundStorageBuffers: [],
        } as ShaderPacket;
        const result = buildShaderRenderablesWithInstancing(
            scene,
            [mesh],
            () => {
                throw new Error("plain builder should not run");
            },
            () => packet,
            vi.fn(),
            vi.fn(),
            () => positionBuffer,
            () => ({}) as GPURenderPipeline,
            () => ({
                group1BGL: {} as GPUBindGroupLayout,
                systemSpec,
                customSpec: null,
                vertexBuffers: [],
                pipelines: new Map(),
                _pipelineLayout: {} as GPUPipelineLayout,
            })
        );
        const binding = result.renderables[0]!.bind(engine, {} as RenderTargetSignature);
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        const drawIndexedIndirect = vi.fn();
        const drawIndexed = vi.fn();
        const pass = {
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            setBindGroup: vi.fn(),
            drawIndexed,
            drawIndexedIndirect,
        } as unknown as GPURenderBundleEncoder;

        expect(binding.draw(pass, engine)).toBe(1);
        expect(drawIndexed).toHaveBeenCalledWith(3, 0);
        expect(drawIndexedIndirect).not.toHaveBeenCalled();

        mesh.thinInstances!.count = 1;
        mesh.thinInstances!._version++;
        mesh.thinInstances!._dirtyMax = 1;
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        expect(binding.draw(pass, engine)).toBe(1);
        expect(drawIndexedIndirect).toHaveBeenCalledTimes(1);
    });
});
