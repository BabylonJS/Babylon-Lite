import { describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import { disposeEngine } from "../../../packages/babylon-lite/src/engine/engine-dispose.js";
import { waitForGpuResourceRetirements } from "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { initMeshTransform, uploadMeshToGPU, type Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import { retainMeshResources, releaseMeshResources, detachMeshFromScene } from "../../../packages/babylon-lite/src/mesh/mesh-retention.js";
import { addToScene, buildScene, disposeScene, type SceneChangeEvent, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap.js";
import { createSceneAccessibility, disposeSceneAccessibility, getAccessibilityNode } from "../../../packages/babylon-lite/src/accessibility/scene-accessibility.js";
import { onSceneChange } from "../../../packages/babylon-lite/src/scene/scene-change.js";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove.js";
import { setMeshVisible } from "../../../packages/babylon-lite/src/scene/scene.js";
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
import { rebuildMaterial } from "../../../packages/babylon-lite/src/material/material-rebuild.js";
import { resolvePendingTaskMeshes } from "../../../packages/babylon-lite/src/frame-graph/render-task-transaction.js";
import { setShadowTaskCasterMeshes, _getShadowTaskCasterMeshes } from "../../../packages/babylon-lite/src/frame-graph/shadow-inputs.js";
import { createShadowTask } from "../../../packages/babylon-lite/src/frame-graph/shadow-task.js";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator.js";
import type { LightBase } from "../../../packages/babylon-lite/src/light/types.js";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { getPbrGroupBuilder } from "../../../packages/babylon-lite/src/material/pbr/pbr-group-builder.js";
import { getShaderGroupBuilder } from "../../../packages/babylon-lite/src/material/shader/shader-group-builder.js";
import type * as PbrRenderable from "../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js";

type BuildPbrRenderables = typeof PbrRenderable.buildPbrRenderables;
const pbrBuild = vi.hoisted(() => ({ fn: null as ((...args: Parameters<BuildPbrRenderables>) => ReturnType<BuildPbrRenderables>) | null }));
vi.mock("../../../packages/babylon-lite/src/material/pbr/pbr-renderable.js", async (importOriginal) => {
    const original = await importOriginal<typeof PbrRenderable>();
    return {
        ...original,
        buildPbrRenderables: (...args: Parameters<BuildPbrRenderables>) => (pbrBuild.fn ?? original.buildPbrRenderables)(...args),
    };
});

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

async function collectGarbage(): Promise<void> {
    setFlagsFromString("--expose_gc");
    const collect = runInNewContext("gc") as () => void;
    try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (let attempt = 0; attempt < 20; attempt++) {
            collect();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        setFlagsFromString("--no-expose_gc");
    }
}

function freshMesh(engine: EngineContext, name: string): Mesh {
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    return initMeshTransform({
        name,
        material: createStandardMaterial(),
        receiveShadows: false,
        boundMin: [-1, -1, 0],
        boundMax: [1, 1, 0],
        _cpuPositions: positions,
        _cpuNormals: normals,
        _cpuIndices: indices,
        _gpu: uploadMeshToGPU(engine, positions, normals, indices),
    });
}

function stubScene(surface: SceneContext["surface"]): SceneContext {
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

function fixture() {
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        const bytes = new ArrayBuffer(Number(descriptor.size));
        return stub<GPUBuffer>({ destroy: vi.fn(), getMappedRange: () => bytes, unmap: () => undefined });
    });
    const device = stub<GPUDevice>({ createBuffer, queue: stub<GPUQueue>({ onSubmittedWorkDone: async () => undefined }), destroy: vi.fn() });
    const surface = stub<SceneContext["surface"]>({ _renderingContexts: [], _context: stub<GPUCanvasContext>({ unconfigure: vi.fn() }) });
    const engine = stub<EngineContext>({ _device: device, surfaces: [surface], _surfaces: [surface], _animFrameId: 0, _renderFn: null });
    Object.defineProperty(surface, "engine", { value: engine });
    const scene = stubScene(surface);
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
    it("commits current admission order when detach/reinsert races an awaited PBR material rebuild", async () => {
        const { engine, scene, mesh: first } = fixture();
        const second = cloneTransformNode(first) as typeof first;
        let entered!: () => void;
        let resume!: () => void;
        const waiting = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (resume = resolve));
        let calls = 0;
        const builder: MeshGroupBuilder = async (_scene, meshes) => {
            if (++calls === 1) {
                entered();
                await gate;
            }
            return {
                renderables: meshes.map((mesh) => ({ order: 1, mesh }) as never),
                rebuildSingle: (mesh) => ({ order: 1, mesh }) as never,
            };
        };
        builder._materialFamily = "pbr";
        Object.defineProperty(first.material, "_buildGroup", { value: builder });
        addToScene(scene, first);
        addToScene(scene, second);
        scene._built = true;
        scene._frameGraph.build = vi.fn();
        const lease = retainMeshResources(engine, first);
        const pending = rebuildMaterial(scene, first.material);
        await waiting;
        detachMeshFromScene(scene, first);
        addToScene(scene, first);
        expect(scene.meshes).toEqual([second, first]);
        resume();
        await pending;
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([second, first]);
        expect(scene._materialSwapQueue).toContain(first);
        disposeScene(scene);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
    });
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
    it("enforces duplicate admission only on engines with live leases and restores legacy admission after the final lease", () => {
        const first = fixture();
        const second = fixture();
        const firstLease = retainMeshResources(first.engine, first.mesh);
        addToScene(first.scene, first.mesh);
        addToScene(first.scene, first.mesh);
        expect(first.scene.meshes).toHaveLength(1);
        addToScene(second.scene, second.mesh);
        addToScene(second.scene, second.mesh);
        expect(second.scene.meshes).toHaveLength(2);
        const secondLease = retainMeshResources(second.engine, second.mesh);
        releaseMeshResources(firstLease);
        addToScene(first.scene, first.mesh);
        expect(first.scene.meshes).toHaveLength(2);
        addToScene(second.scene, second.mesh);
        expect(second.scene.meshes).toHaveLength(2);
        releaseMeshResources(secondLease);
        addToScene(second.scene, second.mesh);
        expect(second.scene.meshes).toHaveLength(3);
    });

    it("keeps the same geometry through 1000 detached retirement fences and fresh admissions", async () => {
        const { engine, scene, mesh, createBuffer } = fixture();
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        const gpu = mesh._gpu;
        const parent = createTransformNode("parent");
        mesh.parent = parent;
        setMeshVisible(mesh, false);
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

    it("publishes detach and reinsertion to scene-change subscribers without echoing retained children", () => {
        const { engine, scene, mesh } = fixture();
        const child = fixture().mesh;
        child.parent = mesh;
        mesh.children.push(child);
        const light = createHemisphericLight([0, 1, 0], 1);
        mesh.children.push(light);
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        const events: SceneChangeEvent[] = [];
        const unsubscribe = onSceneChange(scene, (event) => events.push(event));
        detachMeshFromScene(scene, mesh);
        expect(events).toEqual([{ type: "removed", entity: mesh }]);
        events.length = 0;
        addToScene(scene, mesh);
        expect(events).toEqual([{ type: "added", entity: mesh }]);
        unsubscribe();
        releaseMeshResources(lease);
    });

    it("seeds late scene-change subscriptions from physical membership so a detached child's reinsertion publishes", async () => {
        const { engine, scene, mesh: parent } = fixture();
        const child = freshMesh(engine, "child");
        child.parent = parent;
        parent.children.push(child);
        addToScene(scene, parent);
        const lease = retainMeshResources(engine, child);
        detachMeshFromScene(scene, child);
        expect(child.parent).toBe(parent);

        const events: SceneChangeEvent[] = [];
        const unsubscribe = onSceneChange(scene, (event) => events.push(event));
        const accessibility = createSceneAccessibility(scene);
        expect(getAccessibilityNode(accessibility, parent)).toBeDefined();
        expect(getAccessibilityNode(accessibility, child)).toBeUndefined();

        addToScene(scene, child);
        expect(events).toEqual([{ type: "added", entity: child }]);
        await Promise.resolve();
        expect(getAccessibilityNode(accessibility, child)).toBeDefined();

        disposeSceneAccessibility(accessibility);
        unsubscribe();
        releaseMeshResources(lease);
    });

    it("cancels a group emptied by detach before registration and builds the reinserted mesh at runtime", async () => {
        const { engine, scene, mesh } = fixture();
        const builder: MeshGroupBuilder = vi.fn(async (_scene: SceneContext, meshes: Mesh[]) => {
            // Mirrors real group builders, which read the first member's material.
            void meshes[0]!.material;
            return {
                renderables: meshes.map((member) => ({ order: 1, mesh: member }) as never),
                rebuildSingle: (_target: SceneContext, member: Mesh) => ({ order: 1, mesh: member }) as never,
            };
        });
        builder._materialFamily = "pbr";
        Object.defineProperty(mesh.material, "_buildGroup", { value: builder });
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);

        await buildScene(scene);
        expect(builder).not.toHaveBeenCalled();
        expect(scene._groups.has(builder)).toBe(false);
        expect(scene._renderables).toEqual([]);

        addToScene(scene, mesh);
        await processMaterialSwaps(scene);
        expect(builder).toHaveBeenCalledOnce();
        expect([...scene._groups.get(builder)!]).toEqual([mesh]);
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([mesh]);

        disposeScene(scene);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
    });

    it("evicts a mesh detached while its boot PBR group build awaits and rebuilds it on reinsertion", async () => {
        const { engine, scene, mesh } = fixture();
        const teardowns = new Map<Mesh, ReturnType<typeof vi.fn>>();
        const rebuildSingle = (target: SceneContext, member: Mesh) => {
            const dispose = vi.fn();
            teardowns.set(member, dispose);
            target._meshDisposables.set(member, [dispose]);
            return { order: 1, mesh: member } as never;
        };
        const build = vi.fn(async (target: SceneContext, meshes: Mesh[]) => {
            // The real PBR build dereferences its first member's material.
            void meshes[0]!.material!._buildGroup;
            return { renderables: meshes.map((member) => rebuildSingle(target, member)), rebuildSingle };
        });
        pbrBuild.fn = build;
        const builder = getPbrGroupBuilder();
        Object.defineProperty(mesh.material, "_buildGroup", { value: builder });
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);

        try {
            // The PBR group builder yields to its lazy renderable import before delegating.
            const registration = buildScene(scene);
            detachMeshFromScene(scene, mesh);
            await registration;
            expect(build).toHaveBeenCalledWith(scene, [mesh], undefined);
            expect(scene._renderables).toEqual([]);
            expect(scene._groups.get(builder)!.o).toEqual([]);
            expect(scene._meshDisposables.has(mesh)).toBe(false);
            const evicted = teardowns.get(mesh)!;
            await waitForGpuResourceRetirements(engine);
            expect(evicted).toHaveBeenCalledOnce();

            addToScene(scene, mesh);
            await processMaterialSwaps(scene);
            expect(build).toHaveBeenCalledOnce();
            expect(scene._renderables.map((draw) => draw.mesh)).toEqual([mesh]);
            expect(teardowns.get(mesh)).not.toBe(evicted);
        } finally {
            pbrBuild.fn = null;
            disposeScene(scene);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
        }
    });

    it("builds a mesh that joins a boot group while its build awaits exactly once", async () => {
        const { engine, scene, mesh: first } = fixture();
        const second = cloneTransformNode(first) as typeof first;
        let entered!: () => void;
        let resume!: () => void;
        const waiting = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (resume = resolve));
        const builder: MeshGroupBuilder = vi.fn(async (_target: SceneContext, meshes: Mesh[]) => {
            entered();
            await gate;
            return {
                renderables: meshes.map((member) => ({ order: 1, mesh: member }) as never),
                rebuildSingle: (_scene: SceneContext, member: Mesh) => ({ order: 1, mesh: member }) as never,
            };
        });
        Object.defineProperty(first.material, "_buildGroup", { value: builder });
        addToScene(scene, first);

        const registration = buildScene(scene);
        await waiting;
        addToScene(scene, second);
        resume();
        await registration;
        expect(builder).toHaveBeenCalledOnce();
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([first, second]);
        expect(scene._groups.get(builder)!.o!.map((draw) => draw.mesh)).toEqual([first, second]);

        disposeScene(scene);
        await waitForGpuResourceRetirements(engine);
    });

    it("builds a mesh re-materialed into another family during the boot shader group build through its current family", async () => {
        const { engine, scene, mesh } = fixture();
        mesh.material = createShaderMaterial({
            vertexSource: wgsl`@vertex fn vertexMain(@location(0) position: vec3f) -> @builtin(position) vec4f { return vec4f(position, 1); }`,
            fragmentSource: wgsl`@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1); }`,
            attributes: ["position"],
        });
        const shaderBuilder = getShaderGroupBuilder();
        expect(mesh.material._buildGroup).toBe(shaderBuilder);
        const standard = createStandardMaterial();
        const standardBuilder: MeshGroupBuilder = vi.fn(async (_target: SceneContext, meshes: Mesh[]) => ({
            renderables: meshes.map((member) => ({ order: 1, mesh: member, material: member.material }) as never),
            rebuildSingle: (_scene: SceneContext, member: Mesh) => ({ order: 1, mesh: member, material: member.material }) as never,
        }));
        Object.defineProperty(standard, "_buildGroup", { value: standardBuilder });
        addToScene(scene, mesh);
        const lease = retainMeshResources(engine, mesh);

        try {
            // The real shader group builder snapshots [mesh] and yields to its lazy renderable import; when it
            // resumes it reads the mesh's NEW StandardMaterial as a ShaderMaterial and throws.
            const registration = buildScene(scene);
            detachMeshFromScene(scene, mesh);
            mesh.material = standard;
            addToScene(scene, mesh);
            await registration;
            expect(scene._groups.has(shaderBuilder)).toBe(false);
            expect(standardBuilder).toHaveBeenCalledOnce();
            expect(standardBuilder).toHaveBeenCalledWith(scene, [mesh]);
            expect(scene._renderables).toEqual([{ order: 1, mesh, material: standard }]);
        } finally {
            disposeScene(scene);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
        }
    });

    it("rebuilds a boot group in current admission order when a member is detached and reinserted while it awaits", async () => {
        const { engine, scene, mesh: first } = fixture();
        const second = cloneTransformNode(first) as typeof first;
        const teardowns: ReturnType<typeof vi.fn>[] = [];
        const rebuildSingle = (target: SceneContext, member: Mesh) => {
            const dispose = vi.fn();
            teardowns.push(dispose);
            target._meshDisposables.set(member, [dispose]);
            return { order: 1, mesh: member } as never;
        };
        const build = vi.fn(async (target: SceneContext, meshes: Mesh[]) => ({ renderables: meshes.map((member) => rebuildSingle(target, member)), rebuildSingle }));
        pbrBuild.fn = build;
        const builder = getPbrGroupBuilder();
        Object.defineProperty(first.material, "_buildGroup", { value: builder });
        expect(second.material).toBe(first.material);
        addToScene(scene, first);
        addToScene(scene, second);
        const lease = retainMeshResources(engine, first);
        const freshScene = stubScene(scene.surface);

        try {
            // The PBR group builder yields to its lazy renderable import before reading its [first, second] snapshot.
            const registration = buildScene(scene);
            detachMeshFromScene(scene, first);
            addToScene(scene, first);
            await registration;
            expect(build.mock.calls.map(([, meshes]) => meshes)).toEqual([
                [first, second],
                [second, first],
            ]);
            expect(scene._renderables.map((draw) => draw.mesh)).toEqual([second, first]);
            expect(scene._groups.get(builder)!.o!.map((draw) => draw.mesh)).toEqual([second, first]);
            expect([...scene._meshDisposables.values()].flat()).toEqual(teardowns.slice(2));
            await waitForGpuResourceRetirements(engine);
            for (const superseded of teardowns.slice(0, 2)) {
                expect(superseded).toHaveBeenCalledOnce();
            }
            for (const current of teardowns.slice(2)) {
                expect(current).not.toHaveBeenCalled();
            }

            addToScene(freshScene, second);
            addToScene(freshScene, first);
            await buildScene(freshScene);
            expect(freshScene._renderables).toEqual(scene._renderables);
        } finally {
            pbrBuild.fn = null;
            disposeScene(freshScene);
            disposeScene(scene);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
        }
    });

    it("confirms an unchanged boot group through the removal snapshot runner without rebuilding", async () => {
        const { engine, scene, mesh: first } = fixture();
        const second = cloneTransformNode(first) as typeof first;
        const builder = vi.fn(async (_target: SceneContext, meshes: Mesh[]) => ({
            renderables: meshes.map((member) => ({ order: 1, mesh: member }) as never),
            rebuildSingle: (_scene: SceneContext, member: Mesh) => ({ order: 1, mesh: member }) as never,
        }));
        Object.defineProperty(first.material, "_buildGroup", { value: builder });
        const removed = freshMesh(engine, "removed");
        addToScene(scene, removed);
        removeFromScene(scene, removed);
        addToScene(scene, first);
        addToScene(scene, second);

        await buildScene(scene);
        expect(builder).toHaveBeenCalledTimes(1);
        expect(builder.mock.calls[0]![1]).toEqual([first, second]);
        expect(builder.mock.calls[0]![1]).not.toBe(scene._groups.get(builder));
        expect(scene._groups.get(builder)!.o).toBe((await builder.mock.results[0]!.value).renderables);
        expect(scene._renderables.map((draw) => draw.mesh)).toEqual([first, second]);

        disposeScene(scene);
        await waitForGpuResourceRetirements(engine);
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

    it("recovers mesh-local draw selections independently instead of sharing their replacement", async () => {
        const { engine, scene, mesh } = fixture();
        Object.assign(mesh._gpu, {
            _drawRangeSource: {
                positions: mesh._cpuPositions,
                normals: mesh._cpuNormals,
                indices: mesh._cpuIndices,
                indexCount: 3,
            },
        });
        const clone = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        addToScene(scene, clone);
        await _rebuildMeshes(engine, scene);
        expect(clone._gpu).not.toBe(mesh._gpu);
        expect(clone._gpu.positionBuffer).not.toBe(mesh._gpu.positionBuffer);
        expect(mesh._gpu._refCount).toBeUndefined();
        expect(clone._gpu._refCount).toBeUndefined();
        const originalGpu = mesh._gpu;
        const cloneGpu = clone._gpu;
        removeFromScene(scene, mesh);
        await waitForGpuResourceRetirements(engine);
        expect(originalGpu.positionBuffer.destroy).toHaveBeenCalledOnce();
        expect(cloneGpu.positionBuffer.destroy).not.toHaveBeenCalled();
        removeFromScene(scene, clone);
        await waitForGpuResourceRetirements(engine);
        expect(cloneGpu.positionBuffer.destroy).toHaveBeenCalledOnce();
    });

    it("drops a queued explicit render-task admission so a later recording cannot restore the detached draw", async () => {
        const { engine, scene, mesh } = fixture();
        const peer = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        addToScene(scene, peer);
        const rebuilt: unknown[] = [];
        const builder = mesh.material._buildGroup;
        const group = Object.assign([mesh, peer], { r: (_scene: SceneContext, target: typeof mesh) => (rebuilt.push(target), { order: 1, mesh: target }) });
        scene._groups.set(builder, group as never);
        // A fresh explicit task queued before its first recording (what addMeshToTask leaves behind).
        const task = {
            scene,
            _renderables: [],
            _opaqueBindings: [],
            _directBindings: [],
            _transparentBindings: [],
            _pendingMeshes: [] as { mesh: typeof mesh; material: typeof mesh.material }[],
        };
        task._pendingMeshes.push({ mesh, material: mesh.material }, { mesh: peer, material: peer.material });
        scene._frameGraph._tasks.push(task as never);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        expect(task._pendingMeshes.map((request) => request.mesh)).toEqual([peer]);
        resolvePendingTaskMeshes(task as never);
        expect(rebuilt).toEqual([peer]);
        expect(task._renderables.map((draw: { mesh: unknown }) => draw.mesh)).toEqual([peer]);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
    });

    it("stops a detached mesh casting through shadow generators' nested tasks until it is reinserted", async () => {
        const { engine, scene, mesh } = fixture();
        const peer = cloneTransformNode(mesh) as typeof mesh;
        addToScene(scene, mesh);
        addToScene(scene, peer);
        const casters = [mesh, peer];
        const seen: (readonly unknown[])[] = [];
        const sg = stub<ShadowGenerator>({
            _ensureShadowTaskState: vi.fn((_engine, _scene, casterMeshes) => {
                seen.push(casterMeshes);
                return { _task: { record() {}, execute: () => 0, dispose() {} }, _casterMeshes: casterMeshes } as never;
            }),
            _renderShadowMap: vi.fn(() => 0),
        });
        setShadowTaskCasterMeshes(sg, casters);
        await Promise.resolve();
        scene.lights.push(stub<LightBase>({ shadowGenerator: sg }));
        const task = createShadowTask(engine, scene);
        const frame = (): readonly unknown[] => (task.execute!(), seen[seen.length - 1]!);

        expect(frame()).toBe(casters);
        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        const filtered = frame();
        expect(filtered).toEqual([peer]);
        expect(frame()).toBe(filtered);
        expect(casters).toEqual([mesh, peer]);

        addToScene(scene, mesh);
        expect(frame()).toBe(casters);

        detachMeshFromScene(scene, mesh);
        releaseMeshResources(lease);
        await waitForGpuResourceRetirements(engine);
        expect(mesh._disposed).toBe(true);
        expect(frame()).toEqual([peer]);
    });

    it("does not keep finally released detached meshes alive for shadow exclusion", async () => {
        const { engine, scene, mesh: resident } = fixture();
        // An unbuilt fixture scene keeps its first group member reachable through the pending boot-time group builder.
        addToScene(scene, resident);
        const retire = async (index: number): Promise<WeakRef<Mesh>> => {
            const mesh = freshMesh(engine, `retired-${index}`);
            addToScene(scene, mesh);
            const lease = retainMeshResources(engine, mesh);
            detachMeshFromScene(scene, mesh);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
            expect(mesh._disposed).toBe(true);
            return new WeakRef(mesh);
        };
        const retired: WeakRef<Mesh>[] = [];
        for (let index = 0; index < 3; index++) {
            retired.push(await retire(index));
        }

        await collectGarbage();
        expect(retired.map((ref) => ref.deref())).toEqual([undefined, undefined, undefined]);
    });

    it("drops a stale filtered caster result once its caller array no longer needs filtering", async () => {
        const { engine, scene, mesh: resident } = fixture();
        addToScene(scene, resident);
        const casters: Mesh[] = [];
        const sg = stub<ShadowGenerator>({});
        setShadowTaskCasterMeshes(sg, casters);
        await Promise.resolve();
        const detached = freshMesh(engine, "detached");
        addToScene(scene, detached);
        const detachedLease = retainMeshResources(engine, detached);

        const warmAndRetireSurvivor = async (): Promise<WeakRef<Mesh>> => {
            const survivor = freshMesh(engine, "survivor");
            addToScene(scene, survivor);
            casters.push(detached, survivor);
            detachMeshFromScene(scene, detached);
            expect(_getShadowTaskCasterMeshes(sg, scene)).toEqual([survivor]);
            casters.length = 0;
            expect(_getShadowTaskCasterMeshes(sg, scene)).toBe(casters);
            const lease = retainMeshResources(engine, survivor);
            detachMeshFromScene(scene, survivor);
            releaseMeshResources(lease);
            await waitForGpuResourceRetirements(engine);
            expect(survivor._disposed).toBe(true);
            return new WeakRef(survivor);
        };
        const survivor = await warmAndRetireSurvivor();

        await collectGarbage();
        expect(survivor.deref()).toBeUndefined();
        releaseMeshResources(detachedLease);
    });

    it("reuses filtered shadow casters across unchanged frames without rebuilding them", async () => {
        const { engine, scene, mesh } = fixture();
        const peer = cloneTransformNode(mesh) as typeof mesh;
        const bystander = freshMesh(engine, "bystander");
        addToScene(scene, mesh);
        addToScene(scene, peer);
        addToScene(scene, bystander);
        const casters = [mesh, peer];
        const filter = vi.fn(Array.prototype.filter);
        Object.defineProperty(casters, "filter", { value: filter });
        const sg = stub<ShadowGenerator>({});
        setShadowTaskCasterMeshes(sg, casters);
        await Promise.resolve();

        const bystanderLease = retainMeshResources(engine, bystander);
        detachMeshFromScene(scene, bystander);
        releaseMeshResources(bystanderLease);
        await waitForGpuResourceRetirements(engine);
        for (let frame = 0; frame < 3; frame++) {
            expect(_getShadowTaskCasterMeshes(sg, scene)).toBe(casters);
        }
        expect(filter).not.toHaveBeenCalled();

        const lease = retainMeshResources(engine, mesh);
        detachMeshFromScene(scene, mesh);
        const filtered = _getShadowTaskCasterMeshes(sg, scene);
        expect(filtered).toEqual([peer]);
        for (let frame = 0; frame < 3; frame++) {
            expect(_getShadowTaskCasterMeshes(sg, scene)).toBe(filtered);
        }
        expect(filter).toHaveBeenCalledOnce();

        casters.push(bystander);
        expect(_getShadowTaskCasterMeshes(sg, scene)).toEqual([peer]);
        casters.splice(1, 1);
        expect(_getShadowTaskCasterMeshes(sg, scene)).toEqual([]);
        addToScene(scene, mesh);
        expect(_getShadowTaskCasterMeshes(sg, scene)).toEqual([mesh]);
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
