import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTask, RenderTaskConfig } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, MeshRebuildResources, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { RuntimeSceneBuildHooks, SceneContext, SceneMeshGroup } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import type { CsmConfig, CsmTaskState } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";

const created = vi.hoisted(() => ({ tasks: 0 }));

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/shadow/shadow-base")>()),
    createShadowCamera: () => ({}),
}));

// Cascade tasks without GPU targets. Their record runs the real task transaction (minus the target build): it resolves
// each queued caster through the group of the material its view reads, and throws for a group not built in the scene.
vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", async (importOriginal) => {
    const { transactRenderTask } = await import("../../../packages/babylon-lite/src/frame-graph/render-task-transaction");
    return {
        ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/frame-graph/render-task")>()),
        createRenderTask: (config: RenderTaskConfig, engine: EngineContext, scene: SceneContext) => {
            created.tasks++;
            const task = {
                name: config.name,
                engine,
                scene,
                _config: config,
                _renderables: [],
                _pendingMeshes: [],
                _opaqueBindings: [],
                _directBindings: [],
                _transparentBindings: [],
                _ob: [],
                _lastVersion: -1,
                _targetSignature: {},
                dispose: vi.fn(),
            } as unknown as RenderTask;
            task.record = () => transactRenderTask(task);
            return task;
        },
    };
});

// The runtime build the swap drain hands a mesh to when its material's group was never built in the scene (a module
// fetch, then shader compilation). It cannot run here; a case lands it with `buildLanded`.
vi.mock("../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build.js", () => ({ C: () => Promise.resolve() }));

/** Fresh copies of the modules under test, so the no-colour view factories a case imports never leak into another one. */
async function importLite() {
    vi.resetModules();
    // Finish the async partial mock before parallel imports can enter its real dependency graph.
    await import("../../../packages/babylon-lite/src/frame-graph/render-task");
    const [inputs, override, rebuild, registry, swaps, shadowTask, csm, cache] = await Promise.all([
        import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs"),
        import("../../../packages/babylon-lite/src/material/set-shadow-caster-material"),
        import("../../../packages/babylon-lite/src/material/material-rebuild"),
        import("../../../packages/babylon-lite/src/scene/mesh-scene-registry"),
        import("../../../packages/babylon-lite/src/scene/scene-material-swap"),
        import("../../../packages/babylon-lite/src/frame-graph/shadow-task"),
        import("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks"),
        import("../../../packages/babylon-lite/src/shadow/csm-shadow-cache"),
    ]);
    return {
        ...inputs,
        ...override,
        ...rebuild,
        ...registry,
        ...swaps,
        ...shadowTask,
        ...csm,
        ...cache,
    };
}

type Family = "standard" | "pbr" | "node" | "shader";

/** A material group builder. Standard materials share one; every NodeMaterial instance has its own. */
function group(family: Family): MeshGroupBuilder {
    return { _materialFamily: family } as unknown as MeshGroupBuilder;
}

/** Device-free material: the no-colour views of these families only wrap their source. */
function material(name: string, buildGroup: MeshGroupBuilder): Material {
    return { name, _buildGroup: buildGroup } as unknown as Material;
}

/** Complete a group's first build in the scene: its rebuild turns a (mesh, view) pair into a packet. A cascade packet
 *  owns one lifetime disposer, so each packet a cascade task retires counts once in the engine's retirements. */
function build(scene: SceneContext, buildGroup: MeshGroupBuilder): void {
    const rebuild = (_scene: SceneContext, mesh: Mesh, view?: Material, resources?: MeshRebuildResources) => {
        resources?._lifetimeDisposers.push(() => {});
        const packet = { mesh, _lastMaterial: view, order: 0, bind: () => ({ renderable: packet }) };
        return packet as unknown as Renderable;
    };
    scene._groups.set(buildGroup, { r: rebuild } as unknown as SceneMeshGroup);
}

/** A packet that owns GPU resources, as the packets of the real families do. */
interface OwningPacket {
    mesh: Mesh;
    /** How many times its resources were released. */
    released: number;
    /** For a cascade packet, the mesh's own renderable when the packet was built: its per-mesh resources. */
    uses?: OwningPacket;
}

/** Complete the first build of a group whose packets own GPU resources. A cascade packet releases its own behind the frame
 *  fence when its task drops it; a mesh's own renderable registers per-mesh resources, which `rebuildMaterial` retires
 *  behind the fence, and the cascade packets built meanwhile reference them. */
function buildOwning(scene: SceneContext, buildGroup: MeshGroupBuilder): void {
    const rebuild = (s: SceneContext, mesh: Mesh & { _own?: OwningPacket }, view?: Material, resources?: MeshRebuildResources) => {
        const packet = { mesh, _lastMaterial: view, order: 0, bind: () => ({ renderable: packet }), released: 0, uses: resources && mesh._own };
        const disposers = resources?._lifetimeDisposers ?? [];
        if (!resources) {
            s._meshDisposables.set(mesh, disposers);
            mesh._own = packet;
        }
        disposers.push(() => packet.released++);
        return packet as unknown as Renderable;
    };
    scene._groups.set(buildGroup, { r: rebuild } as unknown as SceneMeshGroup);
}

/** What the runtime build does when it lands (`materializeRuntimeMesh`): the group gets its rebuild, the mesh's material
 *  its next generation, and the renderable version and material epoch move. */
function buildLanded(scene: SceneContext, mesh: Mesh): void {
    build(scene, mesh.material!._buildGroup);
    mesh.material!._csmGen = (mesh.material!._csmGen ?? 0) + 1;
    scene._renderableVersion++;
    scene._materialEpoch++;
}

