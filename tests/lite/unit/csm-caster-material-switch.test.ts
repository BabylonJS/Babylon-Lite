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

/** The depth view each cascade draws a recorded caster with. */
function cascadeViews(state: CsmTaskState, mesh: Mesh): (Material | undefined)[] {
    const statics = (state as { _staticTasks?: RenderTask[] })._staticTasks;
    return state._tasks.map((task, cascade) => [...task._renderables, ...(statics?.[cascade]!._renderables ?? [])].find((packet) => packet.mesh === mesh)?._lastMaterial);
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
        lights: [{ shadowGenerator: sg }],
        meshes: [],
        _renderables: [],
        _renderableVersion: 1,
        _materialEpoch: 1,
        _groups: new Map(),
        _materialSwapQueue: [],
        _meshDisposables: new Map(),
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

        // The live cascades stay and the generator is parked on its registered set while the factory imports.
        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(sg._preloadPending).toBe(casterMeshes);
        const renders = vi.mocked(sg._renderShadowMap!).mock.calls.length;
        frame();
        expect(sg._renderShadowMap).toHaveBeenCalledTimes(renders);

        await loaded(sg);
        frame();

        // Requeued in the same cascade tasks: a caster that cast before retires its old packet in each cascade.
        const retiredPackets = before ? 2 : 0;
        expect(state()).toBe(first);
        expect(retired()).toBe(retiredPackets);
        expect(cascades(state())).toEqual([[[mesh, next]], [[mesh, next]]]);
        frame();
        expect(retired()).toBe(retiredPackets);
        expect(cascades(state())).toEqual([[[mesh, next]], [[mesh, next]]]);
    });

    // A NodeMaterial instance has a group of its own: switching a caster to a new one hands the mesh to the runtime build.
    it.each(["default", "cache"] as const)("keeps the %s cascades and creates nothing while the new material's group is building", async (hooks) => {
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

        // The drain handed the mesh to the runtime build, so nothing is queued any more: only the group is missing.
        expect(scene._materialSwapQueue).toEqual([]);
        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(created.tasks).toBe(tasks);
        expect(createTexture).toHaveBeenCalledTimes(textures);
        expect(first._tasks.map(casts)).toEqual([[[mesh, before]], [[mesh, before]]]);

        buildLanded(scene, mesh);
        frame();

        // Requeued: the old packet in each cascade retires, and still no task or texture is created.
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

        // The requeue waits for `building`, which keeps its old packet; the set change does not wait, and the removed
        // caster's packet in each cascade retires.
        const held = [
            [building, before],
            [added, addedMaterial],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2);
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

    it.each(["default", "cache"] as const)("keeps a held caster on its old %s packets and cap until it is requeued", async (hooks) => {
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
        expect(cascades(state())).toEqual([[[mesh, before]], [[mesh, before]]]);

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

        expect(state()).toBe(first);
        expect(retired()).toBe(0);
        expect(sg._preloadPending).toBe(casterMeshes);
        expect(cascades(state())).toEqual([[[registered, receive]], [[registered, receive]]]);

        await loaded(sg);
        frame();

        const both = [
            [registered, override],
            [added, override],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2); // the registered caster's old packet in each cascade
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
        // waits: the hold is per caster, so `kept` is requeued through a fresh view at once.
        lite.rebuildMaterial(scene, shared);
        building.material = material("next", group("node"));
        frame();

        const freshView = state()._materialViews.get(shared)!;
        expect(freshView).not.toBe(staleView);
        const requeued = [
            [building, before],
            [kept, shared],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2); // `kept`'s old packet in each cascade
        expect(cascades(state())).toEqual([requeued, requeued]);
        expect(viewsOf(kept)).toEqual([freshView, freshView]);

        // A caster sharing the rebuilt material joins the set: it is queued through the same fresh view.
        const added = caster(shared);
        await register([kept, building, added]);
        frame();

        const joined = [
            [building, before],
            [kept, shared],
            [added, shared],
        ];
        expect(retired()).toBe(2);
        expect(cascades(state())).toEqual([joined, joined]);
        expect(viewsOf(added)).toEqual([freshView, freshView]);

        await register([kept, added]);
        frame();

        const both = [
            [kept, shared],
            [added, shared],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(4); // and now `building`'s old packets
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

        // Once the build lands, the caster is queued: while it waited, the same caster array still ran the reconcile.
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

    it.each(["default", "cache"] as const)("holds the %s cascades when a registered and a new caster switch to the same building material", async (hooks) => {
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
        expect(retired()).toBe(0);
        expect(cascades(state())).toEqual([[[switching, before]], [[switching, before]]]);

        buildLanded(scene, switching);
        frame();

        const both = [
            [switching, next],
            [added, next],
        ];
        expect(state()).toBe(first);
        expect(retired()).toBe(2); // `switching`'s old packet in each cascade
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

        // Reverting the switch ends the hold and keeps the old view; the cap re-supplied meanwhile still applies.
        mesh.material = before;
        frame();

        expect(state()).toBe(first);
        expect(cascades(state())).toEqual([[[mesh, before]], []]);
    });
});
