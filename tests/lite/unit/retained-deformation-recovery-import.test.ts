import { expect, it, vi } from "vitest";
import type { SkeletonData, MorphTargetData } from "../../../packages/babylon-lite/src/animation/types.js";
import { _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { retainMeshResources, releaseMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

const barriers = vi.hoisted(() => {
    const barrier = () => {
        let enter!: () => void;
        let resume!: () => void;
        return {
            entered: new Promise<void>((resolve) => (enter = resolve)),
            gate: new Promise<void>((resolve) => (resume = resolve)),
            enter: () => enter(),
            resume: () => resume(),
        };
    };
    return { skeleton: barrier(), morph: barrier() };
});
vi.mock("../../../packages/babylon-lite/src/skeleton/create-skeleton.js", async (load) => {
    barriers.skeleton.enter();
    await barriers.skeleton.gate;
    return load();
});
vi.mock("../../../packages/babylon-lite/src/morph/create-morph-targets.js", async (load) => {
    barriers.morph.enter();
    await barriers.morph.gate;
    return load();
});

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

it.each(["skeleton", "morph"] as const)("does not allocate replacement %s resources for a mesh retired during the factory import", async (kind) => {
    const buffer = (): GPUBuffer => stub<GPUBuffer>({ destroy: vi.fn() });
    const gpu: MeshGPU = { positionBuffer: buffer(), normalBuffer: buffer(), uvBuffer: buffer(), indexBuffer: buffer(), indexCount: 3, indexFormat: "uint32" };
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return stub<GPUBuffer>({ destroy: vi.fn(), getMappedRange: () => storage, unmap: () => undefined });
    });
    const createTexture = vi.fn(() => stub<GPUTexture>({ destroy: vi.fn() }));
    const engine = stub<EngineContext>({
        _device: stub<GPUDevice>({
            createBuffer,
            createTexture,
            queue: stub<GPUQueue>({ onSubmittedWorkDone: async () => undefined, writeTexture: vi.fn() }),
        }),
    });
    const skinBuffers = { jointsBuffer: buffer(), weightsBuffer: buffer(), joints1Buffer: null, weights1Buffer: null };
    const skeleton = stub<SkeletonData>({
        boneTexture: stub<GPUTexture>({ destroy: vi.fn() }),
        boneCount: 1,
        boneMatrices: new Float32Array(16),
        joints: new Uint16Array(12),
        weights: new Float32Array(12),
        ...skinBuffers,
        _skinBuffers: skinBuffers,
    });
    const morph = stub<MorphTargetData>({
        targets: [{ positions: new Float32Array(9), normals: null }],
        count: 1,
        weights: new Float32Array([1]),
        deltasBuffer: buffer(),
        weightsBuffer: buffer(),
    });
    const mesh = stub<Mesh>({
        name: kind,
        material: stub<Mesh["material"]>({}),
        _gpu: gpu,
        _cpuPositions: new Float32Array(9),
        _cpuNormals: new Float32Array(9),
        _cpuIndices: new Uint32Array([0, 1, 2]),
        skeleton: kind === "skeleton" ? skeleton : null,
        morphTargets: kind === "morph" ? morph : null,
    });
    const lease = retainMeshResources(engine, mesh);
    const recovery = _rebuildMeshes(engine, { meshes: [mesh] } as SceneContext);
    await barriers[kind].entered;
    const replacement = mesh._gpu;
    try {
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
    } finally {
        barriers[kind].resume();
    }
    await recovery;
    expect(createBuffer).toHaveBeenCalledTimes(4);
    expect(createTexture).not.toHaveBeenCalled();
    expect(mesh._gpu).toBe(replacement);
    for (const allocation of [replacement.positionBuffer, replacement.normalBuffer, replacement.uvBuffer, replacement.indexBuffer]) {
        expect(allocation.destroy).toHaveBeenCalledTimes(1);
    }
    if (kind === "skeleton") {
        expect(skeleton.boneTexture.destroy).toHaveBeenCalledTimes(1);
        expect(skeleton.jointsBuffer.destroy).toHaveBeenCalledTimes(1);
        expect(skeleton.weightsBuffer.destroy).toHaveBeenCalledTimes(1);
    } else {
        expect(morph.deltasBuffer.destroy).toHaveBeenCalledTimes(1);
        expect(morph.weightsBuffer.destroy).toHaveBeenCalledTimes(1);
    }
});
