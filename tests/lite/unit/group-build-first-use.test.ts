import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { MeshGroupBuilder } from "../../../packages/babylon-lite/src/render/renderable.js";

// Removal and the first retention lease install the membership-revalidating group build runner module-wide.
// Each test loads a fresh module graph so the runner is first installed while a boot build is already awaiting.
const SRC = "../../../packages/babylon-lite/src";
let lite: {
    mesh: typeof import("../../../packages/babylon-lite/src/mesh/mesh.js");
    retention: typeof import("../../../packages/babylon-lite/src/mesh/mesh-retention.js");
    core: typeof import("../../../packages/babylon-lite/src/scene/scene-core.js");
    remove: typeof import("../../../packages/babylon-lite/src/scene/scene-remove.js");
    swaps: typeof import("../../../packages/babylon-lite/src/scene/scene-material-swap.js");
    standard: typeof import("../../../packages/babylon-lite/src/material/standard/create-standard-material.js");
    retirement: typeof import("../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js");
};

beforeEach(async () => {
    vi.resetModules();
    lite = {
        mesh: await import(`${SRC}/mesh/mesh.js`),
        retention: await import(`${SRC}/mesh/mesh-retention.js`),
        core: await import(`${SRC}/scene/scene-core.js`),
        remove: await import(`${SRC}/scene/scene-remove.js`),
        swaps: await import(`${SRC}/scene/scene-material-swap.js`),
        standard: await import(`${SRC}/material/standard/create-standard-material.js`),
        retirement: await import(`${SRC}/engine/gpu-resource-retirement.js`),
    };
});

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
    const material = lite.standard.createStandardMaterial();
    const teardowns = new Map<Mesh, ReturnType<typeof vi.fn>[]>();
    const rebuildSingle = (target: SceneContext, member: Mesh) => {
        const dispose = vi.fn();
        teardowns.set(member, [...(teardowns.get(member) ?? []), dispose]);
        target._meshDisposables.set(member, [dispose]);
        return { order: 1, mesh: member } as never;
    };
    // Mirrors real group builders: yield to a lazy import, then read the members (PBR dereferences the first).
    const builder: MeshGroupBuilder = vi.fn(async (target: SceneContext, meshes: Mesh[]) => {
        await Promise.resolve();
        void meshes[0]!.material;
        return { renderables: meshes.map((member) => rebuildSingle(target, member)), rebuildSingle };
    });
    builder._materialFamily = "pbr";
    Object.defineProperty(material, "_buildGroup", { value: builder });
    const createMesh = (name: string): Mesh => {
        const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
        const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        const indices = new Uint32Array([0, 1, 2]);
        return lite.mesh.initMeshTransform({
            name,
            material,
            receiveShadows: false,
            boundMin: [-1, -1, 0],
            boundMax: [1, 1, 0],
            _cpuPositions: positions,
            _cpuNormals: normals,
            _cpuIndices: indices,
            _gpu: lite.mesh.uploadMeshToGPU(engine, positions, normals, indices),
        });
    };
    return { engine, scene, builder, teardowns, createMesh };
}

describe("boot group builds when removal or retention first activates mid-build", () => {
    it("drops a group emptied by the first retained detach instead of rejecting registration", async () => {
        const { engine, scene, builder, createMesh } = fixture();
        const mesh = createMesh("sole");
        lite.core.addToScene(scene, mesh);

        const registration = lite.core.buildScene(scene);
        const lease = lite.retention.retainMeshResources(engine, mesh);
        lite.retention.detachMeshFromScene(scene, mesh);

        await expect(registration).resolves.toBeUndefined();
        expect(scene._groups.has(builder)).toBe(false);
        expect(scene._renderables).toEqual([]);
        expect(scene._meshDisposables.has(mesh)).toBe(false);

        lite.core.addToScene(scene, mesh);
        await lite.swaps.processMaterialSwaps(scene);
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([mesh]);

        lite.core.disposeScene(scene);
        lite.retention.releaseMeshResources(lease);
        await lite.retirement.waitForGpuResourceRetirements(engine);
    });

    it("rebuilds the survivors and retires the obsolete output when the first removal shrinks the group", async () => {
        const { engine, scene, builder, teardowns, createMesh } = fixture();
        const removed = createMesh("removed");
        const survivor = createMesh("survivor");
        lite.core.addToScene(scene, removed);
        lite.core.addToScene(scene, survivor);

        const registration = lite.core.buildScene(scene);
        lite.remove.removeFromScene(scene, removed);
        await registration;

        expect(builder).toHaveBeenCalledTimes(2);
        expect(vi.mocked(builder).mock.calls[1]![1]).toEqual([survivor]);
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([survivor]);
        expect(scene._groups.get(builder)!.o!.map((draw) => draw.mesh)).toEqual([survivor]);
        expect(teardowns.has(removed)).toBe(false);
        const [obsolete, current] = teardowns.get(survivor)!;
        expect(scene._meshDisposables.get(survivor)).toEqual([current]);
        await lite.retirement.waitForGpuResourceRetirements(engine);
        expect(obsolete).toHaveBeenCalledOnce();
        expect(current).not.toHaveBeenCalled();

        lite.core.disposeScene(scene);
        await lite.retirement.waitForGpuResourceRetirements(engine);
    });

    it("keeps an unchanged live build when retention activates without changing membership", async () => {
        const { engine, scene, builder, createMesh } = fixture();
        const mesh = createMesh("kept");
        lite.core.addToScene(scene, mesh);

        const registration = lite.core.buildScene(scene);
        const lease = lite.retention.retainMeshResources(engine, mesh);
        await registration;

        expect(builder).toHaveBeenCalledOnce();
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([mesh]);

        lite.core.disposeScene(scene);
        lite.retention.releaseMeshResources(lease);
        await lite.retirement.waitForGpuResourceRetirements(engine);
    });
});
