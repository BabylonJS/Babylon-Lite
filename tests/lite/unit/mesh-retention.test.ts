import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine-dispose.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { initMeshTransform, uploadMeshToGPU } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { retainMeshResources, releaseMeshResources, detachMeshFromScene } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import { addToScene, disposeScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove.js";
import { createTransformNode, cloneTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node.js";
import { pickWithRay } from "../../../packages/babylon-lite/src/picking/ray-pick.js";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material.js";
import { rebuildRegisteredScenes, _rebuildMeshes } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-references.js";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { createShaderMaterial, setShaderTexture } from "../../../packages/babylon-lite/src/material/shader/shader-material.js";
import { updateMeshGeometryCapacity } from "../../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { createHemisphericLight } from "../../../packages/babylon-lite/src/light/hemispheric.js";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl.js";
import { B as buildRuntimeMesh } from "../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build.js";
import type { MeshGroupBuilder } from "../../../packages/babylon-lite/src/render/renderable.js";

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

function fixture() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        const bytes = new ArrayBuffer(Number(descriptor.size));
        return stub<GPUBuffer>({ destroy: vi.fn(), getMappedRange: () => bytes, unmap: () => undefined });
    });
    const device = stub<GPUDevice>({ createBuffer, queue: stub<GPUQueue>({ onSubmittedWorkDone: async () => undefined }), destroy: vi.fn() });
    const surface = stub<SceneContext["surface"]>({ _renderingContexts: [], _context: stub<GPUCanvasContext>({ unconfigure: vi.fn() }) });
    const engine = stub<EngineContext>({ _device: device, surfaces: [surface], _surfaces: [surface], _animFrameId: 0, _renderFn: null });
    Object.defineProperty(surface, "engine", { value: engine });
    const scene = stub<SceneContext>({
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
    const mesh = initMeshTransform({
        name: "card",
        id: "same-card",
        material: createStandardMaterial(),
        receiveShadows: false,
        boundMin: [-1, -1, 0],
        boundMax: [1, 1, 0],
        _cpuPositions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
        _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        _cpuIndices: new Uint32Array([0, 1, 2]),
        _gpu: uploadMeshToGPU(engine, new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2])),
    });
    return { engine, scene, mesh, createBuffer };
}

