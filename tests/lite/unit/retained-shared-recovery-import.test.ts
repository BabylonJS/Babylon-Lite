import { expect, it, vi } from "vitest";
import { _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { retainMeshResources, releaseMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

const barrier = vi.hoisted(() => {
    let entered!: () => void;
    let resume!: () => void;
    return {
        entered: new Promise<void>((resolve) => (entered = resolve)),
        gate: new Promise<void>((resolve) => (resume = resolve)),
        enter: () => entered(),
        resume: () => resume(),
    };
});
vi.mock("../../../packages/babylon-lite/src/mesh/shared-mesh-recovery.js", async (load) => {
    barrier.enter();
    await barrier.gate;
    return load();
});

it("does not upload or claim shared replacement geometry for a lease retired during the recovery import", async () => {
    const buffer = (): GPUBuffer => ({ destroy: vi.fn() }) as unknown as GPUBuffer;
    const gpu: MeshGPU = {
        positionBuffer: buffer(),
        normalBuffer: buffer(),
        uvBuffer: buffer(),
        indexBuffer: buffer(),
        indexCount: 3,
        indexFormat: "uint32",
        _refCount: 2,
    };
    const mesh = (name: string): Mesh =>
        ({
            name,
            material: {},
            _gpu: gpu,
            _cpuPositions: new Float32Array(9),
            _cpuNormals: new Float32Array(9),
            _cpuIndices: new Uint32Array([0, 1, 2]),
        }) as unknown as Mesh;
    const first = mesh("retired");
    const second = mesh("survivor");
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return { destroy: vi.fn(), getMappedRange: () => storage, unmap: () => undefined } as unknown as GPUBuffer;
    });
    const engine = {
        _device: { createBuffer, queue: { onSubmittedWorkDone: async () => undefined } },
    } as unknown as EngineContext;
    const firstLease = retainMeshResources(engine, first);
    const secondLease = retainMeshResources(engine, second);
    const recovery = _rebuildMeshes(engine, { meshes: [first, second] } as SceneContext);
    await barrier.entered;
    try {
        releaseMeshResources(firstLease);
        await waitForGpuResourceRetirements(engine);
        expect(first._disposed).toBe(true);
    } finally {
        barrier.resume();
    }
    await recovery;
    expect(first._gpu).toBe(gpu);
    expect(second._gpu).not.toBe(gpu);
    expect(createBuffer).toHaveBeenCalledTimes(4);
    const replacement = second._gpu;
    releaseMeshResources(secondLease);
    await waitForGpuResourceRetirements(engine);
    for (const allocation of [replacement.positionBuffer, replacement.normalBuffer, replacement.uvBuffer, replacement.indexBuffer]) {
        expect(allocation.destroy).toHaveBeenCalledTimes(1);
    }
});
