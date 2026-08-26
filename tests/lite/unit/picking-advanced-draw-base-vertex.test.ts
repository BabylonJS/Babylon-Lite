import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";

const fakePipeline = { getBindGroupLayout: vi.fn(() => ({}) as GPUBindGroupLayout) } as unknown as GPURenderPipeline;

vi.mock("../../../packages/babylon-lite/src/picking/picking-advanced-pipeline.js", () => ({
    getPickingPipelineSet: vi.fn(() => ({ regularPipeline: fakePipeline, thinInstancePipeline: fakePipeline, discardBGL: null, detailed: false, _vertexProjection: null })),
    getPickingRegularPipeline: vi.fn(() => fakePipeline),
    getPickingThinInstancePipeline: vi.fn(() => fakePipeline),
    getPickVertexDataBinding: vi.fn(() => null),
}));

import { prepareAdvancedDraw } from "../../../packages/babylon-lite/src/picking/picking-advanced-draw";

function makeEngine(): EngineContext {
    const device = {
        createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ label: d.label, size: Number(d.size), destroy: vi.fn() }) as unknown as GPUBuffer),
        createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => d as unknown as GPUBindGroup),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    return { _device: device } as unknown as EngineContext;
}

function makeMockPass() {
    return {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        setIndexBuffer: vi.fn(),
        drawIndexed: vi.fn(),
    } as unknown as GPURenderPassEncoder & { drawIndexed: ReturnType<typeof vi.fn> };
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeGpu(baseVertex: number | undefined): MeshGPU {
    return {
        positionBuffer: {} as GPUBuffer,
        normalBuffer: {} as GPUBuffer,
        uvBuffer: {} as GPUBuffer,
        indexBuffer: {} as GPUBuffer,
        indexCount: 12,
        indexFormat: "uint32",
        _baseVertex: baseVertex,
    } as MeshGPU;
}

function makeMesh(baseVertex: number | undefined, thinInstances?: ThinInstanceData): Mesh {
    return {
        worldMatrix: IDENTITY,
        _gpu: makeGpu(baseVertex),
        thinInstances: thinInstances ?? null,
    } as unknown as Mesh;
}

describe("prepareAdvancedDraw — baseVertex threading (slab slots pick their own geometry)", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("passes a shared slab slot's non-zero _baseVertex to the regular (non-thin-instanced) drawIndexed call", async () => {
        const engine = makeEngine();
        const mesh = makeMesh(96);
        const built = await prepareAdvancedDraw(engine, [{ mesh, ignore: null }]);
        const pass = makeMockPass();

        const result = built.draw(pass, {} as GPUBindGroup, 1, null, false, null, [], null, null);

        expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
        expect(pass.drawIndexed).toHaveBeenCalledWith(12, 1, 0, 96);
        expect(result.ranges).toHaveLength(1);
        expect(result.ranges[0]!.thin).toBe(false);
    });

    it("preserves the existing draw for a tight (non-slab) mesh whose _baseVertex is undefined", async () => {
        const engine = makeEngine();
        const mesh = makeMesh(undefined);
        const built = await prepareAdvancedDraw(engine, [{ mesh, ignore: null }]);
        const pass = makeMockPass();

        built.draw(pass, {} as GPUBindGroup, 1, null, false, null, [], null, null);

        // undefined baseVertex behaves as 0 — byte-identical to the pre-fix call.
        expect(pass.drawIndexed).toHaveBeenCalledWith(12, 1, 0, 0);
    });

    it("passes a shared slab slot's non-zero _baseVertex to the thin-instanced drawIndexed call", async () => {
        const engine = makeEngine();
        const thinInstances = { count: 5, _gpuBuffer: {} as GPUBuffer, _version: 1 } as unknown as ThinInstanceData;
        const mesh = makeMesh(64, thinInstances);
        const built = await prepareAdvancedDraw(engine, [{ mesh, ignore: null }]);
        const pass = makeMockPass();

        const result = built.draw(pass, {} as GPUBindGroup, 1, null, false, null, [], null, null);

        expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
        expect(pass.drawIndexed).toHaveBeenCalledWith(12, 5, 0, 64);
        expect(result.ranges).toHaveLength(1);
        expect(result.ranges[0]!.thin).toBe(true);
    });
});
