import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTask, RenderTaskConfig } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext, SceneMeshGroup } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import type { PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";

const created = vi.hoisted(() => ({ tasks: 0 }));

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../packages/babylon-lite/src/shadow/shadow-base")>()),
    createShadowCamera: () => ({}),
    createShadowRenderTarget: () => ({}),
}));

// A PCF task without a GPU target. Its record runs the real task transaction: it resolves each queued caster through the
// group of the material its view reads, and throws for a group not built in the scene.
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

// The runtime build the swap drain hands a mesh to when its material's group was never built in the scene. It cannot run
// here; a case lands it with `buildLanded`.
vi.mock("../../../packages/babylon-lite/src/scene/scene-runtime-mesh-build.js", () => ({ C: () => Promise.resolve() }));

/** Fresh copies of the modules under test, so the no-colour view factories a case imports never leak into another one. */
async function importLite() {
    vi.resetModules();
    // Finish the async partial mock before parallel imports can enter its real dependency graph.
    await import("../../../packages/babylon-lite/src/frame-graph/render-task");
    const [inputs, override, registry, swaps, shadowTask, pcf] = await Promise.all([
        import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs"),
        import("../../../packages/babylon-lite/src/material/set-shadow-caster-material"),
        import("../../../packages/babylon-lite/src/scene/mesh-scene-registry"),
        import("../../../packages/babylon-lite/src/scene/scene-material-swap"),
        import("../../../packages/babylon-lite/src/frame-graph/shadow-task"),
        import("../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks"),
    ]);
    return { ...inputs, ...override, ...registry, ...swaps, ...shadowTask, ...pcf };
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

/** Complete a group's first build in the scene: its rebuild turns a (mesh, view) pair into a packet. */
function build(scene: SceneContext, buildGroup: MeshGroupBuilder): void {
    const rebuild = (_scene: SceneContext, mesh: Mesh, view?: Material) => {
        const packet = { mesh, _lastMaterial: view, order: 0, bind: () => ({ renderable: packet }) };
        return packet as unknown as Renderable;
    };
    scene._groups.set(buildGroup, { r: rebuild } as unknown as SceneMeshGroup);
}

/** What the runtime build does when it lands: the group gets its rebuild, the mesh its next renderable generation, and the
 *  renderable version moves. */
function buildLanded(scene: SceneContext, mesh: Mesh): void {
    build(scene, mesh.material!._buildGroup);
    mesh._renderableGen = (mesh._renderableGen ?? 0) + 1;
    scene._renderableVersion++;
    scene._materialEpoch++;
}

/** What the PCF task draws once recorded: each caster with the material its depth view reads. */
function casts(state: PcfTaskState): [Mesh, Material][] {
    const task = state._task;
    const recorded = task._renderables.map((packet) => [packet.mesh!, packet._lastMaterial as MaterialView] as const);
    const queued = (task._pendingMeshes ?? []).map(({ mesh, material: view }) => [mesh as Mesh, view as MaterialView] as const);
    return [...recorded, ...queued].map(([mesh, view]) => [mesh, view.source]);
}

/** A PCF generator in a scene whose frames drain material swaps and then run the real shadow task. */
async function setup() {
    const lite = await importLite();
    const engine = {} as EngineContext;
    const sg = {
        _preloadShadowTask: lite.preloadPcfShadowTaskState,
        _renderShadowMap: vi.fn(() => 0),
    } as unknown as ShadowGenerator;
    sg._ensureShadowTaskState = (eng, scene, casterMeshes) => (sg._shadowTaskState = lite.ensurePcfShadowTaskState(eng, scene, sg, casterMeshes, sg._shadowTaskState ?? null));
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
    await lite.preloadPcfShadowTaskState([{ material: material("preload", shaders) } as Mesh]);
    const shadowTask = lite.createShadowTask(engine, scene);
    return {
        lite,
        scene,
        sg,
        shaders,
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
        state: () => sg._shadowTaskState as PcfTaskState,
        /** Run the GPU resource retirements queued so far, as the fence behind a submitted frame does. */
        fence: (): number => {
            const retirements = engine._retirements?.splice(0) ?? [];
            for (const retire of retirements) {
                retire();
            }
            return retirements.length;
        },
    };
}

/** Wait for the shadow task's preload to release the generator. */
async function loaded(sg: ShadowGenerator): Promise<void> {
    await vi.waitFor(() => expect(sg._preloadPending).toBeUndefined());
}

describe("a registered PCF caster whose own renderable is rebuilt", () => {
    it("rebuilds the task, whose packet may reference the per-mesh resources the rebuild retired", async () => {
        const { lite, shaders, caster, register, frame, state } = await setup();
        const shared = material("shared", shaders);
        const mesh = caster(shared);
        await register([mesh]);
        frame();
        const first = state();
        const tasks = created.tasks;

        // Replaced GPU geometry, for example: no material changes, only the mesh's renderable is rebuilt.
        lite.markMeshRenderableDirty(mesh);
        frame();

        expect(state()).not.toBe(first);
        expect(created.tasks).toBe(tasks + 1);
        expect(casts(state())).toEqual([[mesh, shared]]);
        frame();
        expect(created.tasks).toBe(tasks + 1);
    });
});

describe("a registered PCF caster whose material changes with the caster set unchanged", () => {
    it("rebuilds the task through the new material when its view can be built", async () => {
        const { shaders, caster, register, frame, state } = await setup();
        const mesh = caster(material("before", shaders));
        await register([mesh]);
        frame();
        const after = material("after", shaders);

        mesh.material = after;
        frame();

        expect(casts(state())).toEqual([[mesh, after]]);
        // The rebuild snapshotted the new material, so a later frame builds no other task.
        const tasks = created.tasks;
        frame();
        expect(created.tasks).toBe(tasks);
    });

    // Each case brings a family no caster used so far, so its no-colour view factory has not been imported.
    it.each([
        ["gets its first material", null],
        ["switches to another material family", "shader"],
    ] as const)("parks the generator while the view factory imports when a registered caster %s", async (_, from) => {
        const { scene, sg, shaders, caster, register, frame, state } = await setup();
        const before = from && material("before", shaders);
        const mesh = caster(before);
        const other = caster(material("other", shaders));
        const casterMeshes = [mesh, other];
        await register(casterMeshes);
        frame();
        const standard = group("standard");
        build(scene, standard);
        const next = material("next", standard);

        mesh.material = next;
        expect(frame).not.toThrow();

        // The caster leaves the task while its family's factory imports; the other caster keeps casting.
        expect(sg._preloadPending).toBe(casterMeshes);
        expect(casts(state())).toEqual([[other, other.material]]);
        const renders = vi.mocked(sg._renderShadowMap!).mock.calls.length;
        const tasks = created.tasks;
        frame();
        expect(sg._renderShadowMap).toHaveBeenCalledTimes(renders);
        expect(created.tasks).toBe(tasks);

        await loaded(sg);
        frame();

        expect(casts(state())).toEqual([
            [mesh, next],
            [other, other.material],
        ]);
        const rebuilt = created.tasks;
        frame();
        expect(created.tasks).toBe(rebuilt);
    });

    it("has its caster override re-pointed to a family whose view factory is not imported", async () => {
        const { lite, scene, sg, shaders, caster, register, frame, state } = await setup();
        const receive = material("receive", shaders);
        const mesh = caster(receive);
        await register([mesh]);
        frame();
        const pbr = group("pbr");
        build(scene, pbr);
        const override = material("override", pbr);

        lite.setShadowCasterMaterial(receive, override);
        expect(frame).not.toThrow();
        expect(sg._preloadPending).toBeDefined();
        expect(casts(state())).toEqual([]);

        await loaded(sg);
        frame();

        expect(casts(state())).toEqual([[mesh, override]]);
    });

    // A NodeMaterial instance has a group of its own: switching a caster to a new one hands the mesh to the runtime build.
    it("keeps the caster out of the task, and builds no task per frame, while the new material's group is building", async () => {
        const { scene, caster, register, frame, state, fence } = await setup();
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        // The no-colour view factory of the node family is imported, so only the group of the new material is missing.
        frame();
        fence();
        const next = material("next", group("node"));

        mesh.material = next;
        expect(frame).not.toThrow();
        const held = state();
        const tasks = created.tasks;
        expect(casts(held)).toEqual([]);
        // The task it cast into before retires behind the frame fence; it may reference resources of the old material.
        expect(fence()).toBe(1);

        expect(frame).not.toThrow();
        expect(frame).not.toThrow();
        expect(state()).toBe(held);
        expect(created.tasks).toBe(tasks);
        expect(fence()).toBe(0);

        buildLanded(scene, mesh);
        frame();

        expect(casts(state())).toEqual([[mesh, next]]);
        expect(created.tasks).toBe(tasks + 1);
    });

    it("rejoins through its previous view when a change that was held is reverted", async () => {
        const { scene, caster, register, frame, state } = await setup();
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const mesh = caster(before);
        await register([mesh]);
        frame();

        mesh.material = material("next", group("node"));
        frame();
        expect(casts(state())).toEqual([]);

        mesh.material = before;
        frame();

        expect(casts(state())).toEqual([[mesh, before]]);
    });
});

describe("caster-set changes while a PCF caster is held", () => {
    it("keeps a held caster out of the task built for a re-supplied set, and casts the other members", async () => {
        const { scene, shaders, caster, register, frame, state } = await setup();
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const building = caster(before);
        await register([building]);
        frame();
        const next = material("next", group("node"));
        building.material = next;
        frame();

        // The application adds a caster while the runtime build of the held one has not landed.
        const added = caster(material("added", shaders));
        await register([building, added]);
        expect(frame).not.toThrow();

        expect(casts(state())).toEqual([[added, added.material]]);
        buildLanded(scene, building);
        frame();
        expect(casts(state())).toEqual([
            [building, next],
            [added, added.material],
        ]);
    });

    it("forgets a held caster that leaves the set", async () => {
        const { scene, shaders, caster, register, frame, state } = await setup();
        const before = material("before", group("node"));
        build(scene, before._buildGroup);
        const building = caster(before);
        const kept = caster(material("kept", shaders));
        await register([building, kept]);
        frame();
        building.material = material("next", group("node"));
        frame();
        expect(state()._held).toEqual(new Set([building]));

        await register([kept]);
        frame();

        expect(casts(state())).toEqual([[kept, kept.material]]);
        expect(state()._held).toBeUndefined();
    });

    it("holds a caster that switched to another family while the registration preload was importing", async () => {
        const { lite, scene, sg, shaders, caster, frame, state } = await setup();
        const mesh = caster(material("before", shaders));
        const casterMeshes = [mesh];
        lite.setShadowTaskCasterMeshes(sg, casterMeshes);
        const standard = group("standard");
        build(scene, standard);
        const next = material("next", standard);
        mesh.material = next;
        await loaded(sg);

        expect(frame).not.toThrow();

        expect(sg._preloadPending).toBe(casterMeshes);
        expect(casts(state())).toEqual([]);
        await loaded(sg);
        frame();
        expect(casts(state())).toEqual([[mesh, next]]);
    });
});
