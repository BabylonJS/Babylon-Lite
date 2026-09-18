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
import type { MeshRebuildResources, Renderable } from "../../../packages/babylon-lite/src/render/renderable";

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
    it("captures generic packed layouts once and shares them with async registration and every target bind", () => {
        const engine = { _device: {} } as EngineContext;
        const material = { attributes: ["position"], needAlphaBlending: false } as unknown as ShaderMaterial;
        const mesh = {
            material,
            thinInstances: makeThinInstances(),
            worldMatrix: new Float32Array(16),
            _gpu: {
                positionBuffer: {} as GPUBuffer,
                indexBuffer: {} as GPUBuffer,
                indexCount: 3,
                indexFormat: "uint16",
                _vbLayout: { position: { _stride: 20, _offset: 4 } },
                _vbKey: "packed",
            },
        } as unknown as Mesh;
        const scene = { surface: { engine } } as SceneContext;
        const systemSpec = { _totalBytes: 16, _offsets: new Map(), _structBody: "" };
        const bindings = {
            group1BGL: {} as GPUBindGroupLayout,
            systemSpec,
            customSpec: null,
            vertexBuffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as const }] }],
            pipelines: new Map(),
            _pipelineLayout: {} as GPUPipelineLayout,
        };
        const packet = {
            mesh,
            systemUBO: {} as GPUBuffer,
            systemData: new Float32Array(4),
            _bindGroup: {} as GPUBindGroup,
            _lastResourceVersion: 0,
            _boundTextures: [],
        } as ShaderPacket;
        const getPipeline = vi.fn((..._args: Parameters<Parameters<typeof buildShaderRenderablesWithInstancing>[7]>): GPURenderPipeline => ({}) as GPURenderPipeline);
        const register = vi.fn();
        const built = buildShaderRenderablesWithInstancing(
            scene,
            [mesh],
            () => {
                throw new Error("No plain meshes");
            },
            () => packet,
            vi.fn(),
            vi.fn(),
            () => mesh._gpu.positionBuffer,
            getPipeline,
            () => bindings,
            undefined,
            undefined,
            undefined,
            register
        );
        built.renderables[0]!.bind(engine, { _colorFormat: "rgba8unorm", _sampleCount: 1 });
        built.renderables[0]!.bind(engine, { _colorFormat: "bgra8unorm", _sampleCount: 1 });
        const layouts = getPipeline.mock.calls[0]![5]!;
        expect(getPipeline.mock.calls[0]![4]).toBe("0packed");
        expect(getPipeline.mock.calls[1]![5]).toBe(layouts);
        expect(layouts[0]).toEqual({ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 4, format: "float32x3" }] });
        expect(layouts[1]!.attributes).toEqual([
            { shaderLocation: 1, offset: 0, format: "float32x4" },
            { shaderLocation: 2, offset: 16, format: "float32x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
            { shaderLocation: 4, offset: 48, format: "float32x4" },
        ]);
        expect(register).toHaveBeenCalledWith(mesh, material, false, { _key: "packed", _vbs: [layouts[0]] });
    });

    it("forwards explicit ownership for material-override packets", () => {
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
        } as ShaderPacket;
        const createPacket = vi.fn((_scene: SceneContext, _material: ShaderMaterial, _systemSpec: UboSpec, _mesh: Mesh, _resources?: MeshRebuildResources): ShaderPacket => packet);
        const plainRenderable = { order: 100, isTransparent: false } as Renderable;
        const plainRebuild = vi.fn(() => plainRenderable);
        const buildPlain = vi.fn((_scene: SceneContext, _meshes: Mesh[]) => ({
            renderables: [],
            rebuildSingle: plainRebuild,
        }));
        const result = buildShaderRenderablesWithInstancing(
            scene,
            [mesh],
            buildPlain,
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

        const resources: MeshRebuildResources = { _lifetimeDisposers: [] };
        result.rebuildSingle(scene, mesh, override, resources);

        expect(createPacket).toHaveBeenLastCalledWith(scene, override, systemSpec, mesh, resources);

        mesh.thinInstances = undefined;
        const plainResources: MeshRebuildResources = { _lifetimeDisposers: [] };
        expect(result.rebuildSingle(scene, mesh, override, plainResources)).toBe(plainRenderable);
        expect(buildPlain).toHaveBeenLastCalledWith(scene, []);
        expect(plainRebuild).toHaveBeenLastCalledWith(scene, mesh, override, plainResources);
    });

    it("lets a color-independent material override share matrices without binding the mesh color stream", () => {
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
            _tic: false,
        } as unknown as ShaderMaterial;
        const ti = makeThinInstances();
        ti.count = 1;
        ti.colors = new Float32Array([1, 0, 0, 1]);
        ti._colorVersion = 1;
        ti._gpuBuffer = { size: 64 } as GPUBuffer;
        ti._gpuVersion = ti._version;
        const positionBuffer = {} as GPUBuffer;
        const mesh = {
            material,
            thinInstances: ti,
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
        } as ShaderPacket;
        const getPipeline = vi.fn((..._args: Parameters<Parameters<typeof buildShaderRenderablesWithInstancing>[7]>): GPURenderPipeline => ({}) as GPURenderPipeline);
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
            getPipeline,
            () => ({
                group1BGL: {} as GPUBindGroupLayout,
                systemSpec,
                customSpec: null,
                vertexBuffers: [],
                pipelines: new Map(),
                _pipelineLayout: {} as GPUPipelineLayout,
            })
        );
        const overrideRenderable = result.rebuildSingle(scene, mesh, override);
        const binding = overrideRenderable.bind(engine, {} as RenderTargetSignature);
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        const pass = {
            setVertexBuffer: vi.fn(),
            setIndexBuffer: vi.fn(),
            setBindGroup: vi.fn(),
            drawIndexed: vi.fn(),
        } as unknown as GPURenderBundleEncoder;

        binding.draw(pass, engine);

        expect(getPipeline.mock.calls[0]![4]).toBe("0");
        expect(getPipeline.mock.calls[0]![5]).toHaveLength(1);
        expect(getPipeline.mock.calls[0]![6]).not.toContain("instanceColor");
        expect(pass.setVertexBuffer).toHaveBeenCalledTimes(2);
        expect(ti._colorGpuVersion).toBe(0);
        expect(engine._device.queue.writeBuffer).not.toHaveBeenCalled();
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
        // `baseVertex` is now passed through so a slab-backed mesh draws from its own slot;
        // `undefined` is WebIDL's default for the optional argument, so this is the same call.
        expect(drawIndexed).toHaveBeenCalledWith(3, 0, 0, undefined);
        expect(drawIndexedIndirect).not.toHaveBeenCalled();

        mesh.thinInstances!.count = 1;
        mesh.thinInstances!._version++;
        mesh.thinInstances!._dirtyMax = 1;
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        expect(binding.draw(pass, engine)).toBe(1);
        expect(drawIndexedIndirect).toHaveBeenCalledTimes(1);
    });
});