/** A queued runtime build is in flight: the swap drain waits for it, so swaps stay queued. */
function holdDrain(scene: SceneContext, held: boolean): void {
    scene._runtimeBuilds = held ? ({ w: true } as unknown as RuntimeSceneBuildHooks) : undefined;
}

/** What a cascade task draws once recorded: each caster with the material its depth view reads. */
function casts(task: RenderTask): [Mesh, Material][] {
    const recorded = task._renderables.map((packet) => [packet.mesh!, packet._lastMaterial as MaterialView] as const);
    const queued = task._pendingMeshes!.map(({ mesh, material: view }) => [mesh as Mesh, view as MaterialView] as const);
    return [...recorded, ...queued].map(([mesh, view]) => [mesh, view.source]);
}

/** What each cascade draws, across the overlay tasks and (with static caching) the static-cache tasks. */
function cascades(state: CsmTaskState): [Mesh, Material][][] {
    const statics = (state as { _staticTasks?: RenderTask[] })._staticTasks;
    return state._tasks.map((task, cascade) => [...casts(task), ...(statics ? casts(statics[cascade]!) : [])]);
}

/** The cascade tasks and (with static caching) the static-cache tasks. */
function allTasks(state: CsmTaskState): RenderTask[] {
    return [...state._tasks, ...((state as { _staticTasks?: RenderTask[] })._staticTasks ?? [])];
}

/** The packets every task of the state has recorded. */
function packets(state: CsmTaskState): OwningPacket[] {
    return allTasks(state).flatMap((task) => task._renderables as unknown as OwningPacket[]);
}

/** Recorded packets whose own resources, or the per-mesh resources they reference, were released. */
function released(state: CsmTaskState): OwningPacket[] {
    return packets(state).filter((packet) => packet.released || packet.uses?.released);
}

/** Record what each shadow draw would submit: the recorded packets whose resources were released by then. */
function drawsOf(sg: ShadowGenerator): OwningPacket[][] {
    const draws: OwningPacket[][] = [];
    vi.mocked(sg._renderShadowMap!).mockImplementation((_engine, taskState) => {
        draws.push(released(taskState as CsmTaskState));
        return 0;
    });
    return draws;
}

/** The depth view each cascade draws a recorded caster with. */
function cascadeViews(state: CsmTaskState, mesh: Mesh): (Material | undefined)[] {
    const statics = (state as { _staticTasks?: RenderTask[] })._staticTasks;
    return state._tasks.map((task, cascade) => [...task._renderables, ...(statics?.[cascade]!._renderables ?? [])].find((packet) => packet.mesh === mesh)?._lastMaterial);
}

/** Give every task of the state a recorded bundle and binding version; returns whether all of them are still in place. */
function stampBundles(state: CsmTaskState): () => boolean {
    const stamps = allTasks(state).map((task) => {
        const bundles = [{}] as unknown as RenderTask["_ob"];
        task._ob = bundles;
        task._lastVersion = 7;
        return [task, bundles, bundles[0]] as const;
    });
    return () => stamps.every(([task, bundles, bundle]) => task._ob === bundles && bundles.length === 1 && bundles[0] === bundle && task._lastVersion === 7);
}

const cfg = { _numCascades: 2, _mapSize: 64 } as CsmConfig;

/** A CSM generator in a scene whose frames drain material swaps and then run the real shadow task. */
async function setup(hooks: "default" | "cache") {
    const lite = await importLite();
    const ensure = hooks === "default" ? lite.ensureCsmShadowTaskState : lite.ensureCsmShadowCacheState;
    const createTexture = vi.fn(() => ({ createView: () => ({}), destroy: vi.fn() }));
    const engine = { _device: { createTexture } } as unknown as EngineContext;
    const sg = {
        _depthTexture: { createView: () => ({}) },
        _csmCache: { _refitAngle: 0.1, _refitMaxIntervalMs: 0 },
        _preloadShadowTask: lite.preloadCsmShadowTaskState,
        _renderShadowMap: vi.fn(() => 0),
    } as unknown as ShadowGenerator;
    sg._ensureShadowTaskState = (eng, scene, casterMeshes) => (sg._shadowTaskState = ensure(eng, scene, sg, cfg, casterMeshes, sg._shadowTaskState ?? null));
    const scene = {
        surface: { engine },
        lights: [{ shadowGenerator: sg }],
        meshes: [],
        _renderables: [],
        _renderableVersion: 1,
        _materialEpoch: 1,
        _groups: new Map(),
        _materialSwapQueue: [],
        _meshDisposables: new Map(),
        _disposables: [],
    } as unknown as SceneContext;
    // The scene renders ShaderMaterials: their group is built and their no-colour view factory imported, no other one.
    const shaders = group("shader");
    build(scene, shaders);
    await lite.preloadCsmShadowTaskState([{ material: material("preload", shaders) } as Mesh]);
    const shadowTask = lite.createShadowTask(engine, scene);
    return {
        lite,
        engine,
        scene,
        sg,
        shaders,
        createTexture,
        /** A scene mesh: assigning its `material` queues a swap, as for any mesh added to a scene. */
        caster: (casterMaterial: Material | null): Mesh => {
            const mesh = { material: casterMaterial, worldMatrixVersion: 1, thinInstances: null } as unknown as Mesh;
            lite.registerMeshScene(scene, mesh);
            scene.meshes.push(mesh);
            return mesh;
        },
        /** Supply the caster set and wait for the shadow task's preload to release the generator. */
        register: async (casterMeshes: readonly Mesh[]): Promise<void> => {
            lite.setShadowTaskCasterMeshes(sg, casterMeshes);
            await loaded(sg);
        },
        /** One frame: the swap drain, then the shadow task (the scene's order). */
        frame: (): void => {
            void lite.processMaterialSwaps(scene);
            shadowTask.execute!();
        },
        /** A frame-graph build recording the shadow task. */
        record: (): void => shadowTask.record(),
        /** The generator's ensure on its registered set, which the shadow task skips while the generator is parked. */
        ensure: (): void => void sg._ensureShadowTaskState!(engine, scene, lite._getShadowTaskCasterMeshes(sg)!),
        /** The fence behind a submitted frame: run the GPU resource retirements queued so far. */
        fence: (): void => {
            for (const retire of engine._retirements?.splice(0) ?? []) {
                retire();
            }
        },
        state: () => sg._shadowTaskState as CsmTaskState,
        retired: () => engine._retirements?.length ?? 0,
    };
}