describe("retained mesh scene membership", () => {
    it("evicts pending merged packets synchronously without taking their async teardown ownership", async () => {
        const { engine, scene, mesh } = fixture();
        let entered!: () => void;
        let resume!: () => void;
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const builder: MeshGroupBuilder = async () => {
            entered();
            await gate;
            return {
                renderables: [],
                rebuildSingle: () => {
                    throw new Error("Cancelled fixture build must not be installed");
                },
            };
        };
        Object.defineProperty(mesh.material, "_buildGroup", { value: builder });
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        const empty = vi.fn();
        const packet: { _disposed: boolean; _owner?: (typeof packet)[]; _onOwnerEmpty?: () => void } = { _disposed: false, _onOwnerEmpty: empty };
        const owner = [packet];
        packet._owner = owner;
        const dispose = Object.assign(vi.fn(), { p: packet });
        scene._meshDisposables.set(mesh, [dispose]);
        scene._disposables.push(dispose);
        const pending = buildRuntimeMesh(scene, builder, mesh);
        await waiting;
        expect(scene._meshDisposables.has(mesh)).toBe(false);
        expect(scene._runtimeBuilds?.pendingDisposers(mesh)).toEqual([dispose]);
        detachMeshFromScene(scene, mesh);
        expect(packet._disposed).toBe(true);
        expect(owner).toEqual([]);
        expect(empty).toHaveBeenCalledTimes(1);
        expect(dispose).not.toHaveBeenCalled();
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
        expect(dispose).not.toHaveBeenCalled();
        resume();
        await pending;
        await waitForGpuResourceRetirements(engine);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(scene._runtimeBuilds?.pendingDisposers(mesh)).toBeUndefined();
        disposeScene(scene);
        expect(dispose).toHaveBeenCalledTimes(1);
    });
    it("installs admission only on each opted-in engine and removes it independently with its final lease", () => {
        const first = fixture();
        const second = fixture();
        const firstLease = retainMeshResources(first.engine, first.mesh);
        expect(first.engine).toHaveProperty("_admitSceneEntity", expect.any(Function));
        expect(second.engine).not.toHaveProperty("_admitSceneEntity");
        addToScene(second.scene, second.mesh);
        addToScene(second.scene, second.mesh);
        expect(second.scene.meshes).toHaveLength(2);
        const secondLease = retainMeshResources(second.engine, second.mesh);
        expect(second.engine).toHaveProperty("_admitSceneEntity", expect.any(Function));
        releaseMeshResources(firstLease);
        expect(first.engine).not.toHaveProperty("_admitSceneEntity");
        expect(second.engine).toHaveProperty("_admitSceneEntity", expect.any(Function));
        addToScene(second.scene, second.mesh);
        expect(second.scene.meshes).toHaveLength(2);
        releaseMeshResources(secondLease);
        expect(second.engine).not.toHaveProperty("_admitSceneEntity");
    });

    it("keeps the same geometry through 1000 detached retirement fences and fresh admissions", async () => {
        const { engine, scene, mesh, createBuffer } = fixture();
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        const gpu = mesh._gpu;
        const parent = createTransformNode("parent");
        mesh.parent = parent;
        mesh.visible = false;
        mesh.metadata = { value: "unchanged" };
        const peer = fixture().mesh;
        addToScene(scene, peer);
        for (let i = 0; i < 1000; i++) {
            detachMeshFromScene(scene, mesh);
            const version = scene._renderableVersion;
            detachMeshFromScene(scene, mesh);
            expect(scene._renderableVersion).toBe(version);
            expect(scene.meshes).toEqual([peer]);
            expect(pickWithRay(scene, { origin: [0, 0, -2], direction: [0, 0, 1], length: 10 }, { predicate: (candidate) => candidate === mesh }).hit).toBe(false);
            await waitForGpuResourceRetirements(engine);
            expect(mesh._gpu).toBe(gpu);
            expect(mesh._disposed).not.toBe(true);
            addToScene(scene, mesh);
            addToScene(scene, mesh);
            expect(scene.meshes).toEqual([peer, mesh]);
        }
        expect(createBuffer).toHaveBeenCalledTimes(4);
        expect(mesh.parent).toBe(parent);
        expect(mesh.visible).toBe(false);
        expect(mesh.id).toBe("same-card");
        expect(mesh.metadata).toEqual({ value: "unchanged" });
        detachMeshFromScene(scene, mesh);
        releaseMeshResources(lease);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
        for (const buffer of [gpu.positionBuffer, gpu.normalBuffer, gpu.uvBuffer, gpu.indexBuffer]) {
            expect(buffer.destroy).toHaveBeenCalledOnce();
        }
        expect(() => addToScene(scene, mesh)).toThrow(/disposed/);
    });

    it("requires a live lease and rejects unsupported roots before mutating membership", () => {
        const { scene, mesh } = fixture();
        addToScene(scene, mesh);
        expect(() => detachMeshFromScene(scene, mesh)).toThrow(/retainMeshResources/);
        expect(() => detachMeshFromScene(scene, createTransformNode("root") as typeof mesh)).toThrow(/Mesh/);
        expect(scene.meshes).toEqual([mesh]);
    });

    it("evicts all legacy duplicate slots rather than leaving a detached mesh pickable", () => {
        const { engine, scene, mesh } = fixture();
        expect(() => releaseMeshResources({ mesh })).toThrow("must be created by retainMeshResources");
        addToScene(scene, mesh);
        addToScene(scene, mesh);
        expect(scene.meshes).toHaveLength(2);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        expect(scene.meshes).toHaveLength(0);
        expect([...scene._groups.values()].flat()).not.toContain(mesh);
        addToScene(scene, mesh);
        addToScene(scene, mesh);
        expect(scene.meshes).toEqual([mesh]);
        releaseMeshResources(lease);
    });

    it("preserves another scene's subscription and waits for all independent leases", async () => {
        const { engine, scene, mesh } = fixture();
        const second = { ...scene, meshes: [], _materialSwapQueue: [], _groups: new Map() };
        addToScene(scene, mesh);
        addToScene(second, mesh);
        const first = retainMeshResources(engine, mesh);
        const last = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        const replacement = createStandardMaterial();
        replacement.diffuseColor = [0, 1, 0];
        mesh.material = replacement;
        expect(scene._materialSwapQueue).toHaveLength(0);
        expect(second._materialSwapQueue).toEqual([mesh]);
        releaseMeshResources(first);
        removeFromScene(second, mesh);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).not.toBe(true);
        releaseMeshResources(last);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
    });

    it("keeps shared geometry counts separate from scene and lease counts", async () => {
        const { engine, scene, mesh } = fixture();
        const clone = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        addToScene(scene, clone);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        removeFromScene(scene, clone);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._gpu._refCount).toBe(1);
        expect(mesh._gpu.positionBuffer.destroy).not.toHaveBeenCalled();
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("engine teardown releases detached ownership even when the caller forgets the lease", () => {
        const { engine, scene, mesh } = fixture();
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        disposeEngine(engine);
        expect(mesh._disposed).toBe(true);
        expect(mesh._gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
        releaseMeshResources(lease);
        expect(mesh._gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
        expect(() => retainMeshResources(engine, mesh)).toThrow(/disposed/);
    });

    it("does not let an earlier queued release dispose a reacquired mesh", async () => {
        const { engine, scene, mesh } = fixture();
        addToScene(scene, mesh);
        const first = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        releaseMeshResources(first);
        const second = retainMeshResources(engine, mesh);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).not.toBe(true);
        addToScene(scene, mesh);
        releaseMeshResources(second);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).not.toBe(true);
        removeFromScene(scene, mesh);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
    });

    it("detaches only the requested mesh and preserves a child's membership and parent", () => {
        const { engine, scene, mesh } = fixture();
        const child = fixture().mesh;
        child.parent = mesh;
        mesh.children.push(child);
        const light = createHemisphericLight([0, 1, 0], 1);
        mesh.children.push(light);
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        expect(scene.meshes).toEqual([child]);
        expect(child.parent).toBe(mesh);
        expect(scene.lights).toEqual([light]);
        addToScene(scene, mesh);
        expect(scene.meshes).toEqual([child, mesh]);
        expect(child.parent).toBe(mesh);
        expect(scene.lights).toEqual([light]);
        releaseMeshResources(lease);
    });

    it("rejects cross-engine leases and reinsertion without partial scene mutation", () => {
        const { engine, scene, mesh } = fixture();
        const other = fixture();
        addToScene(scene, mesh);
        expect(() => retainMeshResources(other.engine, mesh)).toThrow(/different engine/);
        const lease = retainMeshResources(engine, mesh);
        expect(() => detachMeshFromScene(other.scene, mesh)).toThrow(/this engine/);
        expect(() => addToScene(other.scene, mesh)).toThrow(/different engine/);
        expect(other.scene.meshes).toHaveLength(0);
        releaseMeshResources(lease);
    });

    it("recovers detached geometry once and keeps a clone sharing its replacement", async () => {
        const { engine, scene, mesh } = fixture();
        const clone = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        const old = mesh._gpu;
        const replacement = fixture();
        engine._device = replacement.engine._device;
        await rebuildRegisteredScenes(engine);
        expect(mesh._gpu).not.toBe(old);
        const replacementGpu = mesh._gpu;
        await _rebuildMeshes(engine, { meshes: [clone, mesh] } as SceneContext);
        expect(clone._gpu).toBe(replacementGpu);
        expect(mesh._gpu).toBe(replacementGpu);
        expect(replacementGpu._refCount).toBe(2);
        expect(replacement.createBuffer).toHaveBeenCalledTimes(8); // four fixture buffers + four recovered buffers
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(replacementGpu.positionBuffer.destroy).not.toHaveBeenCalled();
        removeFromScene(scene, clone);
        await waitForGpuResourceRetirements(engine);
        expect(replacementGpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("retains ownership after its scene is disposed and keeps shared update guards", async () => {
        const { engine, scene, mesh } = fixture();
        const clone = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        addToScene(scene, clone);
        const lease = retainMeshResources(engine, mesh);
        expect(() => updateMeshGeometryCapacity(engine, mesh, mesh._cpuPositions!, mesh._cpuNormals!, mesh._cpuIndices!)).toThrow(/unshared/);
        disposeScene(scene);
        expect(clone._disposed).toBe(true);
        expect(mesh._disposed).not.toBe(true);
        expect(mesh._gpu._refCount).toBe(1);
        expect(() => detachMeshFromScene(scene, mesh)).toThrow(/disposed scene/);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
        expect(mesh._gpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("retains shared and nested shader material textures through detached swaps", async () => {
        const { engine, scene, mesh } = fixture();
        const texture = (): Texture2D => ({
            texture: stub<GPUTexture>({ destroy: vi.fn() }),
            view: stub<GPUTextureView>({}),
            sampler: stub<GPUSampler>({}),
            width: 1,
            height: 1,
        });
        const first = texture();
        const next = texture();
        acquireTexture(first);
        acquireTexture(next);
        const material = createStandardMaterial();
        material.diffuseTexture = first;
        mesh.material = material;
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        expect(_textureOwners(first)).toBe(2);
        detachMeshFromScene(scene, mesh);
        releaseTexture(first);
        await waitForGpuResourceRetirements(engine);
        expect(first.texture.destroy).not.toHaveBeenCalled();
        const swapped = createShaderMaterial({
            vertexSource: wgsl`@vertex fn vertexMain(@location(0) position: vec3f) -> @builtin(position) vec4f { return vec4f(position, 1); }`,
            fragmentSource: wgsl`@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
            samplers: ["image"],
        });
        setShaderTexture(swapped, "image", next);
        mesh.material = swapped;
        expect(_textureOwners(next)).toBe(2);
        expect(scene._materialSwapQueue).toHaveLength(0);
        releaseTexture(next);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(first.texture.destroy).toHaveBeenCalledOnce();
        expect(next.texture.destroy).toHaveBeenCalledOnce();
    });

    it("rejects reentrant plugin enumeration without taking a partial resource claim", () => {
        const { engine, mesh } = fixture();
        const texture: Texture2D = {
            texture: stub<GPUTexture>({ destroy: vi.fn() }),
            view: stub<GPUTextureView>({}),
            sampler: stub<GPUSampler>({}),
            width: 1,
            height: 1,
        };
        acquireTexture(texture);
        const material = createStandardMaterial();
        material.diffuseTexture = texture;
        material.plugins = [
            {
                name: "reentrant",
                getActiveTextures: () => {
                    retainMeshResources(engine, mesh);
                },
            },
        ];
        mesh.material = material;
        expect(() => retainMeshResources(engine, mesh)).toThrow(/reenter/);
        expect(_textureOwners(texture)).toBe(1);
        expect(engine._retainedMeshes).toBeUndefined();
        material.plugins = [];
        const lease = retainMeshResources(engine, mesh);
        expect(_textureOwners(texture)).toBe(2);
        releaseMeshResources(lease);
    });
});
