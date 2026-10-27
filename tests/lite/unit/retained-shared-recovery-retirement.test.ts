import { describe, expect, it, vi } from "vitest";
import { rebuildRegisteredScenes, _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { disposeMeshGpu } from "../../../packages/babylon-lite/src/mesh/mesh-dispose.js";
import {
    createPlane,
    resizeMeshGeometry,
    resizeSharedMeshGeometry,
    setMeshDrawRange,
    updateMeshGeometry,
    updateMeshGeometryCapacity,
    updateMeshPositions,
} from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { retainMeshResources, releaseMeshResources, detachMeshFromScene } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { MeshResourceLease } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { enableDeviceLostSceneRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-scene-recovery.js";
import type { DeviceLostRecoveryState } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-references.js";
import { _isTextureReleased, _textureOwners } from "../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { cloneTexture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { createSolidTexture2D } from "../../../packages/babylon-lite/src/texture/solid-texture.js";
import { rebuildTexture2D, settleRebuiltTextureOwnership } from "../../../packages/babylon-lite/src/texture/texture-recovery.js";
import { createMorphTargets } from "../../../packages/babylon-lite/src/morph/create-morph-targets.js";
import { createSkeleton } from "../../../packages/babylon-lite/src/skeleton/create-skeleton.js";

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

/** An unregistered scene a retained mesh can be reinserted into after recovery. */
function stubScene(engine: EngineContext): SceneContext {
    const surface = stub<SceneContext["surface"]>({ _renderingContexts: [] });
    Object.defineProperty(surface, "engine", { value: engine });
    return stub<SceneContext>({
        surface,
        meshes: [],
        lights: [],
        camera: null,
        shadowGenerators: [],
        animationGroups: [],
        _beforeRender: [],
        _prePasses: [],
        _pickSources: [],
        _uniformUpdaters: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _disposables: [],
        _deferredBuilders: [],
        _renderables: [],
        _materialSwapQueue: [],
        _renderableVersion: 0,
        _frameGraph: stub<SceneContext["_frameGraph"]>({ _tasks: [] }),
    });
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

    it.each(["resize", "shared resize", "capacity growth"] as const)("rebuilds live geometry when the first recovered owner replaces its geometry (%s)", async (mode) => {
        const { engine, scene, mesh, clone, createBuffer } = fixture();
        Object.assign(engine, { _renderingContexts: [scene] });
        const lease = retainMeshResources(engine, mesh);
        const { entered, resume } = gateEnvironment();
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        const replaced = mesh._gpu;
        expect(createBuffer).toHaveBeenCalledTimes(4);
        let sibling: Mesh | undefined;
        try {
            const positions = new Float32Array(12);
            const normals = new Float32Array(12);
            const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
            if (mode === "resize") {
                resizeMeshGeometry(engine, mesh, positions, normals, indices);
            } else if (mode === "shared resize") {
                sibling = cloneTransformNode(mesh) as Mesh;
                resizeSharedMeshGeometry(engine, [mesh, sibling], positions, normals, indices);
            } else {
                updateMeshGeometryCapacity(engine, mesh, positions, normals, indices);
            }
            expect(mesh._gpu).not.toBe(replaced);
            await waitForGpuResourceRetirements(engine);
            for (const buffer of buffers(replaced)) {
                expect(buffer.destroy).toHaveBeenCalledTimes(1);
            }
        } finally {
            resume();
        }
        await recovery;
        const live = clone._gpu;
        expect(live).not.toBe(replaced);
        expect(live).not.toBe(mesh._gpu);
        expect(live.indexCount).toBe(3);
        for (const buffer of buffers(live)) {
            expect(buffer.destroy).not.toHaveBeenCalled();
        }
        const resized = mesh._gpu;
        disposeMeshGpu(clone);
        if (sibling) {
            disposeMeshGpu(sibling);
        }
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        for (const gpu of [replaced, resized, live]) {
            for (const buffer of buffers(gpu)) {
                expect(buffer.destroy).toHaveBeenCalledTimes(1);
            }
        }
    });

    it.each(["geometry update", "capacity update", "attribute update", "draw range"] as const)(
        "rebuilds original geometry when the first recovered owner modifies its replacement in place (%s)",
        async (mode) => {
            const { engine, scene, mesh, clone, createBuffer } = fixture();
            const original = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
            mesh._cpuPositions = clone._cpuPositions = original;
            mesh.boundMax = clone.boundMax = [1, 1, 0];
            const contents = new Map<GPUBuffer, ArrayBuffer>();
            createBuffer.mockImplementation((descriptor: GPUBufferDescriptor): GPUBuffer => {
                const storage = new ArrayBuffer(Number(descriptor.size));
                const buffer = stub<GPUBuffer>({ destroy: vi.fn(), size: Number(descriptor.size), getMappedRange: () => storage, unmap: () => undefined });
                contents.set(buffer, storage);
                return buffer;
            });
            const writeBuffer = vi.fn((buffer: GPUBuffer, offset: number, data: ArrayBuffer, dataOffset: number, size: number) => {
                new Uint8Array(contents.get(buffer)!, offset, size).set(new Uint8Array(data, dataOffset, size));
            });
            Object.assign(engine._device.queue, { writeBuffer });
            Object.assign(engine, { _renderingContexts: [scene] });
            const lease = retainMeshResources(engine, mesh);
            const { entered, resume } = gateEnvironment();
            const recovery = rebuildRegisteredScenes(engine);
            await entered;
            const modified = mesh._gpu;
            try {
                const moved = new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5]);
                const normals = new Float32Array(9);
                const indices = new Uint32Array([0, 1, 2]);
                if (mode === "geometry update") {
                    updateMeshGeometry(engine, mesh, moved, normals, indices);
                } else if (mode === "capacity update") {
                    expect(updateMeshGeometryCapacity(engine, mesh, moved, normals, indices).stable).toBe(true);
                } else if (mode === "attribute update") {
                    updateMeshPositions(engine, mesh, moved);
                } else {
                    setMeshDrawRange(engine, mesh, { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 0 } });
                }
                expect(mesh._gpu).toBe(modified);
            } finally {
                resume();
            }
            await recovery;
            const live = clone._gpu;
            expect(live).not.toBe(modified);
            expect(live._drawRangeSource).toBeUndefined();
            expect(live.indexCount).toBe(3);
            expect(new Float32Array(contents.get(live.positionBuffer)!, 0, 9)).toEqual(original);
            expect(clone._cpuPositions).toBe(original);
            expect(clone.boundMax).toEqual([1, 1, 0]);
            expect(createBuffer).toHaveBeenCalledTimes(8);
            disposeMeshGpu(clone);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
            for (const gpu of [modified, live]) {
                for (const buffer of buffers(gpu)) {
                    expect(buffer.destroy).toHaveBeenCalledTimes(1);
                }
            }
        }
    );

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

    it("keeps a late clone on a uniquely recovered replacement instead of uploading it again", async () => {
        const { engine, scene, mesh, clone, createBuffer } = fixture();
        scene.meshes.length = 0;
        disposeMeshGpu(clone);
        const lease = retainMeshResources(engine, mesh);
        const { entered, resume } = gateEnvironment();
        const recovery = rebuildRegisteredScenes(engine);
        await entered;
        const replacement = mesh._gpu;
        expect(replacement._recoverShared).toBeUndefined();
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
        expect(late._gpu).toBe(replacement);
        expect(mesh._gpu).toBe(replacement);
        expect(replacement._refCount).toBe(2);
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
        const state = stub<DeviceLostRecoveryState>({ _pendingOwnership: [[shared, _textureOwners(shared), shared.texture, true]] });
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
        const state = stub<DeviceLostRecoveryState>({ _pendingOwnership: [[shared, _textureOwners(shared), shared.texture, true]] });
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

    async function fetchWindow(
        duringFetch: (claims: { engine: EngineContext; mesh: Mesh; shared: Texture2D; lease: MeshResourceLease }) => Promise<void>,
        creatorClaim = true,
        // Runs after the fetch and before ownership settles: where the registered-scene handler runs.
        afterFetch?: (engine: EngineContext) => Promise<void>
    ) {
        const { engine, mesh } = fixture();
        const gpuTexture = (): GPUTexture => stub<GPUTexture>({ destroy: vi.fn(), createView: () => stub<GPUTextureView>({}) });
        const outgoing = gpuTexture();
        const shared: Texture2D = {
            texture: outgoing,
            view: stub<GPUTextureView>({}),
            sampler: stub<GPUSampler>({}),
            width: 1,
            height: 1,
            _recoverySource: { kind: "url", url: "retained.png", opts: { mipMaps: false } },
        };
        if (creatorClaim) {
            acquireTexture(shared);
        }
        const material = createStandardMaterial();
        material.diffuseTexture = shared;
        mesh.material = material;
        const lease = retainMeshResources(engine, mesh);
        expect(_textureOwners(shared)).toBe(creatorClaim ? 2 : 1);
        Object.assign(engine._device, { createTexture: vi.fn(gpuTexture), createSampler: () => stub<GPUSampler>({}) });
        Object.assign(engine._device.queue, { copyExternalImageToTexture: vi.fn() });
        const state = stub<DeviceLostRecoveryState>({});
        engine._deviceLostRecovery = state;
        let fetched!: () => void;
        const gate = new Promise<void>((resolve) => (fetched = resolve));
        let entered!: () => void;
        const inFetch = new Promise<void>((resolve) => (entered = resolve));
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                entered();
                await gate;
                return { blob: async () => stub<Blob>({}) };
            })
        );
        vi.stubGlobal(
            "createImageBitmap",
            vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() }))
        );
        try {
            const rebuild = rebuildTexture2D(engine, shared);
            await inFetch;
            try {
                await duringFetch({ engine, mesh, shared, lease });
                expect(shared.texture).toBe(outgoing);
            } finally {
                fetched();
            }
            await rebuild;
            await afterFetch?.(engine);
        } finally {
            vi.unstubAllGlobals();
        }
        expect(shared.texture).not.toBe(outgoing);
        settleRebuiltTextureOwnership(state);
        return { engine, shared, lease };
    }

    it("hands the replacement to a wrapper cloned onto a detached retained mesh while the fetch is in flight", async () => {
        let outgoing!: GPUTexture;
        let derived!: Texture2D;
        let late!: Mesh;
        let lateLease!: MeshResourceLease;
        const material = createStandardMaterial();
        const { engine, shared, lease } = await fetchWindow(
            async ({ engine, mesh, shared }) => {
                outgoing = shared.texture;
                derived = cloneTexture2D(shared, { uScale: 2 });
                material.diffuseTexture = derived;
                late = cloneTransformNode(mesh) as Mesh;
                late.material = material;
                lateLease = retainMeshResources(engine, late);
            },
            true,
            async (engine) => {
                // Tracked after the up-front snapshot and in no scene: only the retained pass reaches it.
                expect(derived.texture).toBe(outgoing);
                await rebuildRegisteredScenes(engine);
            }
        );
        expect(derived.texture).toBe(shared.texture);
        expect(derived.view).toBe(shared.view);
        expect(_textureOwners(shared)).toBe(3);

        const target = stubScene(engine);
        addToScene(target, late);
        expect(target.meshes).toContain(late);
        expect(late.material).toBe(material);
        expect(material.diffuseTexture?.texture).toBe(shared.texture);
        detachMeshFromScene(target, late);

        releaseMeshResources(lease);
        releaseMeshResources(lateLease);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
        expect(outgoing.destroy).not.toHaveBeenCalled();
    });

    it("reconciles a wrapper reassigned onto an already-retained mesh before the source is replaced", async () => {
        let outgoing!: GPUTexture;
        let derived!: Texture2D;
        let retained!: Mesh;
        const material = createStandardMaterial();
        const { engine, shared, lease } = await fetchWindow(
            async ({ mesh, shared }) => {
                outgoing = shared.texture;
                retained = mesh;
                // Shares the claimed source's outgoing allocation, so claim deduplication acquires nothing for it.
                derived = cloneTexture2D(shared, { uScale: 2 });
                material.diffuseTexture = derived;
                mesh.material = material;
            },
            true,
            async (engine) => {
                expect(derived.texture).toBe(outgoing);
                await rebuildRegisteredScenes(engine);
            }
        );
        expect(derived.texture).toBe(shared.texture);
        expect(derived.view).toBe(shared.view);
        expect(_textureOwners(shared)).toBe(2);

        const target = stubScene(engine);
        addToScene(target, retained);
        expect(material.diffuseTexture?.texture).toBe(shared.texture);
        detachMeshFromScene(target, retained);

        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
        expect(outgoing.destroy).not.toHaveBeenCalled();
    });

    it("reconciles a wrapper only a retained material plugin's closure holds", async () => {
        let outgoing!: GPUTexture;
        let derived!: Texture2D;
        let late!: Mesh;
        let lateLease!: MeshResourceLease;
        const material = createStandardMaterial();
        // Held only in the plugin's closure: no walk of the material's enumerable properties reaches it.
        material.plugins = [{ name: "closure", getActiveTextures: (out) => out.push(derived) }];
        const { engine, shared, lease } = await fetchWindow(
            async ({ engine, mesh, shared }) => {
                outgoing = shared.texture;
                derived = cloneTexture2D(shared, { uScale: 2 });
                late = cloneTransformNode(mesh) as Mesh;
                late.material = material;
                lateLease = retainMeshResources(engine, late);
            },
            true,
            async (engine) => {
                expect(derived.texture).toBe(outgoing);
                await rebuildRegisteredScenes(engine);
            }
        );
        expect(derived.texture).toBe(shared.texture);
        expect(derived.view).toBe(shared.view);
        expect(_textureOwners(shared)).toBe(3);

        const target = stubScene(engine);
        addToScene(target, late);
        const active: Texture2D[] = [];
        material.plugins[0]!.getActiveTextures!(active);
        expect(active[0]!.texture).toBe(shared.texture);
        detachMeshFromScene(target, late);

        releaseMeshResources(lease);
        releaseMeshResources(lateLease);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
        expect(outgoing.destroy).not.toHaveBeenCalled();
    });

    it("keeps both claims when recovery converges a retained mesh's wrappers onto one replacement", async () => {
        let retained!: Mesh;
        let alias!: Texture2D;
        let source!: Texture2D;
        const aliased = createStandardMaterial();
        const { engine, shared, lease } = await fetchWindow(
            async ({ mesh, shared }) => {
                retained = mesh;
                source = shared;
                alias = cloneTexture2D(shared, { uScale: 2 });
                aliased.diffuseTexture = alias;
            },
            true,
            async (engine) => {
                // The source is replaced, but the alias still holds the outgoing handle until reconciliation:
                // this assignment claims it as a distinct allocation.
                expect(alias.texture).not.toBe(source.texture);
                retained.material = aliased;
                await rebuildRegisteredScenes(engine);
                expect(alias.texture).toBe(source.texture);
            }
        );
        expect(_textureOwners(shared)).toBe(3);
        // Recapturing now sees two claimed wrappers on one allocation; neither claim may be forgotten.
        const original = createStandardMaterial();
        original.diffuseTexture = shared;
        retained.material = original;
        const target = stubScene(engine);
        addToScene(target, retained);
        detachMeshFromScene(target, retained);

        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(_textureOwners(shared)).toBe(1);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    it("keeps geometry, deformation and textures a retained mesh allocated on the replacement device while the fetch was in flight", async () => {
        let fresh!: Mesh;
        let freshLease!: MeshResourceLease;
        let allocated!: MeshGPU;
        let solid!: Texture2D;
        let solidTexture!: GPUTexture;
        let deformation!: GPUBuffer[];
        let boneTexture!: GPUTexture;
        let disable!: () => void;
        const { engine, lease, shared } = await fetchWindow(
            async ({ engine }) => {
                // Recovery installed the replacement device before awaiting the fetch; these are made on it.
                Object.assign(engine._device, { features: new Set<GPUFeatureName>() });
                Object.assign(engine._device.queue, { writeTexture: vi.fn() });
                Object.assign(engine._deviceLostRecovery!, {
                    _recovering: true,
                    _requiredFeatures: [],
                    _registrations: [],
                    _samplerDescriptors: new WeakMap(),
                    _captureRefs: 0,
                    _meshCaptureRefs: 0,
                    _textures: new Set(),
                    _texturesPruneAt: 64,
                });
                disable = enableDeviceLostSceneRecovery(engine).disable;
                fresh = createPlane(engine);
                allocated = fresh._gpu;
                const vertexCount = fresh._cpuPositions!.length / 3;
                fresh.morphTargets = createMorphTargets(engine, [{ positions: new Float32Array(vertexCount * 3), normals: null }], vertexCount, [0]);
                fresh.skeleton = createSkeleton(engine, new Uint16Array(vertexCount * 4), new Float32Array(vertexCount * 4), 1, new Float32Array(16));
                deformation = [fresh.morphTargets.deltasBuffer, fresh.morphTargets.weightsBuffer, fresh.skeleton.jointsBuffer, fresh.skeleton.weightsBuffer];
                boneTexture = fresh.skeleton.boneTexture;
                solid = createSolidTexture2D(engine, 1, 0, 0);
                solidTexture = solid.texture;
                const material = createStandardMaterial();
                material.diffuseTexture = solid;
                fresh.material = material;
                freshLease = retainMeshResources(engine, fresh);
            },
            true,
            (engine) => rebuildRegisteredScenes(engine)
        );
        try {
            expect(fresh._gpu).toBe(allocated);
            expect(solid.texture).toBe(solidTexture);
            const live = [fresh.morphTargets!.deltasBuffer, fresh.morphTargets!.weightsBuffer, fresh.skeleton!.jointsBuffer, fresh.skeleton!.weightsBuffer];
            live.forEach((buffer, i) => expect(buffer).toBe(deformation[i]));
            expect(fresh.skeleton!.boneTexture).toBe(boneTexture);
            for (const resource of [...buffers(allocated), ...deformation, boneTexture, solidTexture]) {
                expect(resource.destroy).not.toHaveBeenCalled();
            }
            releaseMeshResources(freshLease);
            await waitForGpuResourceRetirements(engine);
            expect(solidTexture.destroy).not.toHaveBeenCalled();
            expect(releaseTexture(solid)).toBe(true);
            for (const resource of [...buffers(allocated), ...deformation, boneTexture, solidTexture]) {
                expect(resource.destroy).toHaveBeenCalledOnce();
            }
        } finally {
            releaseMeshResources(lease);
            releaseTexture(shared);
            disable();
        }
    });

    it("keeps a lease claim acquired while the texture fetch is in flight", async () => {
        let late!: Mesh;
        let lateLease!: MeshResourceLease;
        const { engine, shared, lease } = await fetchWindow(async ({ engine, mesh }) => {
            late = cloneTransformNode(mesh) as Mesh;
            lateLease = retainMeshResources(engine, late);
        });
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

    it("does not restore a lease claim released while the texture fetch is in flight", async () => {
        const { shared } = await fetchWindow(async ({ engine, mesh, lease }) => {
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
            expect(mesh._disposed).toBe(true);
        });
        expect(_textureOwners(shared)).toBe(1);
        expect(releaseTexture(shared)).toBe(true);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    it("retires the replacement when the last lease claim is released while the texture fetch is in flight", async () => {
        const { shared } = await fetchWindow(async ({ engine, lease }) => {
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
        }, false);
        expect(_textureOwners(shared)).toBe(0);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    async function mipmapWindow(duringImport: (shared: Texture2D, engine: EngineContext) => Promise<void> | void) {
        const { engine } = fixture();
        const gpuTexture = (): GPUTexture => stub<GPUTexture>({ destroy: vi.fn(), createView: () => stub<GPUTextureView>({}) });
        const outgoing = gpuTexture();
        // A mipmapped glTF texture before its meshes first bind: it has a recovery source but no owner.
        const shared: Texture2D = {
            texture: outgoing,
            view: stub<GPUTextureView>({}),
            sampler: stub<GPUSampler>({}),
            width: 2,
            height: 2,
            _recoverySource: { kind: "bitmap", bitmap: stub<ImageBitmap>({ width: 2, height: 2 }), srgb: true, mipMaps: true },
        };
        expect(_textureOwners(shared)).toBe(0);
        Object.assign(engine._device, { createTexture: vi.fn(gpuTexture), createSampler: () => stub<GPUSampler>({}) });
        Object.assign(engine._device.queue, { copyExternalImageToTexture: vi.fn() });
        const state = stub<DeviceLostRecoveryState>({});
        engine._deviceLostRecovery = state;
        let imported!: () => void;
        const gate = new Promise<void>((resolve) => (imported = resolve));
        let entered!: () => void;
        const inImport = new Promise<void>((resolve) => (entered = resolve));
        vi.doMock("../../../packages/babylon-lite/src/texture/generate-mipmaps.js", async () => {
            entered();
            await gate;
            return { generateMipmaps: vi.fn() };
        });
        try {
            const rebuild = rebuildTexture2D(engine, shared);
            await inImport;
            try {
                await duringImport(shared, engine);
                expect(shared.texture).toBe(outgoing);
            } finally {
                imported();
            }
            await rebuild;
        } finally {
            vi.doUnmock("../../../packages/babylon-lite/src/texture/generate-mipmaps.js");
        }
        expect(shared.texture).not.toBe(outgoing);
        settleRebuiltTextureOwnership(state);
        return { engine, shared };
    }

    it("carries claims taken during a zero-owner mipmap rebuild onto the replacement", async () => {
        const leases: MeshResourceLease[] = [];
        const { engine, shared } = await mipmapWindow((texture, engine) => {
            for (const name of ["first", "second"]) {
                const material = createStandardMaterial();
                material.diffuseTexture = texture;
                const { mesh } = fixture();
                mesh.name = name;
                mesh.material = material;
                leases.push(retainMeshResources(engine, mesh));
            }
        });
        expect(_textureOwners(shared)).toBe(2);
        releaseMeshResources(leases[0]!);
        await waitForGpuResourceRetirements(engine);
        expect(_textureOwners(shared)).toBe(1);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
        releaseMeshResources(leases[1]!);
        await waitForGpuResourceRetirements(engine);
        expect(shared.texture.destroy).toHaveBeenCalledOnce();
    });

    it("keeps a never-owned texture's mipmap replacement allocated and unowned", async () => {
        const { shared } = await mipmapWindow(() => undefined);
        expect(_textureOwners(shared)).toBe(0);
        expect(_isTextureReleased(shared)).toBe(false);
        expect(shared.texture.destroy).not.toHaveBeenCalled();
    });
});

describe("detached recovery of registered scenes", () => {
    it("drops a material group emptied by detach instead of invoking its builder", async () => {
        const { engine, scene, mesh, clone } = fixture();
        // A PBR-style builder reads its first mesh's material, which an emptied group cannot supply.
        const pbr = Object.assign(
            vi.fn((_scene: SceneContext, meshes: Mesh[]) => {
                void meshes[0]!.material;
                return { renderables: [], rebuildSingle: vi.fn() };
            }),
            { _materialFamily: "pbr" }
        );
        const live = vi.fn(() => ({ renderables: [], rebuildSingle: vi.fn() }));
        scene._groups.set(pbr as never, Object.assign([] as Mesh[], { r: vi.fn(), o: [] }) as never);
        scene._groups.set(live as never, [clone] as never);
        const dropBase = vi.fn();
        scene._runtimeBuilds = stub<NonNullable<SceneContext["_runtimeBuilds"]>>({ base: (_build, rebuild) => rebuild, dropBase });
        const lease = retainMeshResources(engine, mesh);
        await rebuildRegisteredScenes(engine);
        expect(pbr).not.toHaveBeenCalled();
        expect(scene._groups.has(pbr as never)).toBe(false);
        expect(dropBase).toHaveBeenCalledWith(pbr);
        expect(live).toHaveBeenCalledOnce();
        expect(scene._frameGraph.build).toHaveBeenCalledOnce();
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
    });

    it("rebuilds deformation shared by a detached source and its attached clone once and tears it down once", async () => {
        const { engine, scene, mesh } = fixture();
        const gpuTexture = vi.fn(() => stub<GPUTexture>({ destroy: vi.fn() }));
        Object.assign(engine._device, { createTexture: gpuTexture });
        Object.assign(engine._device.queue, { writeTexture: vi.fn() });
        const buffer = (): GPUBuffer => stub<GPUBuffer>({ destroy: vi.fn() });
        mesh.skeleton = stub<NonNullable<Mesh["skeleton"]>>({
            boneTexture: stub<GPUTexture>({ destroy: vi.fn() }),
            boneCount: 1,
            boneMatrices: new Float32Array(16),
            joints: new Uint16Array(12),
            weights: new Float32Array(12),
            joints1: null,
            weights1: null,
            jointsBuffer: buffer(),
            weightsBuffer: buffer(),
            joints1Buffer: null,
            weights1Buffer: null,
            _skinBuffers: {} as never,
        });
        mesh.morphTargets = stub<NonNullable<Mesh["morphTargets"]>>({
            deltasBuffer: buffer(),
            weightsBuffer: buffer(),
            count: 1,
            targets: [{ positions: new Float32Array(9), normals: new Float32Array(9) }],
            weights: new Float32Array(1),
        });
        const attached = cloneTransformNode(mesh) as Mesh;
        scene.meshes.length = 0;
        scene.meshes.push(attached);
        const lease = retainMeshResources(engine, mesh);
        await rebuildRegisteredScenes(engine);
        expect(gpuTexture).toHaveBeenCalledOnce();
        const skeleton = mesh.skeleton!;
        const morph = mesh.morphTargets!;
        expect(attached.skeleton).toBe(skeleton);
        expect(attached.morphTargets).toBe(morph);
        const replacements = [skeleton.boneTexture, skeleton.jointsBuffer, skeleton.weightsBuffer, morph.deltasBuffer, morph.weightsBuffer];
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        disposeMeshGpu(attached);
        for (const replacement of replacements) {
            expect(replacement.destroy).toHaveBeenCalledOnce();
        }
    });
});
