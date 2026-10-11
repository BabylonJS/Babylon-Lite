import { describe, expect, it, vi } from "vitest";
import { rebuildRegisteredScenes, _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import { retainMeshResources, releaseMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";

const environment = vi.hoisted(() => ({ rebuild: vi.fn<() => Promise<void>>() }));
vi.mock("../../../packages/babylon-lite/src/loader-env/environment-recovery.js", () => ({
    rebuildSceneEnvironment: environment.rebuild,
}));

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

function buffers(gpu: MeshGPU): GPUBuffer[] {
    return [gpu.positionBuffer, gpu.normalBuffer, gpu.uvBuffer, gpu.indexBuffer];
}

function fixture() {
    const buffer = (): GPUBuffer => stub<GPUBuffer>({ destroy: vi.fn() });
    const gpu: MeshGPU = { positionBuffer: buffer(), normalBuffer: buffer(), uvBuffer: buffer(), indexBuffer: buffer(), indexCount: 3, indexFormat: "uint32" };
    const mesh = initMeshTransform({
        name: "retained",
        material: stub<Mesh["material"]>({}),
        receiveShadows: false,
        boundMin: [0, 0, 0],
        boundMax: [1, 1, 1],
        _gpu: gpu,
        _cpuPositions: new Float32Array(9),
        _cpuNormals: new Float32Array(9),
        _cpuIndices: new Uint32Array([0, 1, 2]),
    });
    const clone = cloneTransformNode(mesh) as Mesh;
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        const storage = new ArrayBuffer(Number(descriptor.size));
        return stub<GPUBuffer>({ destroy: vi.fn(), getMappedRange: () => storage, unmap: () => undefined });
    });
    const surface = stub<SceneContext["surface"]>({ _renderingContexts: [] });
    const engine = stub<EngineContext>({
        _device: stub<GPUDevice>({ createBuffer, queue: stub<GPUQueue>({ onSubmittedWorkDone: async () => undefined }) }),
        surfaces: [surface],
    });
    const scene = stub<SceneContext>({
        surface,
        meshes: [clone],
        _envTextures: stub<NonNullable<SceneContext["_envTextures"]>>({}),
        shadowGenerators: [],
        lights: [],
        _renderables: [],
        _uniformUpdaters: [],
        _meshDisposables: new Map(),
        _groups: new Map(),
        _renderableVersion: 0,
        _frameGraph: stub<SceneContext["_frameGraph"]>({ _tasks: [], build: vi.fn() }),
    });
    Object.defineProperty(scene, "_kind", { value: "scene" });
    surface._renderingContexts.push(scene);
    return { engine, scene, mesh, clone, createBuffer };
}

describe("shared replacement retirement during registered scene recovery", () => {
    it("does not pin replacement claims when the awaiting scene and all owners are disposed", async () => {
        const { engine, scene, mesh, clone, createBuffer } = fixture();
        const lease = retainMeshResources(engine, mesh);
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => (enter = resolve));
        const gate = new Promise<void>((resolve) => (resume = resolve));
        environment.rebuild.mockImplementationOnce(async () => {
            enter();
            await gate;
        });
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        const replacement = mesh._gpu;
        try {
            scene._z = true;
            disposeMeshGpu(clone);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
        } finally {
            resume();
        }
        await recovery;
        expect(createBuffer).toHaveBeenCalledTimes(4);
        for (const buffer of buffers(replacement)) {
            expect(buffer.destroy).toHaveBeenCalledTimes(1);
        }
        expect(mesh._disposed).toBe(true);
        expect(clone._disposed).toBe(true);
    });

    it.each(["success", "failure", "overlap"] as const)("rebuilds live geometry after the first recovered owner retires (%s)", async (mode) => {
        const { engine, scene, mesh, clone, createBuffer } = fixture();
        const lease = retainMeshResources(engine, mesh);
        let enter!: () => void;
        let resume!: () => void;
        const entered = new Promise<void>((resolve) => (enter = resolve));
        const gate = new Promise<void>((resolve) => (resume = resolve));
        environment.rebuild.mockImplementationOnce(async () => {
            enter();
            await gate;
            if (mode === "failure") {
                throw new Error("controlled environment failure");
            }
        });
        const recovery = rebuildRegisteredScenes(engine);
        const settled = mode === "failure" ? expect(recovery).rejects.toThrow(/rebuilding environment textures: controlled environment failure/) : recovery;
        await entered;
        const retired = mesh._gpu;
        expect(createBuffer).toHaveBeenCalledTimes(4);
        expect(clone._gpu).not.toBe(retired);
        try {
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
            expect(mesh._disposed).toBe(true);
            for (const buffer of buffers(retired)) {
                expect(buffer.destroy).toHaveBeenCalledTimes(1);
            }
            if (mode === "overlap") {
                await _rebuildMeshes(engine, scene);
            }
        } finally {
            resume();
        }
        await settled;
        if (mode === "failure") {
            await _rebuildMeshes(engine, scene);
        }
        const live = clone._gpu;
        expect(live).not.toBe(retired);
        expect(createBuffer).toHaveBeenCalledTimes(8);
        for (const buffer of buffers(live)) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }
        await _rebuildMeshes(engine, scene);
        expect(clone._gpu).toBe(live);
        expect(createBuffer).toHaveBeenCalledTimes(8);
        const lateClone = cloneTransformNode(clone) as Mesh;
        expect(live._refCount).toBe(2);
        disposeMeshGpu(clone);
        for (const buffer of buffers(live)) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }
        disposeMeshGpu(lateClone);
        disposeMeshGpu(lateClone);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        for (const gpu of [retired, live]) {
            for (const buffer of buffers(gpu)) {
                expect(buffer.destroy).toHaveBeenCalledTimes(1);
            }
        }
    });
});