/** Wait for the shadow task's preload to release the generator. */
async function loaded(sg: ShadowGenerator): Promise<void> {
    await vi.waitFor(() => expect(sg._preloadPending).toBeUndefined());
}

describe("a registered CSM caster that switches to a material the snapshot has never seen", () => {
    it("requeues the caster through the new material instead of keeping the old depth view", async () => {
        const { shaders, caster, register, frame, state, retired } = await setup("default");
        const after = material("after", shaders);
        const mesh = caster(material("before", shaders));
        await register([mesh]);
        frame();
        const first = state();
        const tasks = created.tasks;

        mesh.material = after;
        frame();

        // The cascade tasks stay; the caster's old packet in each of the two cascades retires behind the frame fence.
        expect(state()).toBe(first);
        expect(created.tasks).toBe(tasks);
        expect(retired()).toBe(2);
        expect(state()._tasks.map(casts)).toEqual([[[mesh, after]], [[mesh, after]]]);
        // The requeue snapshotted the new material, so the next frame neither requeues nor retires anything.
        frame();
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(state()._tasks.map(casts)).toEqual([[[mesh, after]], [[mesh, after]]]);
    });

    it.each(["default", "cache"] as const)("starts casting a registered caster that had no material when the %s set was supplied", async (hooks) => {
        const { shaders, caster, register, frame, state, retired, createTexture } = await setup(hooks);
        const mesh = caster(null);
        await register([mesh]);
        frame();
        const first = state();
        const tasks = created.tasks;
        const textures = createTexture.mock.calls.length;
        const late = material("late", shaders);

        mesh.material = late;
        frame();

        expect(state()).toBe(first);
        expect(created.tasks).toBe(tasks);
        expect(createTexture).toHaveBeenCalledTimes(textures);
        expect(retired()).toBe(0);
        expect(cascades(state())).toEqual([[[mesh, late]], [[mesh, late]]]);
        frame();
        expect(retired()).toBe(0);
        expect(cascades(state())).toEqual([[[mesh, late]], [[mesh, late]]]);
    });

    it("queues a caster that is new to the set and leaves the registered one's packets alone", async () => {
        const { shaders, caster, register, frame, state, retired } = await setup("default");
        const shared = material("shared", shaders);
        const fresh = material("fresh", shaders);
        const kept = caster(shared);
        const added = caster(fresh);
        await register([kept]);
        frame();
        const first = state();

        await register([kept, added]);
        frame();

        const both = [
            [kept, shared],
            [added, fresh],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(first._tasks.map(casts)).toEqual([both, both]);
        // Its material is snapshotted on the way in, so a later frame does not queue it again.
        frame();
        expect(state()).toBe(first);
        expect(first._tasks.map(casts)).toEqual([both, both]);
    });

    it("requeues it in the static-cache cascades too, keeping the cache texture and the caster's refit gate", async () => {
        const { shaders, caster, register, frame, state, retired, createTexture } = await setup("cache");
        const after = material("after", shaders);
        const mesh = caster(material("before", shaders));
        await register([mesh]);
        frame();
        const first = state();
        const gate = (first as unknown as { _gate: { isDynamic(mesh: Mesh): boolean } })._gate;

        mesh.material = after;
        frame();

        expect(state()).toBe(first);
        expect(createTexture).toHaveBeenCalledOnce();
        expect(retired()).toBe(2);
        // A caster the gate has not demoted yet is dynamic, so it casts through the overlay cascade tasks.
        expect(gate.isDynamic(mesh)).toBe(true);
        expect(cascades(state())).toEqual([[[mesh, after]], [[mesh, after]]]);
        frame();
        expect(retired()).toBe(2);
        expect(cascades(state())).toEqual([[[mesh, after]], [[mesh, after]]]);
    });
});

describe("a CSM caster material change that cannot be built yet", () => {
    // Each case brings a family no caster used so far, so its no-colour view factory has not been imported.
    it.each([
        ["default", "gets its first material", null, "standard", "swap"],
        ["cache", "gets its first material", null, "standard", "swap"],
        ["default", "switches to another material family", "shader", "node", "swap"],
        ["cache", "switches to another material family", "shader", "node", "swap"],
        ["default", "has its caster override re-pointed to another family", "shader", "pbr", "override"],
        ["cache", "has its caster override re-pointed to another family", "shader", "pbr", "override"],
    ] as const)("parks the generator and keeps the %s cascades while the view factory imports when a registered caster %s", async (hooks, _, from, to, change) => {
        const { lite, scene, sg, caster, register, frame, state, retired } = await setup(hooks);
        const before = from && material("before", group(from));
        if (before) {
            build(scene, before._buildGroup);
        }
        const mesh = caster(before);
        const casterMeshes = [mesh];
        await register(casterMeshes);
        frame();
        const first = state();
        const family = group(to);
        build(scene, family);
        const next = material("next", family);

        if (change === "swap") {
            mesh.material = next;
        } else {
            lite.setShadowCasterMaterial(before!, next);
        }
        expect(frame).not.toThrow();

        // The live cascades stay and the generator is parked on its registered set while the factory imports. The caster
        // leaves them: one that cast before retires its old packet in each cascade.
        const retiredPackets = before ? 2 : 0;
        expect(state()).toBe(first);
        expect(retired()).toBe(retiredPackets);
        expect(sg._preloadPending).toBe(casterMeshes);
        const renders = vi.mocked(sg._renderShadowMap!).mock.calls.length;
        frame();
        expect(sg._renderShadowMap).toHaveBeenCalledTimes(renders);

        await loaded(sg);
        frame();

        // Requeued in the same cascade tasks.
        expect(state()).toBe(first);
        expect(retired()).toBe(retiredPackets);
        expect(cascades(state())).toEqual([[[mesh, next]], [[mesh, next]]]);
        frame();
        expect(retired()).toBe(retiredPackets);
        expect(cascades(state())).toEqual([[[mesh, next]], [[mesh, next]]]);
    });

    // A NodeMaterial instance has a group of its own: switching a caster to a new one hands the mesh to the runtime build.
    it.each(["default", "cache"] as const)("keeps the %s cascades without the caster and creates nothing while the new material's group is building", async (hooks) => {
        const { scene, caster, register, frame, state, retired, createTexture } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        frame();
        const first = state();
        const tasks = created.tasks;
        const textures = createTexture.mock.calls.length;
        const next = material("next", group("node"));

        mesh.material = next;
        expect(frame).not.toThrow();
        expect(frame).not.toThrow();

        // The drain handed the mesh to the runtime build, so nothing is queued any more: only the group is missing. The
        // caster's packets may reference resources retired with its old material, so it stays out until it is requeued:
        // its old packet in each cascade retires.
        expect(scene._materialSwapQueue).toEqual([]);
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(created.tasks).toBe(tasks);
        expect(createTexture).toHaveBeenCalledTimes(textures);
        expect(first._tasks.map(casts)).toEqual([[], []]);

        buildLanded(scene, mesh);
        frame();

        // Requeued: still no task or texture is created, and nothing more retires.
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(created.tasks).toBe(tasks);
        expect(createTexture).toHaveBeenCalledTimes(textures);
        expect(state()._tasks.map(casts)).toEqual([[[mesh, next]], [[mesh, next]]]);
        frame();
        expect(retired()).toBe(2);
        expect(state()._tasks.map(casts)).toEqual([[[mesh, next]], [[mesh, next]]]);
    });

    it("does not wait for a caster override whose group is not built in the scene", async () => {
        const { lite, sg, shaders, caster, register, frame } = await setup("default");
        const receive = material("receive", shaders);
        await register([caster(receive)]);
        frame();

        // Nothing builds the group of a NodeMaterial that renders no mesh of the scene, so waiting for it would hold the
        // cascades forever without a word. Once its view factory is imported, the caster pass fails loudly instead, as it
        // always has.
        lite.setShadowCasterMaterial(receive, material("unassigned", group("node")));
        frame();
        await loaded(sg);

        expect(frame).toThrow("Material group has not completed its initial build in this scene.");
    });

    it("parks the generator once however many registered casters wait for the same view factory", async () => {
        const { scene, sg, shaders, caster, register, frame } = await setup("default");
        const casterMeshes = [caster(material("a", shaders)), caster(material("b", shaders)), caster(material("c", shaders))];
        await register(casterMeshes);
        frame();
        const preload = vi.fn(sg._preloadShadowTask!);
        sg._preloadShadowTask = preload;
        const standard = group("standard");
        build(scene, standard);

        // One preload of the registered set imports the factory for all of them, so a second one would only walk the set
        // again (and report a failed import once more).
        for (const mesh of casterMeshes) {
            mesh.material = material(`standard ${mesh.material!.name}`, standard);
        }
        frame();

        expect(sg._preloadPending).toBe(casterMeshes);
        expect(preload).toHaveBeenCalledTimes(1);
        await loaded(sg);
    });
});

describe("caster-set changes while a CSM caster material change is held", () => {
    it.each(["default", "cache"] as const)("updates the %s cascades for removed and added casters while a caster's new group is building", async (hooks) => {
        const { scene, shaders, caster, register, frame, state, retired } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const building = caster(before);
        const removed = caster(material("removed", shaders));
        await register([building, removed]);
        frame();
        const first = state();
        const next = material("next", group("node"));
        building.material = next;
        frame();

        // The application drops a caster (to dispose it, say) and adds another while the runtime build has not landed.
        const addedMaterial = material("added", shaders);
        const added = caster(addedMaterial);
        await register([building, added]);
        frame();

        // The requeue waits for `building`, which stays out until then; the set change does not wait. The old packets of
        // `building` and of the removed caster retire, one in each cascade.
        const held = [[added, addedMaterial]];
        expect(state()).toBe(first);
        expect(retired()).toBe(4);
        expect(cascades(state())).toEqual([held, held]);

        buildLanded(scene, building);
        frame();

        // `building` is requeued behind the packets the cascades kept.
        const requeued = [
            [added, addedMaterial],
            [building, next],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(4);
        expect(cascades(state())).toEqual([requeued, requeued]);
    });

    it.each(["default", "cache"] as const)("keeps a held caster out of the %s cascades and applies its new cap when it is requeued", async (hooks) => {
        const { lite, scene, caster, register, frame, record, state } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        frame();
        const first = state();
        const next = material("next", group("node"));
        mesh.material = next;
        frame();

        // Re-capping would re-add the caster through its new material, whose group cannot record yet.
        lite.setShadowCasterMaxCascade(mesh, 0);
        await register([mesh]);
        expect(frame).not.toThrow();
        expect(record).not.toThrow();

        expect(state()).toBe(first);
        expect(cascades(state())).toEqual([[], []]);

        buildLanded(scene, mesh);
        frame();

        expect(cascades(state())).toEqual([[[mesh, next]], []]);
    });

    it.each(["default", "cache"] as const)("keeps a caster new to the set out of the %s cascades until the override it shares can be built", async (hooks) => {
        const { lite, scene, sg, shaders, caster, register, frame, state, retired } = await setup(hooks);
        const receive = material("receive", shaders);
        const registered = caster(receive);
        const added = caster(receive);
        await register([registered]);
        frame();
        const first = state();
        const pbr = group("pbr");
        build(scene, pbr);
        const override = material("override", pbr);

        // The set grows while the override of the shared material is re-pointed to a family whose view factory is not
        // imported yet. Adding the new caster through the cached view would snapshot the re-pointed override as built.
        const casterMeshes = [registered, added];
        await register(casterMeshes);
        lite.setShadowCasterMaterial(receive, override);
        expect(frame).not.toThrow();

        // The registered caster's override changed, so it stays out of the cascades as well: its old packets retire.
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(sg._preloadPending).toBe(casterMeshes);
        expect(cascades(state())).toEqual([[], []]);

        await loaded(sg);
        frame();

        const both = [
            [registered, override],
            [added, override],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(cascades(state())).toEqual([both, both]);
    });
});

describe("casters whose material changed while a CSM caster change is held", () => {
    it.each(["default", "cache"] as const)("requeues the %s casters of a rebuilt material at once, and a caster added during the hold shares its fresh view", async (hooks) => {
        const { lite, scene, shaders, caster, register, frame, state, retired } = await setup(hooks);
        const shared = material("shared", shaders);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const kept = caster(shared);
        const building = caster(before);
        await register([kept, building]);
        frame();
        const first = state();
        const staleView = first._materialViews.get(shared);
        /** The depth view each cascade draws `mesh` with. */
        const viewsOf = (mesh: Mesh) => cascadeViews(state(), mesh);

        // `shared` is rebuilt while `building` switches to a NodeMaterial whose group is still building. Only `building`
        // waits and stays out: the hold is per caster, so `kept` is requeued through a fresh view at once.
        lite.rebuildMaterial(scene, shared);
        building.material = material("next", group("node"));
        frame();

        const freshView = state()._materialViews.get(shared)!;
        expect(freshView).not.toBe(staleView);
        const requeued = [[kept, shared]];
        expect(state()).toBe(first);
        expect(retired()).toBe(4); // the old packets of both casters, one in each cascade
        expect(cascades(state())).toEqual([requeued, requeued]);
        expect(viewsOf(kept)).toEqual([freshView, freshView]);

        // A caster sharing the rebuilt material joins the set: it is queued through the same fresh view.
        const added = caster(shared);
        await register([kept, building, added]);
        frame();

        const both = [
            [kept, shared],
            [added, shared],
        ];
        expect(retired()).toBe(4);
        expect(cascades(state())).toEqual([both, both]);
        expect(viewsOf(added)).toEqual([freshView, freshView]);

        await register([kept, added]);
        frame();

        expect(state()).toBe(first);
        expect(retired()).toBe(4);
        expect(cascades(state())).toEqual([both, both]);
        expect(viewsOf(kept)).toEqual([freshView, freshView]);
    });

    it.each(["default", "cache"] as const)("keeps a caster new to the set out of the %s cascades while its material's group is building", async (hooks) => {
        const { scene, shaders, caster, register, frame, record, state, retired } = await setup(hooks);
        const keptMaterial = material("kept", shaders);
        const kept = caster(keptMaterial);
        await register([kept]);
        frame();
        const first = state();

        // A NodeMaterial instance has a group of its own, which the runtime build has not built yet.
        const next = material("next", group("node"));
        const added = caster(next);
        await register([kept, added]);
        expect(frame).not.toThrow();
        expect(record).not.toThrow();

        expect(cascades(state())).toEqual([[[kept, keptMaterial]], [[kept, keptMaterial]]]);

        // Once the build lands, the hold lifts and the caster is queued.
        buildLanded(scene, added);
        frame();

        const both = [
            [kept, keptMaterial],
            [added, next],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(cascades(state())).toEqual([both, both]);
    });

    it.each(["default", "cache"] as const)("keeps both out of the %s cascades when a registered and a new caster switch to the same building material", async (hooks) => {
        const { scene, caster, register, frame, record, state, retired } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const switching = caster(before);
        await register([switching]);
        frame();
        const first = state();
        const next = material("next", group("node"));
        switching.material = next;
        frame();

        const added = caster(next);
        await register([switching, added]);
        expect(frame).not.toThrow();
        expect(record).not.toThrow();

        expect(state()).toBe(first);
        expect(retired()).toBe(2); // the registered caster's old packet in each cascade
        expect(cascades(state())).toEqual([[], []]);

        buildLanded(scene, switching);
        frame();

        const both = [
            [switching, next],
            [added, next],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(cascades(state())).toEqual([both, both]);
    });

    it.each(["default", "cache"] as const)("adds a caster new to the %s cascades once the view factory of the material it got before its first frame imports", async (hooks) => {
        const { scene, sg, shaders, caster, register, frame, state, retired } = await setup(hooks);
        const keptMaterial = material("kept", shaders);
        const kept = caster(keptMaterial);
        await register([kept]);
        frame();
        const first = state();
        const added = caster(material("placeholder", shaders));
        const casterMeshes = [kept, added];
        await register(casterMeshes);

        // The real material arrives before the caster's first shadow frame, from a family whose view factory is not
        // imported yet. The import bumps no version, so nothing else would run the diff that adds the caster.
        const standard = group("standard");
        build(scene, standard);
        const real = material("real", standard);
        added.material = real;
        expect(frame).not.toThrow();

        expect(sg._preloadPending).toBe(casterMeshes);
        expect(cascades(state())).toEqual([[[kept, keptMaterial]], [[kept, keptMaterial]]]);

        await loaded(sg);
        frame();

        const both = [
            [kept, keptMaterial],
            [added, real],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(cascades(state())).toEqual([both, both]);
    });

    it.each(["default", "cache"] as const)("applies a held caster's new %s cap when its material change is reverted while held", async (hooks) => {
        const { lite, scene, caster, register, frame, state } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        frame();
        const first = state();

        // The drain waits for an in-flight runtime build, so the swaps below stay queued and bump no generation.
        holdDrain(scene, true);
        mesh.material = material("next", group("node"));
        frame();
        lite.setShadowCasterMaxCascade(mesh, 0);
        await register([mesh]);
        expect(frame).not.toThrow();

        // Reverting the switch ends the hold; the cap re-supplied meanwhile still applies.
        mesh.material = before;
        frame();

        expect(state()).toBe(first);
        expect(cascades(state())).toEqual([[[mesh, before]], []]);
    });

    it.each(["default", "cache"] as const)("puts a held %s caster back on the cached view of the material it shares when its switch is reverted", async (hooks) => {
        const { scene, caster, register, frame, state, retired } = await setup(hooks);
        const shared = material("shared", group("node"));
        build(scene, shared._buildGroup);
        const kept = caster(shared);
        const reverted = caster(shared);
        await register([kept, reverted]);
        frame();
        const first = state();
        const view = first._materialViews.get(shared);

        // The drain waits for an in-flight runtime build, so the swaps below stay queued and bump no generation.
        holdDrain(scene, true);
        reverted.material = material("next", group("node"));
        frame();
        expect(retired()).toBe(2); // its packet in each cascade
        expect(cascades(first)).toEqual([[[kept, shared]], [[kept, shared]]]);

        // `shared` stays snapshotted for `kept` and its cap is unchanged: only the hold it leaves requeues it.
        reverted.material = shared;
        frame();

        const both = [
            [kept, shared],
            [reverted, shared],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
        expect(cascades(first)).toEqual([both, both]);
        expect(first._materialViews.get(shared)).toBe(view);
        expect(cascadeViews(first, reverted)).toEqual([view, view]);
    });
});

describe("a CSM caster whose material is rebuilt while another caster is held", () => {
    it.each([
        ["default", "lands"],
        ["cache", "lands"],
        ["default", "never lands"],
        ["cache", "never lands"],
    ] as const)("draws no %s packet across the fence that retires its old resources and casts again at once (held build %s)", async (hooks, outcome) => {
        const { lite, scene, caster, register, frame, record, fence, state } = await setup(hooks);
        const shared = material("shared", group("shader"));
        buildOwning(scene, shared._buildGroup);
        const rebuilt = caster(shared);
        // The scene builds the caster's own renderable, whose per-mesh resources its cascade packets reference.
        lite.rebuildMaterial(scene, shared);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const held = caster(before);
        await register([rebuilt, held]);
        frame();
        const first = state();
        const statics = (first as { _staticTasks?: RenderTask[] })._staticTasks;
        // With static caching, demote the caster as a quiet one is, so its packets live in the static-cache tasks.
        first._tasks.forEach((task, cascade) => statics && lite.transferMeshBetweenTasks(task, statics[cascade]!, rebuilt));
        const stale = packets(first).filter((packet) => packet.mesh === rebuilt);
        expect(stale).toHaveLength(2);
        expect((statics ?? first._tasks).flatMap((task) => task._renderables)).toEqual(expect.arrayContaining(stale));
        const firstView = first._materialViews.get(shared);

        // `rebuildMaterial` retires the caster's per-mesh resources behind the next frame fence, while the other caster
        // switches to a NodeMaterial whose group is still building: that caster is held.
        lite.rebuildMaterial(scene, shared);
        const next = material("next", group("node"));
        held.material = next;
        frame();
        expect(record).not.toThrow();

        // The caster's old packets left every task in that frame; they are released behind the same fence, once.
        expect(state()).toBe(first);
        expect(packets(first).filter((packet) => stale.includes(packet))).toEqual([]);
        expect(stale.map((packet) => packet.released)).toEqual([0, 0]);
        fence();
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);
        expect(released(first)).toEqual([]);
        frame();
        frame();
        fence();
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);
        expect(released(first)).toEqual([]);
        // It was requeued through a fresh view at once; the held caster stays out.
        const fresh = first._materialViews.get(shared);
        expect(fresh).not.toBe(firstView);
        expect(cascades(first)).toEqual([[[rebuilt, shared]], [[rebuilt, shared]]]);
        expect(cascadeViews(first, rebuilt)).toEqual([fresh, fresh]);

        if (outcome === "lands") {
            buildLanded(scene, held);
        } else {
            // A build that never lands holds the caster until it leaves the set (or its material is reassigned).
            await register([rebuilt]);
        }
        frame();

        const casters = outcome === "lands" ? [[rebuilt, shared] as const, [held, next] as const] : [[rebuilt, shared] as const];
        expect(state()).toBe(first);
        expect(cascades(state())).toEqual([casters, casters]);
        expect(state()._materialViews.get(shared)).not.toBe(firstView);
        fence();
        expect(released(state())).toEqual([]);
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);
    });

    it.each(["default", "cache"] as const)("keeps a rebuilt %s caster casting while another caster stays held by a build that never lands", async (hooks) => {
        const { lite, scene, sg, caster, register, frame, fence, state, retired } = await setup(hooks);
        const shared = material("shared", group("shader"));
        buildOwning(scene, shared._buildGroup);
        const rebuilt = caster(shared);
        lite.rebuildMaterial(scene, shared);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const held = caster(before);
        await register([rebuilt, held]);
        frame();
        const first = state();
        const statics = (first as { _staticTasks?: RenderTask[] })._staticTasks;
        first._tasks.forEach((task, cascade) => statics && lite.transferMeshBetweenTasks(task, statics[cascade]!, rebuilt));
        const stale = packets(first).filter((packet) => packet.mesh === rebuilt);
        const firstView = first._materialViews.get(shared);
        const draws = drawsOf(sg);

        // The held caster stays in the set, and its NodeMaterial's group never builds.
        lite.rebuildMaterial(scene, shared);
        held.material = material("next", group("node"));
        frame();
        fence();

        const fresh = first._materialViews.get(shared);
        const casting = [[rebuilt, shared]];
        expect(fresh).not.toBe(firstView);
        expect(cascades(first)).toEqual([casting, casting]);
        expect(cascadeViews(first, rebuilt)).toEqual([fresh, fresh]);
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);

        // Frames of the unchanged hold touch no bundle and retire nothing; every draw sees the fresh packets only.
        const intact = stampBundles(first);
        for (let i = 0; i < 8; i++) {
            frame();
            expect(retired()).toBe(0);
            fence();
        }
        expect(intact()).toBe(true);
        expect(state()).toBe(first);
        expect(cascades(first)).toEqual([casting, casting]);
        expect(cascadeViews(first, rebuilt)).toEqual([fresh, fresh]);
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);
        expect(draws).toHaveLength(9);
        expect(draws.flat()).toEqual([]);
    });

    it.each(["default", "cache"] as const)("drops a held %s caster whose previous material was rebuilt in the frame it switched", async (hooks) => {
        const { lite, scene, caster, register, frame, fence, state } = await setup(hooks);
        const before = material("before", group("node"));
        buildOwning(scene, before._buildGroup);
        const mesh = caster(before);
        lite.rebuildMaterial(scene, before);
        await register([mesh]);
        frame();
        const first = state();
        const stale = packets(first).filter((packet) => packet.mesh === mesh);
        expect(stale).toHaveLength(2);

        // Its own change is held while the new group builds, but its packets were built through the rebuilt material.
        lite.rebuildMaterial(scene, before);
        const next = material("next", group("node"));
        mesh.material = next;
        frame();
        fence();

        expect(state()).toBe(first);
        expect(cascades(first)).toEqual([[], []]);
        expect(stale.map((packet) => packet.released)).toEqual([1, 1]);
        expect(released(first)).toEqual([]);

        buildLanded(scene, mesh);
        frame();

        expect(cascades(state())).toEqual([[[mesh, next]], [[mesh, next]]]);
    });

    it.each(["default", "cache"] as const)("puts a %s caster back on its old material when its switch is reverted while another caster is held", async (hooks) => {
        const { scene, shaders, caster, register, frame, state } = await setup(hooks);
        const kept = material("kept", shaders);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const switching = caster(kept);
        const held = caster(before);
        await register([switching, held]);
        frame();
        const first = state();

        // The drain waits for an in-flight runtime build, so the switches below stay queued and bump no generation.
        holdDrain(scene, true);
        const other = material("other", shaders);
        switching.material = other;
        held.material = material("next", group("node"));
        frame();
        expect(cascades(first)).toEqual([[[switching, other]], [[switching, other]]]);

        switching.material = kept;
        frame();

        expect(state()).toBe(first);
        expect(cascades(first)).toEqual([[[switching, kept]], [[switching, kept]]]);
    });
});

describe("frames while a CSM caster material change stays held", () => {
    it.each(["default", "cache"] as const)("leaves every %s task alone until a new caster's group builds, then adds it once", async (hooks) => {
        const { scene, shaders, caster, register, frame, state, retired } = await setup(hooks);
        const keptMaterial = material("kept", shaders);
        const kept = caster(keptMaterial);
        await register([kept]);
        frame();
        const next = material("next", group("node"));
        const added = caster(next);
        await register([kept, added]);
        frame();
        const first = state();

        const intact = stampBundles(first);
        const retirements = retired();
        frame();
        frame();
        frame();
        expect(intact()).toBe(true);
        expect(retired()).toBe(retirements);
        expect(cascades(first)).toEqual([[[kept, keptMaterial]], [[kept, keptMaterial]]]);

        buildLanded(scene, added);
        frame();

        const both = [
            [kept, keptMaterial],
            [added, next],
        ];
        expect(state()).toBe(first);
        expect(cascades(first)).toEqual([both, both]);
        const settled = stampBundles(first);
        frame();
        frame();
        expect(settled()).toBe(true);
        expect(retired()).toBe(retirements);
        expect(cascades(first)).toEqual([both, both]);
    });

    it.each(["default", "cache"] as const)("leaves every %s task alone while a held caster's new cap waits, then requeues it once", async (hooks) => {
        const { lite, scene, caster, register, frame, state, retired } = await setup(hooks);
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        frame();
        const first = state();
        const next = material("next", group("node"));
        mesh.material = next;
        frame();
        lite.setShadowCasterMaxCascade(mesh, 0);
        await register([mesh]);
        frame();

        const intact = stampBundles(first);
        const retirements = retired();
        frame();
        frame();
        frame();
        expect(state()).toBe(first);
        expect(intact()).toBe(true);
        expect(retired()).toBe(retirements);

        buildLanded(scene, mesh);
        frame();

        // Its old packets retired when the hold began; the requeue retires nothing more.
        expect(state()).toBe(first);
        expect(retired()).toBe(retirements);
        expect(cascades(state())).toEqual([[[mesh, next]], []]);
        const settled = stampBundles(first);
        frame();
        frame();
        expect(state()).toBe(first);
        expect(settled()).toBe(true);
        expect(retired()).toBe(retirements);
    });

    it.each(["default", "cache"] as const)("leaves every %s task alone while a new caster's view factory imports, then adds it once without a version bump", async (hooks) => {
        const { scene, sg, shaders, caster, register, frame, ensure, state, retired } = await setup(hooks);
        const keptMaterial = material("kept", shaders);
        const kept = caster(keptMaterial);
        await register([kept]);
        frame();
        const first = state();
        const added = caster(material("placeholder", shaders));
        await register([kept, added]);
        const standard = group("standard");
        build(scene, standard);
        const real = material("real", standard);
        added.material = real;
        frame();
        expect(sg._preloadPending).toBeDefined();

        // The shadow task skips the parked generator; its ensure, run regardless, must not redo the diff either.
        const intact = stampBundles(first);
        const retirements = retired();
        ensure();
        ensure();
        ensure();
        expect(intact()).toBe(true);
        expect(retired()).toBe(retirements);

        const versions = [scene._renderableVersion, scene._materialEpoch];
        await loaded(sg);
        expect([scene._renderableVersion, scene._materialEpoch]).toEqual(versions);
        frame();

        const both = [
            [kept, keptMaterial],
            [added, real],
        ];
        expect(state()).toBe(first);
        expect(cascades(first)).toEqual([both, both]);
        const settled = stampBundles(first);
        frame();
        ensure();
        expect(settled()).toBe(true);
        expect(retired()).toBe(retirements);
        expect(cascades(first)).toEqual([both, both]);
    });
});

describe("a held CSM caster whose old resources were retired while the generator was parked", () => {
    it.each(["default", "cache"] as const)("draws no released %s resource in the pass whose ensure parks the generator again", async (hooks) => {
        const { lite, scene, sg, caster, register, frame, fence, state } = await setup(hooks);
        const parkerMaterial = material("parker", group("shader"));
        const ownMaterial = material("own", group("shader"));
        buildOwning(scene, parkerMaterial._buildGroup);
        buildOwning(scene, ownMaterial._buildGroup);
        const parker = caster(parkerMaterial);
        const mesh = caster(ownMaterial);
        // The scene builds the casters' own renderables, whose per-mesh resources their cascade packets reference.
        lite.rebuildMaterial(scene, parkerMaterial);
        lite.rebuildMaterial(scene, ownMaterial);
        await register([parker, mesh]);
        frame();
        const statics = (state() as { _staticTasks?: RenderTask[] })._staticTasks;
        // With static caching, demote both casters as quiet ones are, so their packets live in the static-cache tasks.
        state()._tasks.forEach((task, cascade) => statics && [parker, mesh].forEach((m) => lite.transferMeshBetweenTasks(task, statics[cascade]!, m)));
        const draws = drawsOf(sg);

        // A caster switches to a family whose view factory is not imported: the generator parks while it imports.
        const standard = group("standard");
        build(scene, standard);
        const standardMaterial = material("standard", standard);
        parker.material = standardMaterial;
        frame();
        expect(sg._preloadPending).toBeDefined();

        // While parked, the other caster switches to a NodeMaterial whose group is built: the drain retires its per-mesh
        // resources behind the fence, and the shadow task does not see the switch.
        const node = group("node");
        build(scene, node);
        const nodeMaterial = material("node", node);
        mesh.material = nodeMaterial;
        frame();
        fence();
        await loaded(sg);

        // That caster now waits for the NodeMaterial view factory, so this ensure parks the generator again, but the same
        // pass still records and draws, with the other caster requeued at once.
        frame();
        expect(sg._preloadPending).toBeDefined();
        expect(draws.flat()).toEqual([]);
        expect(cascades(state())).toEqual([[[parker, standardMaterial]], [[parker, standardMaterial]]]);

        await loaded(sg);
        frame();
        fence();

        const both = [
            [parker, standardMaterial],
            [mesh, nodeMaterial],
        ];
        expect(cascades(state())).toEqual([both, both]);
        expect(released(state())).toEqual([]);
        expect(draws.flat()).toEqual([]);
    });

    it.each(["default", "cache"] as const)("draws no released %s resource for a caster that switched twice meanwhile and waits for its group", async (hooks) => {
        const { lite, scene, sg, shaders, caster, register, frame, fence, state } = await setup(hooks);
        // The NodeMaterial view factory is imported already: the caster below waits for its group only.
        await lite.preloadCsmShadowTaskState([{ material: material("node", group("node")) } as Mesh]);
        const ownMaterial = material("own", group("shader"));
        buildOwning(scene, ownMaterial._buildGroup);
        const parker = caster(material("parker", shaders));
        const mesh = caster(ownMaterial);
        lite.rebuildMaterial(scene, ownMaterial);
        await register([parker, mesh]);
        frame();
        const draws = drawsOf(sg);

        const standard = group("standard");
        build(scene, standard);
        const standardMaterial = material("standard", standard);
        parker.material = standardMaterial;
        frame();
        expect(sg._preloadPending).toBeDefined();

        // While parked, the caster switches to a built material (the drain retires its per-mesh resources behind the
        // fence), then to a NodeMaterial whose group is still building. The shadow task sees neither switch.
        mesh.material = material("built", shaders);
        frame();
        const next = material("next", group("node"));
        mesh.material = next;
        frame();
        fence();
        await loaded(sg);

        // The caster waits for its group without parking the generator, so its old packets would be drawn. The other
        // caster is requeued at once.
        frame();
        expect(sg._preloadPending).toBeUndefined();
        expect(draws.flat()).toEqual([]);
        expect(cascades(state())).toEqual([[[parker, standardMaterial]], [[parker, standardMaterial]]]);

        buildLanded(scene, mesh);
        frame();
        fence();

        const both = [
            [parker, standardMaterial],
            [mesh, next],
        ];
        expect(cascades(state())).toEqual([both, both]);
        expect(released(state())).toEqual([]);
        expect(draws.flat()).toEqual([]);
    });
});
