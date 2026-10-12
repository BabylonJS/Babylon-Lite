import { describe, expect, it, vi } from "vitest";
import { rebuildRegisteredScenes, _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import { retainMeshResources, releaseMeshResources } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { MeshResourceLease } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { DeviceLostRecoveryState } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-references.js";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { settleRebuiltTextureOwnership } from "../../../packages/babylon-lite/src/texture/texture-recovery.js";

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

function gateEnvironment(): { entered: Promise<void>; resume: () => void } {
    let enter!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (resume = resolve));
    environment.rebuild.mockImplementationOnce(async () => {
        enter();
        await gate;
    });
    return { entered, resume };
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

    it("counts a clone of the recovered source once when the scene sweep reaches it", async () => {
        const { engine, scene, mesh, clone, createBuffer } = fixture();
        const lease = retainMeshResources(engine, mesh);
        const { entered, resume } = gateEnvironment();
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        const replacement = mesh._gpu;
        let late!: Mesh;
        try {
            late = cloneTransformNode(mesh) as Mesh;
            scene.meshes.push(late);
            expect(replacement._refCount).toBe(2);
        } finally {
            resume();
        }
        await recovery;
        expect(createBuffer).toHaveBeenCalledTimes(4);
        expect(clone._gpu).toBe(replacement);
        expect(late._gpu).toBe(replacement);
        expect(replacement._refCount).toBe(3);
        disposeMeshGpu(clone);
        disposeMeshGpu(late);
        for (const buffer of buffers(replacement)) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        for (const buffer of buffers(replacement)) {
            expect(buffer.destroy).toHaveBeenCalledTimes(1);
        }
    });

    it("keeps a shared texture alive when one lease is released before recovered ownership settles", async () => {
        const { engine } = fixture();
        const gpuTexture = (): GPUTexture => stub<GPUTexture>({ destroy: vi.fn() });
        const shared: Texture2D = { texture: gpuTexture(), view: stub<GPUTextureView>({}), sampler: stub<GPUSampler>({}), width: 1, height: 1 };
        acquireTexture(shared);
        const retained = (name: string): Mesh => {
            const material = createStandardMaterial();
            material.diffuseTexture = shared;
            const { mesh } = fixture();
            mesh.name = name;
            mesh.material = material;
            return mesh;
        };
        const first = retained("first");
        const second = retained("second");
        const firstLease = retainMeshResources(engine, first);
        const secondLease = retainMeshResources(engine, second);
        expect(_textureOwners(shared)).toBe(3);
        // Mirror texture recovery: replace the handle before handlers, queue its pre-loss ownership.
        const state = stub<DeviceLostRecoveryState>({ _pendingOwnership: [[shared, _textureOwners(shared)]] });
        shared.texture = gpuTexture();
        engine._deviceLostRecovery = state;
        const { entered, resume } = gateEnvironment();
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        try {
            releaseMeshResources(firstLease);
            await waitForGpuResourceRetirements(engine);
            expect(first._disposed).toBe(true);
            expect(shared.texture.destroy).not.toHaveBeenCalled();
        } finally {
            resume();
        }
        await recovery;
        settleRebuiltTextureOwnership(state);
        expect(_textureOwners(shared)).toBe(2);
        releaseMeshResources(secondLease);
        await waitForGpuResourceRetirements(engine);
        expect(second._disposed).toBe(true);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    async function retainAfterReplacement(
        duringWindow?: (claims: { engine: EngineContext; shared: Texture2D; lease: MeshResourceLease; lateLease: MeshResourceLease }) => Promise<void>
    ) {
        const { engine, mesh } = fixture();
        const gpuTexture = (): GPUTexture => stub<GPUTexture>({ destroy: vi.fn() });
        const shared: Texture2D = { texture: gpuTexture(), view: stub<GPUTextureView>({}), sampler: stub<GPUSampler>({}), width: 1, height: 1 };
        acquireTexture(shared);
        const material = createStandardMaterial();
        material.diffuseTexture = shared;
        mesh.material = material;
        const lease = retainMeshResources(engine, mesh);
        expect(_textureOwners(shared)).toBe(2);
        const state = stub<DeviceLostRecoveryState>({ _pendingOwnership: [[shared, _textureOwners(shared)]] });
        shared.texture = gpuTexture();
        engine._deviceLostRecovery = state;
        const { entered, resume } = gateEnvironment();
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        let late!: Mesh;
        let lateLease!: MeshResourceLease;
        try {
            late = cloneTransformNode(mesh) as Mesh;
            expect(late.material).toBe(material);
            lateLease = retainMeshResources(engine, late);
            await duringWindow?.({ engine, shared, lease, lateLease });
            expect(shared.texture.destroy).not.toHaveBeenCalled();
        } finally {
            resume();
        }
        await recovery;
        settleRebuiltTextureOwnership(state);
        return { engine, shared, lease, late, lateLease };
    }

    it("keeps a texture claim acquired after replacement once pre-loss owners release", async () => {
        const { engine, shared, lease, late, lateLease } = await retainAfterReplacement();
        expect(_textureOwners(shared)).toBe(3);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(releaseTexture(shared)).toBe(false);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(late.material).toMatchObject({ diffuseTexture: shared });
        releaseMeshResources(lateLease);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    it("does not debit pre-loss ownership when a post-replacement claim is released before settlement", async () => {
        const { engine, shared, lease } = await retainAfterReplacement(async ({ engine, lateLease }) => {
            releaseMeshResources(lateLease);
            await waitForGpuResourceRetirements(engine);
        });
        expect(_textureOwners(shared)).toBe(2);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    it("releases a live claim when every owed claim was already re-acquired before settlement", async () => {
        const { shared } = await retainAfterReplacement(async ({ engine, shared, lease, lateLease }) => {
            // A recovery handler re-acquires the creator's pre-loss claim.
            acquireTexture(shared);
            releaseMeshResources(lease);
            releaseMeshResources(lateLease);
            await waitForGpuResourceRetirements(engine);
        });
        expect(_textureOwners(shared)).toBe(1);
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });
});
