import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { NodeMaterial } from "../../../packages/babylon-lite/src/material/node/node-material";
import { buildNodeMeshRenderables } from "../../../packages/babylon-lite/src/material/node/node-renderable";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import { syncThinInstanceForDraw, syncThinInstanceGpuData } from "../../../packages/babylon-lite/src/mesh/thin-instance-gpu";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { disposeGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement";

function buildFixture(transparent: boolean, meshCount = 1, withNodeUbo = false) {
    const matrixBuffer = { size: 128, destroy: vi.fn() } as unknown as GPUBuffer;
    const indirectWrites: number[][] = [];
    const writeBuffer = vi.fn((buffer: GPUBuffer, _offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
        if (buffer.size === 20) {
            indirectWrites.push(Array.from(new Uint32Array(data, dataOffset, (size ?? data.byteLength) / 4)));
        }
    });
    const buffers: Array<GPUBuffer & { label?: string; destroy: ReturnType<typeof vi.fn> }> = [];
    const engine = {
        format: "bgra8unorm",
        _retirements: null,
        _device: {
            createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
                const buffer = { size: descriptor.size, label: descriptor.label, destroy: vi.fn() } as unknown as GPUBuffer & {
                    label?: string;
                    destroy: ReturnType<typeof vi.fn>;
                };
                buffers.push(buffer);
                return buffer;
            }),
            createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
            queue: { writeBuffer },
        },
    } as unknown as EngineContext;
    const scene = {
        surface: { engine },
        lights: [],
        meshes: [],
        _renderables: [],
        _materialSwapQueue: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _renderableVersion: 0,
        _disposables: [],
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
    const material = {
        _buildGroup: () => {
            throw new Error("not used");
        },
        _compile: {
            _meshBGL: {},
            _nodeUboBinding: withNodeUbo ? 1 : null,
            _nodeUboSpec: withNodeUbo ? { _totalBytes: 16, _offsets: new Map(), _structBody: "" } : null,
            _meshUboFloats: 20,
            _usesMeshAttributeFlags: false,
            _textureBindings: [],
            _envBindings: null,
            _shadowBindings: [],
            _esmShadowParamsBinding: null,
            _pipeline: {},
            _pipelineForMesh: () => ({}),
        },
        _renderFeatures: null,
        _vertexAttrNames: ["position", "world0", "world1", "world2", "world3"],
        _needsAlphaBlending: transparent,
        _syncThinInstances: syncThinInstanceGpuData,
        _syncThinInstanceForDraw: syncThinInstanceForDraw,
        _uboDirty: false,
        _uniformValues: new Map(),
    } as unknown as NodeMaterial;
    const meshes: Mesh[] = [];
    const thinInstances: ThinInstanceData[] = [];
    for (let i = 0; i < meshCount; i++) {
        const ti = {
            matrices: new Float32Array(32),
            count: 2,
            _capacity: 2,
            _version: 1,
            _gpuBuffer: matrixBuffer,
            _gpuVersion: 1,
            _dirtyMin: 2,
            _dirtyMax: 0,
            _colorVersion: 0,
            _colorDirtyMin: 0,
            _colorDirtyMax: 0,
            _colorGpuBuffer: null,
            _colorGpuBufferStorage: false,
            _colorGpuVersion: 0,
            _gpuCullingEnabled: false,
        } satisfies ThinInstanceData;
        thinInstances.push(ti);
        meshes.push({
            material,
            thinInstances: ti,
            visible: true,
            parent: null,
            worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            worldMatrixVersion: 1,
            receiveShadows: false,
            _gpu: {
                indexCount: 3,
                _baseVertex: 0,
                indexBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
                indexFormat: "uint16",
                positionBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
                normalBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
                uvBuffer: { destroy: vi.fn() } as unknown as GPUBuffer,
                vertexBuffers: new Map([["position", {} as GPUBuffer]]),
            },
        } as unknown as Mesh);
    }
    const output = buildNodeMeshRenderables(scene, meshes);
    scene.meshes.push(...meshes);
    scene._renderables.push(...output.renderables);
    const group = meshes as typeof meshes & { o?: typeof output.renderables };
    group.o = output.renderables;
    scene._groups.set(material._buildGroup as never, group as never);
    const renderable = output.renderables[0]!;
    return {
        binding: renderable.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 }),
        matrixBuffer,
        thinInstances: thinInstances[0]!,
        allThinInstances: thinInstances,
        writeBuffer,
        indirectWrites,
        buffers,
        engine,
        material,
        meshes,
        renderable,
        scene,
        group,
    };
}

function fakePass() {
    return {
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        setBindGroup: vi.fn(),
        drawIndexed: vi.fn(),
        drawIndexedIndirect: vi.fn(),
    };
}

describe.each([
    ["opaque", false],
    ["transparent", true],
] as const)("node-material %s thin-instance updates", (_name, transparent) => {
    it("uploads a changed matrix once per version without replacing the bound buffer", () => {
        const { binding, matrixBuffer, thinInstances, writeBuffer } = buildFixture(transparent);
        const writesAfterBuild = writeBuffer.mock.calls.length;

        binding.update!({ targetWidth: 1, targetHeight: 1 });
        expect(writeBuffer).toHaveBeenCalledTimes(writesAfterBuild);

        thinInstances.matrices[12] = 2;
        thinInstances._version++;
        thinInstances._dirtyMin = 0;
        thinInstances._dirtyMax = 1;
        binding.update!({ targetWidth: 1, targetHeight: 1 });

        expect(writeBuffer).toHaveBeenCalledTimes(writesAfterBuild + 1);
        expect(thinInstances._gpuBuffer).toBe(matrixBuffer);
        expect(thinInstances._gpuVersion).toBe(thinInstances._version);

        binding.update!({ targetWidth: 1, targetHeight: 1 });
        expect(writeBuffer).toHaveBeenCalledTimes(writesAfterBuild + 1);
    });

    it("promotes cached draws to stable indirect arguments for 2 -> 0 -> 1 count changes", () => {
        const { binding, indirectWrites, matrixBuffer, thinInstances } = buildFixture(transparent);
        const pass = fakePass();

        binding.update!({ targetWidth: 1, targetHeight: 1 });
        binding.draw(pass as never, {} as EngineContext);
        expect(pass.drawIndexed).toHaveBeenLastCalledWith(3, 2, 0, 0);
        expect(thinInstances._drawArgsBuffer).toBeUndefined();

        thinInstances.count = 0;
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        const indirect = thinInstances._drawArgsBuffer;
        expect(indirect).toBeTruthy();
        binding.draw(pass as never, {} as EngineContext);
        expect(pass.drawIndexedIndirect).toHaveBeenLastCalledWith(indirect, 0);

        thinInstances.count = 1;
        binding.update!({ targetWidth: 1, targetHeight: 1 });
        binding.draw(pass as never, {} as EngineContext);
        expect(thinInstances._drawArgsBuffer).toBe(indirect);
        expect(thinInstances._gpuBuffer).toBe(matrixBuffer);
        expect(indirectWrites).toEqual([
            [3, 0, 0, 0, 0],
            [3, 1, 0, 0, 0],
        ]);
    });
});

describe("node-material packet ownership", () => {
    it("detaches one opaque sibling synchronously and retires only its packet resources", () => {
        const { buffers, engine, group, meshes, renderable, scene } = buildFixture(false, 2, true);
        const binding = renderable.bind(engine, { _colorFormat: "bgra8unorm", _depthStencilFormat: "depth32float", _sampleCount: 1 });
        const pass = fakePass();
        const nodeUbo = buffers.find((buffer) => buffer.label === "node-ubo")!;
        const meshUbos = buffers.filter((buffer) => buffer.label === "node-mesh-ubo");
        const [firstMesh, secondMesh] = meshes;

        binding.draw(pass as never, engine);
        expect(pass.drawIndexed).toHaveBeenCalledTimes(2);

        pass.drawIndexed.mockClear();
        removeFromScene(scene, firstMesh!);
        binding.draw(pass as never, engine);

        expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
        expect(scene._renderables).toContain(renderable);
        expect(meshUbos[0]!.destroy).not.toHaveBeenCalled();
        expect(nodeUbo.destroy).not.toHaveBeenCalled();

        disposeGpuResourceRetirements(engine);
        pass.drawIndexed.mockClear();
        binding.draw(pass as never, engine);
        expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
        expect(scene._renderables).toContain(renderable);
        expect(group.o).toContain(renderable);
        expect(meshUbos[0]!.destroy).toHaveBeenCalledOnce();
        expect(meshUbos[1]!.destroy).not.toHaveBeenCalled();
        expect(nodeUbo.destroy).not.toHaveBeenCalled();

        removeFromScene(scene, firstMesh!);
        disposeGpuResourceRetirements(engine);
        expect(meshUbos[0]!.destroy).toHaveBeenCalledOnce();
        expect(scene._renderables).toContain(renderable);
        expect(group.o).toContain(renderable);

        pass.drawIndexed.mockClear();
        removeFromScene(scene, secondMesh!);
        binding.draw(pass as never, engine);
        expect(pass.drawIndexed).not.toHaveBeenCalled();
        expect(scene._renderables).not.toContain(renderable);
        expect(group.o).not.toContain(renderable);

        disposeGpuResourceRetirements(engine);
        expect(meshUbos[0]!.destroy).toHaveBeenCalledOnce();
        expect(meshUbos[1]!.destroy).toHaveBeenCalledOnce();
        expect(nodeUbo.destroy).toHaveBeenCalledOnce();
    });

    it("does not draw a hidden packet in opaque or transparent output", () => {
        for (const transparent of [false, true]) {
            const { binding, engine, meshes } = buildFixture(transparent);
            const pass = fakePass();
            meshes[0]!.visible = false;
            binding.draw(pass as never, engine);
            expect(pass.drawIndexed).not.toHaveBeenCalled();
            expect(pass.drawIndexedIndirect).not.toHaveBeenCalled();
        }
    });
});
