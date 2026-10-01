import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type * as RenderTaskModule from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { RenderTask, RenderTaskConfig } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { DrawBatchState } from "../../../packages/babylon-lite/src/render/draw-update-batches";
import type { MeshRebuildResources, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext, SceneMeshGroup } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { CsmRefitGate } from "../../../packages/babylon-lite/src/shadow/csm-refit-gate";
import type { CsmConfig, CsmTaskState } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import type * as ShadowBase from "../../../packages/babylon-lite/src/shadow/shadow-base";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

const { createdTasks } = vi.hoisted(() => ({ createdTasks: [] as unknown[] }));

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", async (importOriginal) => ({
    ...(await importOriginal<typeof ShadowBase>()),
    createShadowCamera: () => ({}),
}));

// Cascade tasks without GPU targets. Queueing, removal, retirement and the rebind transaction stay real.
vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", async (importOriginal) => {
    const actual = await importOriginal<typeof RenderTaskModule>();
    return {
        ...actual,
        createRenderTask: (config: RenderTaskConfig, engine: EngineContext, scene: SceneContext) => {
            const task = {
                name: config.name,
                engine,
                scene,
                _config: config,
                _targetSignature: {},
                _renderables: [],
                _opaqueBindings: [],
                _directBindings: [],
                _transparentBindings: [],
                _ob: [],
                _lastVersion: -1,
                // What a real explicit task's record does, minus the GPU target: resolve the queue and bind once.
                record: vi.fn(() => {
                    const live = task as unknown as RenderTask;
                    if (live._pendingMeshes) {
                        actual._rebindRenderTask(live);
                    }
                    live._sceneBG = {} as GPUBindGroup;
                }),
                dispose: vi.fn(),
            };
            createdTasks.push(task);
            return task;
        },
    };
});

const { _rebindRenderTask } = await import("../../../packages/babylon-lite/src/frame-graph/render-task");
const { setShadowTaskCasterMeshes } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs");
const { createShadowTask } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-task");
const { ensureCsmShadowTaskState } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks");
const { ensureCsmShadowCacheState, rebuildTransferTarget } = await import("../../../packages/babylon-lite/src/shadow/csm-shadow-cache");
const { preloadPcfShadowTaskState } = await import("../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks");
const { setShadowCasterMaterial } = await import("../../../packages/babylon-lite/src/material/set-shadow-caster-material");

interface CachedState extends CsmTaskState {
    _staticTasks: RenderTask[];
    _gate: CsmRefitGate<Mesh>;
    _onPromote: (mesh: Mesh) => void;
    _onDemote: (mesh: Mesh) => void;
    _pendingTransfers: Set<RenderTask>;
    _cachedContentVersion: number;
}

/** Device-free ShaderMaterial-shaped caster: its no-colour view is a plain `createMaterialView` wrap. */
const shaderGroup = { _materialFamily: "shader" } as unknown as Material["_buildGroup"];
function shaderMaterial(name: string, shadowCaster?: Material): Material {
    return { name, _buildGroup: shaderGroup, _uboVersion: 0, _csmGen: 0, ...(shadowCaster ? { _shadowCasterMaterial: shadowCaster } : {}) } as Material;
}

function caster(name: string, material: Material): Mesh {
    return { name, material, worldMatrixVersion: 0, thinInstances: null } as unknown as Mesh;
}

/** A resolved caster packet; the stub also records the material view it was built from. */
type CasterPacket = Renderable & { material?: Material };

/** The group rebuild the cascade tasks resolve queued casters with; every packet owns one lifetime disposer. */
const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh, material?: Material, resources?: MeshRebuildResources): Renderable => {
    const renderable = { mesh, material, order: 0, bind: vi.fn(() => ({ renderable })) } as unknown as CasterPacket;
    resources!._lifetimeDisposers.push(vi.fn());
    return renderable;
});

const sg = { _depthTexture: { createView: () => ({}) }, _csmCache: { _refitAngle: 0.1, _refitMaxIntervalMs: 0 } } as unknown as ShadowGenerator;
const cfg = { _numCascades: 2, _mapSize: 64 } as CsmConfig;

function makeScene(): SceneContext {
    return { _renderableVersion: 1, _groups: new Map([[shaderGroup, { r: rebuild }]]) } as unknown as SceneContext;
}

/** What the shadow scheduler's record does to every cascade task: resolve the queued casters and bind once. */
function record(state: CsmTaskState, scene: SceneContext, tasks: readonly RenderTask[] = state._tasks): void {
    for (const task of tasks) {
        // A task that never had a caster is not populated yet (a static layer before any demotion).
        if (task._pendingMeshes) {
            _rebindRenderTask(task);
        }
        task._sceneBG = {} as GPUBindGroup;
    }
    state._recordedVersion = scene._renderableVersion;
    state._lastCasterVersion = 3; // as left by a rendered frame
}

function packet(task: RenderTask, mesh: Mesh): CasterPacket {
    const found = task._renderables.find((renderable) => renderable.mesh === mesh);
    expect(found).toBeDefined();
    return found!;
}

function disposer(renderable: Renderable): ReturnType<typeof vi.fn> {
    return renderable._lifetimeDisposers![0] as ReturnType<typeof vi.fn>;
}

function runRetirements(engine: EngineContext): void {
    for (const retire of engine._retirements?.splice(0) ?? []) {
        retire();
    }
}

function setup(casters: readonly Mesh[]): { engine: EngineContext; scene: SceneContext; state: CsmTaskState } {
    const engine = {} as EngineContext;
    const scene = makeScene();
    const state = ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, null);
    record(state, scene);
    return { engine, scene, state };
}

/** A recorded state of either hook set; `ensure` re-supplies it, and `tasks` lists every cascade task it owns. */
function start(hooks: "default" | "cache", casters: readonly Mesh[]) {
    const engine = { _device: { createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })) } } as unknown as EngineContext;
    const scene = makeScene();
    const hook = hooks === "default" ? ensureCsmShadowTaskState : ensureCsmShadowCacheState;
    const state = hook(engine, scene, sg, cfg, casters, null) as Partial<CachedState> & CsmTaskState;
    const tasks = (): RenderTask[] => [...(state._staticTasks ?? []), ...state._tasks];
    record(state, scene, tasks());
    const ensure = (meshes: readonly Mesh[]): void => {
        expect(hook(engine, scene, sg, cfg, meshes, state)).toBe(state);
    };
    return { engine, scene, state, tasks, ensure };
}

describe("CSM caster reconcile", () => {
    beforeAll(async () => {
        await preloadPcfShadowTaskState([caster("preload", shaderMaterial("preload"))]);
    });

    beforeEach(() => {
        createdTasks.length = 0;
    });

    it("keeps every cascade task and requeues only the caster whose material was rebuilt", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshB = caster("b", shaderMaterial("B"));
        const casters = [meshA, meshB];
        const { engine, scene, state } = setup(casters);
        const tasks = state._tasks.slice();
        const oldA = tasks.map((task) => packet(task, meshA));
        const keptB = tasks.map((task) => packet(task, meshB));
        const oldView = state._materialViews.get(matA);

        matA._csmGen = 1; // a material swap or rebuild of matA
        const next = ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state);

        expect(next).toBe(state);
        expect(createdTasks).toHaveLength(2);
        expect(state._tasks.every((task, c) => task === tasks[c])).toBe(true);
        const view = state._materialViews.get(matA)!;
        expect(view).not.toBe(oldView);
        expect(view.source).toBe(matA);
        tasks.forEach((task, c) => {
            expect(task._renderables).toHaveLength(1);
            expect(task._renderables[0]).toBe(keptB[c]);
            expect(task._opaqueBindings.map((binding) => binding.renderable)).toEqual([keptB[c]]);
            expect(task._pendingMeshes).toEqual([{ mesh: meshA, material: view }]);
            expect(task.dispose).not.toHaveBeenCalled();
        });
        expect(state._recordedVersion).toBe(-1);
        expect(state._lastCasterVersion).toBe(-1);

        runRetirements(engine);
        tasks.forEach((_task, c) => {
            expect(disposer(oldA[c]!)).toHaveBeenCalledOnce();
            expect(disposer(keptB[c]!)).not.toHaveBeenCalled();
        });

        record(state, scene);
        tasks.forEach((task, c) => {
            expect(task._renderables[0]).toBe(keptB[c]);
            expect(task._renderables.map((renderable) => renderable.mesh)).toEqual([meshB, meshA]);
            expect(packet(task, meshA).material).toBe(view);
        });
    });

    it("gives every caster of a rebuilt material one fresh view and leaves other materials' views alone", () => {
        const matA = shaderMaterial("A");
        const matB = shaderMaterial("B");
        const meshA1 = caster("a1", matA);
        const meshA2 = caster("a2", matA);
        const meshB = caster("b", matB);
        const casters = [meshA1, meshB, meshA2];
        const { engine, scene, state } = setup(casters);
        const viewB = state._materialViews.get(matB);
        const keptB = state._tasks.map((task) => packet(task, meshB));

        matA._csmGen = 1;
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(matA)!;
        expect(view.source).toBe(matA);
        expect(state._materialViews.get(matB)).toBe(viewB);
        state._tasks.forEach((task, c) => {
            expect(task._pendingMeshes).toEqual([
                { mesh: meshA1, material: view },
                { mesh: meshA2, material: view },
            ]);
            expect(task._renderables).toHaveLength(1);
            expect(task._renderables[0]).toBe(keptB[c]);
        });
    });

    it("requeues every caster casting through a rebuilt override terminal with one shared view", () => {
        const terminal = shaderMaterial("caster");
        const visible = shaderMaterial("visible", terminal);
        const meshV = caster("v", visible);
        const meshC = caster("c", terminal);
        const casters = [meshV, meshC];
        const { engine, scene, state } = setup(casters);
        const oldView = state._materialViews.get(terminal);
        expect(state._materialViews.get(visible)).toBe(oldView);

        terminal._csmGen = 1;
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(terminal)!;
        expect(view).not.toBe(oldView);
        expect(view.source).toBe(terminal);
        expect(state._materialViews.get(visible)).toBe(view);
        for (const task of state._tasks) {
            expect(task._renderables).toHaveLength(0);
            expect(task._pendingMeshes).toEqual([
                { mesh: meshV, material: view },
                { mesh: meshC, material: view },
            ]);
        }
    });

    it("requeues only the re-pointed material's casters and forces a record and a redraw", () => {
        const terminal = shaderMaterial("caster");
        const other = shaderMaterial("other");
        const visible = shaderMaterial("visible", terminal);
        const meshV = caster("v", visible);
        const meshC = caster("c", terminal);
        const casters = [meshV, meshC];
        const { engine, scene, state } = setup(casters);
        const terminalView = state._materialViews.get(terminal);
        const keptC = state._tasks.map((task) => packet(task, meshC));

        setShadowCasterMaterial(visible, other); // bumps no scene or material version
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(visible)!;
        expect(view.source).toBe(other);
        expect(state._materialViews.get(terminal)).toBe(terminalView);
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toHaveLength(1);
            expect(task._renderables[0]).toBe(keptC[c]);
            expect(task._pendingMeshes).toEqual([{ mesh: meshV, material: view }]);
        });
        expect(state._recordedVersion).toBe(-1);
        expect(state._lastCasterVersion).toBe(-1);
    });

    it("queues casters added to recorded cascades instead of rebinding the whole task once per caster", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const { engine, scene, state } = setup([meshA]);
        const binds = state._tasks.map((task) => packet(task, meshA).bind as ReturnType<typeof vi.fn>);
        binds.forEach((bind) => expect(bind).toHaveBeenCalledOnce());
        const added = [caster("b", matA), caster("c", matA), caster("d", matA)];
        rebuild.mockClear();

        ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA, ...added], state);

        binds.forEach((bind) => expect(bind).toHaveBeenCalledOnce());
        expect(rebuild).not.toHaveBeenCalled();
        for (const task of state._tasks) {
            expect(task._pendingMeshes!.map((request) => request.mesh)).toEqual(added);
        }
        expect(state._recordedVersion).toBe(-1);

        // The scheduler's single record per cascade resolves all three and binds the kept packet once more.
        record(state, scene);
        binds.forEach((bind) => expect(bind).toHaveBeenCalledTimes(2));
        expect(rebuild).toHaveBeenCalledTimes(3 * state._tasks.length);
    });

    it("removes all stale casters from a task in one pass", () => {
        const materials = [shaderMaterial("A"), shaderMaterial("B"), shaderMaterial("C")];
        const kept = caster("kept", shaderMaterial("D"));
        const casters = [...materials.map((material, i) => caster(`m${i}`, material)), kept];
        const { engine, scene, state } = setup(casters);
        const batchStates = state._tasks.map((task) => {
            const batchState = { _batches: [], _reset: vi.fn(), _flush: vi.fn(), _select: vi.fn(() => undefined), _release: vi.fn() };
            task._batchState = batchState as unknown as DrawBatchState;
            return batchState;
        });
        const keptBindings = state._tasks.map((task) => task._opaqueBindings.find((binding) => binding.renderable.mesh === kept));

        for (const material of materials) {
            material._csmGen = 1;
        }
        ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state);

        state._tasks.forEach((task, c) => {
            const batchState = batchStates[c]!;
            expect(batchState._select).toHaveBeenCalledOnce();
            expect(batchState._select).toHaveBeenCalledWith([[keptBindings[c]], [], []]);
            expect(batchState._release).toHaveBeenCalledOnce();
            expect(task._batchState).toBeUndefined();
            expect(task._pendingMeshes).toHaveLength(3);
        });
    });

    it("forces only a redraw, not a record, when casters are dropped and none queued", () => {
        const meshA = caster("a", shaderMaterial("A"));
        const meshB = caster("b", shaderMaterial("B"));
        const { engine, scene, state } = setup([meshA, meshB]);
        const keptA = state._tasks.map((task) => packet(task, meshA));
        const oldB = state._tasks.map((task) => packet(task, meshB));
        const recorded = state._recordedVersion;

        // meshB leaves the caster list but stays in the scene, so no scene version moves.
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA], state)).toBe(state);

        expect(state._recordedVersion).toBe(recorded);
        expect(state._lastCasterVersion).toBe(-1);
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toEqual([keptA[c]]);
            expect(task._opaqueBindings.map((binding) => binding.renderable)).toEqual([keptA[c]]);
            expect(task._pendingMeshes).toHaveLength(0);
        });
        runRetirements(engine);
        oldB.forEach((renderable) => expect(disposer(renderable)).toHaveBeenCalledOnce());
        keptA.forEach((renderable) => expect(disposer(renderable)).not.toHaveBeenCalled());
    });

    it("leaves the batches of a cascade that holds none of the dropped casters alone", () => {
        const meshA = caster("a", shaderMaterial("A"));
        const near = caster("near", shaderMaterial("N"));
        near._shadowMaxCascade = 0; // casts into cascade 0 only
        const { engine, scene, state } = setup([meshA, near]);
        const batchStates = state._tasks.map((task) => {
            const batchState = { _batches: [], _reset: vi.fn(), _flush: vi.fn(), _select: vi.fn(() => undefined), _release: vi.fn() };
            task._batchState = batchState as unknown as DrawBatchState;
            return batchState;
        });

        ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA], state);

        expect(batchStates[0]!._select).toHaveBeenCalledOnce();
        expect(batchStates[1]!._select).not.toHaveBeenCalled();
        expect(batchStates[1]!._release).not.toHaveBeenCalled();
        expect(state._tasks[1]!._batchState).toBe(batchStates[1]);
    });

    it("requeues a caster whose override was cleared with its own material's view", () => {
        const terminal = shaderMaterial("caster");
        const visible = shaderMaterial("visible", terminal);
        const meshV = caster("v", visible);
        const meshC = caster("c", terminal);
        const casters = [meshV, meshC];
        const { engine, scene, state } = setup(casters);
        const terminalView = state._materialViews.get(terminal);
        const keptC = state._tasks.map((task) => packet(task, meshC));

        setShadowCasterMaterial(visible, null);
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(visible)!;
        expect(view.source).toBe(visible);
        expect(state._materialViews.get(terminal)).toBe(terminalView);
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toEqual([keptC[c]]);
            expect(task._pendingMeshes).toEqual([{ mesh: meshV, material: view }]);
        });
        expect(state._recordedVersion).toBe(-1);
    });

    it("forgets the materials and views of casters that left the set", () => {
        const matA = shaderMaterial("A");
        const terminal = shaderMaterial("caster");
        const visible = shaderMaterial("visible", terminal);
        const meshA = caster("a", matA);
        const meshV = caster("v", visible);
        const { engine, scene, state } = setup([meshA, meshV]);
        const oldView = state._materialViews.get(visible);
        expect(oldView).toBeDefined();

        const current = ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA], state);

        expect([...current._materialViews.keys()]).toEqual([matA]);
        expect([...current._casterMaterials.keys()]).toEqual([matA]);
        expect([...current._casterMatGens.keys()]).toEqual([matA]);

        // Casting again later starts from a fresh view.
        ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA, meshV], current);
        const view = current._materialViews.get(visible)!;
        expect(view).not.toBe(oldView);
        expect(view.source).toBe(terminal);
        current._tasks.forEach((task) => expect(task._pendingMeshes).toEqual([{ mesh: meshV, material: view }]));
    });

    it("gives a caster joining with a former override terminal a fresh view after that terminal was rebuilt", () => {
        const formerTerminal = shaderMaterial("former caster");
        const visible = shaderMaterial("visible", formerTerminal);
        const meshV = caster("v", visible);
        const { engine, scene, state } = setup([meshV]);
        const staleView = state._materialViews.get(formerTerminal);
        expect(staleView).toBeDefined();

        setShadowCasterMaterial(visible, shaderMaterial("new caster"));
        let current = ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshV], state);
        record(current, scene);
        // `rebuildMaterial` through a mesh outside the caster set, then a caster using that material joins.
        formerTerminal._csmGen = 1;
        const meshO = caster("o", formerTerminal);
        current = ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshV, meshO], current);
        record(current, scene);

        const view = current._materialViews.get(formerTerminal)!;
        expect(view).not.toBe(staleView);
        expect(view.source).toBe(formerTerminal);
        current._tasks.forEach((task) => expect(packet(task, meshO).material).toBe(view));
    });

    it("publishes the replacement packet through the shadow scheduler before the map renders", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshB = caster("b", shaderMaterial("B"));
        const casters = [meshA, meshB];
        const engine = {} as EngineContext;
        const frames: { pending: number; renderables: CasterPacket[] }[][] = [];
        const generator: ShadowGenerator = {
            ...sg,
            _ensureShadowTaskState: (eng: EngineContext, scene: SceneContext, meshes: readonly Mesh[]) =>
                (generator._shadowTaskState = ensureCsmShadowTaskState(eng, scene, generator, cfg, meshes, generator._shadowTaskState ?? null)),
            _renderShadowMap: (_eng: EngineContext, state: CsmTaskState) => {
                frames.push(state._tasks.map((task) => ({ pending: task._pendingMeshes?.length ?? 0, renderables: task._renderables.slice() })));
                return 1;
            },
        } as unknown as ShadowGenerator;
        setShadowTaskCasterMeshes(generator, casters);
        generator._preloadPending = undefined;
        const scene = { ...makeScene(), lights: [{ shadowGenerator: generator }] } as unknown as SceneContext;
        const shadowTask = createShadowTask(engine, scene);

        shadowTask.record();
        expect(shadowTask.execute!()).toBe(1);
        const state = generator._shadowTaskState as CsmTaskState;
        const keptB = state._tasks.map((task) => packet(task, meshB));
        const oldA = state._tasks.map((task) => packet(task, meshA));

        matA._csmGen = 1; // rebuilt in place: no scene version moves
        expect(shadowTask.execute!()).toBe(1);

        expect(generator._shadowTaskState).toBe(state);
        const view = state._materialViews.get(matA)!;
        expect(view.source).toBe(matA);
        frames[1]!.forEach((cascade, c) => {
            expect(cascade.pending).toBe(0);
            expect(cascade.renderables[0]).toBe(keptB[c]);
            expect(cascade.renderables).toHaveLength(2);
            expect(cascade.renderables[1]!.mesh).toBe(meshA);
            expect(cascade.renderables[1]).not.toBe(oldA[c]);
            expect(cascade.renderables[1]!.material).toBe(view);
        });
    });

    it("ignores rebuilds and re-points of materials no caster uses", () => {
        const matA = shaderMaterial("A");
        const unrelated = shaderMaterial("unrelated");
        const meshA = caster("a", matA);
        const casters = [meshA];
        const { engine, scene, state } = setup(casters);
        const keptA = state._tasks.map((task) => packet(task, meshA));
        const recorded = state._recordedVersion;

        unrelated._csmGen = 1;
        setShadowCasterMaterial(unrelated, shaderMaterial("other"));
        scene._renderableVersion++; // the swap re-records every task through the scheduler anyway
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        expect(createdTasks).toHaveLength(2);
        expect(engine._retirements ?? []).toHaveLength(0);
        expect(state._recordedVersion).toBe(recorded);
        state._tasks.forEach((task, c) => {
            expect(task._pendingMeshes).toHaveLength(0);
            expect(task._renderables[0]).toBe(keptA[c]);
        });
    });

    it("forces no record or redraw when the same casters are re-supplied in a new array", () => {
        const meshA = caster("a", shaderMaterial("A"));
        const { engine, scene, state } = setup([meshA]);
        const keptA = state._tasks.map((task) => packet(task, meshA));
        const recorded = state._recordedVersion;

        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshA], state)).toBe(state);

        expect(state._recordedVersion).toBe(recorded);
        expect(state._lastCasterVersion).toBe(3);
        state._tasks.forEach((task, c) => {
            expect(task._pendingMeshes).toHaveLength(0);
            expect(task._renderables[0]).toBe(keptA[c]);
        });
    });

    it("requeues a rebuilt caster in the same reconcile that holds a joining caster whose material's group is not built", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshB = caster("b", shaderMaterial("B"));
        const { engine, scene, state } = setup([meshA, meshB]);
        const keptB = state._tasks.map((task) => packet(task, meshB));
        // A material whose group has no build in this scene yet: its caster waits for the build, without holding back
        // the requeue of an unrelated rebuilt caster.
        const unbuiltGroup = { _materialFamily: "shader" } as unknown as Material["_buildGroup"];
        const unbuilt = { name: "unbuilt", _buildGroup: unbuiltGroup, _uboVersion: 0 } as unknown as Material;
        const meshN = caster("n", unbuilt);
        const casters = [meshA, meshB, meshN];

        matA._csmGen = 1;
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(matA)!;
        expect(view.source).toBe(matA);
        expect(state._materialViews.has(unbuilt)).toBe(false);
        expect(state._casterMaxCascades.has(meshN)).toBe(false);
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toEqual([keptB[c]]);
            expect(task._pendingMeshes).toEqual([{ mesh: meshA, material: view }]);
        });
        expect(state._recordedVersion).toBe(-1);
        record(state, scene);

        // The group's build lands with nothing else changing: the hold lifts, so the same array runs the reconcile again.
        scene._groups.set(unbuiltGroup, { r: rebuild } as unknown as SceneMeshGroup);
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const joined = state._materialViews.get(unbuilt)!;
        expect(joined.source).toBe(unbuilt);
        state._tasks.forEach((task) => expect(task._pendingMeshes).toEqual([{ mesh: meshN, material: joined }]));
        expect(state._recordedVersion).toBe(-1);
        record(state, scene);
        state._tasks.forEach((task, c) => {
            expect(task._renderables.map((renderable) => renderable.mesh)).toEqual([meshB, meshA, meshN]);
            expect(task._renderables[0]).toBe(keptB[c]);
        });
    });

    it("holds a re-pointed caster whose family factory is missing out of every task, keeping the other packets", () => {
        const terminal = shaderMaterial("caster");
        const visible = shaderMaterial("visible", terminal);
        const meshV = caster("v", visible);
        const meshB = caster("b", shaderMaterial("B"));
        const casters = [meshV, meshB];
        const { engine, scene, state } = setup(casters);
        const keptB = state._tasks.map((task) => packet(task, meshB));
        const oldV = state._tasks.map((task) => packet(task, meshV));
        const recorded = state._recordedVersion;
        // The node no-colour factory is never imported in this file, like a family no caster had at preload.
        const nodeCaster = { name: "node", _buildGroup: { _materialFamily: "node" }, _uboVersion: 0 } as unknown as Material;
        setShadowCasterMaterial(visible, nodeCaster);

        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);

        // Its old packets may reference resources retired with its previous caster material, so it leaves every task until
        // the factory imports; it stays registered and its change pending. A drop needs a redraw, no record.
        expect(createdTasks).toHaveLength(2);
        expect(state._recordedVersion).toBe(recorded);
        expect(state._lastCasterVersion).toBe(-1);
        expect(state._casterMaxCascades.has(meshV)).toBe(true);
        expect(state._casterMaterials.get(visible)).toBe(terminal);
        expect(state._held).toEqual(new Set([meshV]));
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toEqual([keptB[c]]);
            expect(task._opaqueBindings.map((binding) => binding.renderable)).toEqual([keptB[c]]);
            expect(task._pendingMeshes).toHaveLength(0);
        });
        runRetirements(engine);
        oldV.forEach((renderable) => expect(disposer(renderable)).toHaveBeenCalledOnce());
        keptB.forEach((renderable) => expect(disposer(renderable)).not.toHaveBeenCalled());

        // While the hold is unchanged, the same caster array touches no task.
        const held = state._held;
        const bundles = state._tasks.map((task) => {
            const bundle = {} as GPURenderBundle;
            task._ob.push(bundle);
            task._lastVersion = scene._renderableVersion;
            return bundle;
        });
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, casters, state)).toBe(state);
        expect(state._held).toBe(held);
        state._tasks.forEach((task, c) => {
            expect(task._ob).toEqual([bundles[c]]);
            expect(task._lastVersion).toBe(scene._renderableVersion);
        });
        expect(engine._retirements).toHaveLength(0);
    });

    it("requeues a caster whose family has no no-colour view through its own material, as the first build queues it", () => {
        // Like the physics debug-line material: its group has no material family, so `getNoColorView` builds no view.
        const plainGroup = {} as unknown as Material["_buildGroup"];
        const plain = { name: "plain", _buildGroup: plainGroup, _uboVersion: 0, _csmGen: 0 } as unknown as Material;
        const meshP = caster("p", plain);
        const engine = {} as EngineContext;
        const scene = makeScene();
        scene._groups.set(plainGroup, { r: rebuild } as unknown as SceneMeshGroup);
        const state = ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshP], null);
        state._tasks.forEach((task) => expect(task._pendingMeshes).toEqual([{ mesh: meshP, material: plain }]));
        record(state, scene);

        plain._csmGen = 1;
        expect(ensureCsmShadowTaskState(engine, scene, sg, cfg, [meshP], state)).toBe(state);

        state._tasks.forEach((task) => {
            expect(task._renderables).toHaveLength(0);
            expect(task._pendingMeshes).toEqual([{ mesh: meshP, material: plain }]);
        });
        record(state, scene);
        state._tasks.forEach((task) => expect(packet(task, meshP).material).toBe(plain));
    });
});

describe("CSM static-cache caster reconcile", () => {
    beforeAll(async () => {
        await preloadPcfShadowTaskState([caster("preload", shaderMaterial("preload"))]);
    });

    beforeEach(() => {
        createdTasks.length = 0;
    });

    function setupCache(casters: readonly Mesh[]) {
        const engine = { _device: { createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })) } } as unknown as EngineContext;
        const scene = makeScene();
        const state = ensureCsmShadowCacheState(engine, scene, sg, cfg, casters, null) as CachedState;
        record(state, scene, [...state._staticTasks, ...state._tasks]);
        return { engine, scene, state };
    }

    /** Drive the real refit gate until `quiet` has been still long enough to demote into the static layer,
     *  while `churning` keeps moving and stays dynamic. Applies the moves the way the cached render does. */
    function demote(state: CachedState, quiet: Mesh, churning: Mesh): void {
        for (let frame = 0; frame < 125 && state._gate.isDynamic(quiet); frame++) {
            (churning as { worldMatrixVersion: number }).worldMatrixVersion++;
            state._gate.update(0, -1, 0, 0, false, false, state._onPromote, state._onDemote);
            for (const task of state._pendingTransfers) {
                rebuildTransferTarget(task);
            }
            state._pendingTransfers.clear();
        }
        expect(state._gate.isDynamic(quiet)).toBe(false);
        expect(state._gate.isDynamic(churning)).toBe(true);
    }

    it("requeues a rebuilt STATIC caster into the static layer without recreating the cache", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshB = caster("b", shaderMaterial("B"));
        const casters = [meshA, meshB];
        const { engine, scene, state } = setupCache(casters);
        demote(state, meshA, meshB);
        const oldA = state._staticTasks.map((task) => packet(task, meshA));
        const keptB = state._tasks.map((task) => packet(task, meshB));
        const created = createdTasks.length;

        matA._csmGen = 1;
        const next = ensureCsmShadowCacheState(engine, scene, sg, cfg, casters, state);

        expect(next).toBe(state);
        expect(engine._device.createTexture).toHaveBeenCalledOnce();
        expect(createdTasks).toHaveLength(created);
        const view = state._materialViews.get(matA)!;
        expect(view.source).toBe(matA);
        state._staticTasks.forEach((task) => {
            expect(task._renderables).toHaveLength(0);
            expect(task._pendingMeshes).toEqual([{ mesh: meshA, material: view }]);
        });
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toHaveLength(1);
            expect(task._renderables[0]).toBe(keptB[c]);
            expect(task._pendingMeshes).toHaveLength(0);
        });
        expect(state._gate.isDynamic(meshA)).toBe(false);
        expect(state._cachedContentVersion).toBe(-1);
        expect(state._recordedVersion).toBe(-1);

        runRetirements(engine);
        oldA.forEach((renderable) => expect(disposer(renderable)).toHaveBeenCalledOnce());
    });

    it("keeps a re-capped STATIC caster static and drops its depth above the new cap", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshB = caster("b", shaderMaterial("B"));
        const { engine, scene, state } = setupCache([meshA, meshB]);
        demote(state, meshA, meshB);
        const view = state._materialViews.get(matA);
        const oldA = state._staticTasks.map((task) => packet(task, meshA));
        const dynamic = state._tasks.map((task) => ({ renderables: task._renderables.slice(), bindings: task._opaqueBindings.slice() }));

        meshA._shadowMaxCascade = 0;
        expect(ensureCsmShadowCacheState(engine, scene, sg, cfg, [meshA, meshB], state)).toBe(state);

        expect(engine._device.createTexture).toHaveBeenCalledOnce();
        expect(state._staticTasks[0]!._renderables).toHaveLength(0);
        expect(state._staticTasks[0]!._pendingMeshes).toEqual([{ mesh: meshA, material: view }]);
        expect(state._staticTasks[1]!._renderables.some((renderable) => renderable.mesh === meshA)).toBe(false);
        expect(state._staticTasks[1]!._pendingMeshes!.some((request) => request.mesh === meshA)).toBe(false);
        state._tasks.forEach((task, c) => {
            expect(task._renderables).toEqual(dynamic[c]!.renderables);
            expect(task._opaqueBindings).toEqual(dynamic[c]!.bindings);
            expect(task._pendingMeshes).toHaveLength(0);
        });
        expect(state._gate.isDynamic(meshA)).toBe(false);
        expect(state._cachedContentVersion).toBe(-1);
        expect(state._recordedVersion).toBe(-1);

        runRetirements(engine);
        oldA.forEach((renderable) => expect(disposer(renderable)).toHaveBeenCalledOnce());
    });

    it("keeps the cached static layer when the same casters are re-supplied in a new array", () => {
        const meshA = caster("a", shaderMaterial("A"));
        const { engine, scene, state } = setupCache([meshA]);
        state._cachedContentVersion = scene._renderableVersion; // as left by a rendered refit

        expect(ensureCsmShadowCacheState(engine, scene, sg, cfg, [meshA], state)).toBe(state);

        expect(state._cachedContentVersion).toBe(scene._renderableVersion);
        expect(state._recordedVersion).toBe(scene._renderableVersion);
    });

    it("requeues a rebuilt DYNAMIC caster into the dynamic overlay and keeps the static packets", () => {
        const matA = shaderMaterial("A");
        const meshA = caster("a", matA);
        const meshS = caster("s", shaderMaterial("S"));
        const casters = [meshA, meshS];
        const { engine, scene, state } = setupCache(casters);
        demote(state, meshS, meshA);
        const keptS = state._staticTasks.map((task) => packet(task, meshS));
        const oldA = state._tasks.map((task) => packet(task, meshA));

        matA._csmGen = 1;
        expect(ensureCsmShadowCacheState(engine, scene, sg, cfg, casters, state)).toBe(state);

        const view = state._materialViews.get(matA) as MaterialView;
        expect(engine._device.createTexture).toHaveBeenCalledOnce();
        expect(state._gate.isDynamic(meshA)).toBe(true);
        state._tasks.forEach((task) => {
            expect(task._renderables).toHaveLength(0);
            expect(task._pendingMeshes).toEqual([{ mesh: meshA, material: view }]);
        });
        state._staticTasks.forEach((task, c) => {
            expect(task._renderables).toEqual([keptS[c]]);
            expect(task._pendingMeshes).toHaveLength(0);
        });
        expect(state._cachedContentVersion).toBe(-1);
        expect(state._recordedVersion).toBe(-1);

        // The forced record re-binds every static task, but builds no static packet again.
        record(state, scene, [...state._staticTasks, ...state._tasks]);
        state._staticTasks.forEach((task, c) => expect(task._renderables).toEqual([keptS[c]]));
        state._tasks.forEach((task, c) => {
            expect(packet(task, meshA)).not.toBe(oldA[c]);
            expect(packet(task, meshA).material).toBe(view);
        });
        runRetirements(engine);
        oldA.forEach((renderable) => expect(disposer(renderable)).toHaveBeenCalledOnce());
        keptS.forEach((renderable) => expect(disposer(renderable)).not.toHaveBeenCalled());
    });
});

describe("CSM caster reconcile of the same caster array around a hold", () => {
    beforeAll(async () => {
        await preloadPcfShadowTaskState([caster("preload", shaderMaterial("preload"))]);
    });

    beforeEach(() => {
        createdTasks.length = 0;
    });

    it.each([
        ["default", "joined"],
        ["cache", "joined"],
        ["default", "had its change reverted"],
        ["cache", "had its change reverted"],
    ] as const)("leaves the %s cascades alone for the same caster array once the held caster has %s", (hooks, end) => {
        const matA = shaderMaterial("A");
        const matB = shaderMaterial("B");
        const meshA = caster("a", matA);
        const meshB = caster("b", matB);
        // A material whose group has no build in this scene yet: its caster is held until the build lands.
        const unbuiltGroup = { _materialFamily: "shader" } as unknown as Material["_buildGroup"];
        const unbuilt = { name: "unbuilt", _buildGroup: unbuiltGroup, _uboVersion: 0 } as unknown as Material;
        const joined = end === "joined";
        const { engine, scene, state, tasks, ensure } = start(hooks, joined ? [meshA] : [meshA, meshB]);
        let casters: readonly Mesh[];
        if (joined) {
            // A caster joins with the unbuilt material; its build then lands with nothing else changing.
            casters = [meshA, caster("n", unbuilt)];
            ensure(casters);
            expect(state._held).toEqual(new Set([casters[1]]));
            scene._groups.set(unbuiltGroup, { r: rebuild } as unknown as SceneMeshGroup);
        } else {
            // A registered caster switches to the unbuilt material and is re-capped meanwhile; the switch is reverted.
            meshB.material = unbuilt;
            meshB._shadowMaxCascade = 0;
            casters = [meshA, meshB];
            ensure(casters);
            expect(state._held).toEqual(new Set([meshB]));
            meshB.material = matB;
        }
        ensure(casters);
        expect(state._held).toBeUndefined();
        record(state, scene, tasks());
        // Applied: the joined caster casts into both cascades, the reverted one at its new cap only.
        expect(state._tasks.map((task) => task._renderables.some((renderable) => renderable.mesh === casters[1]))).toEqual(joined ? [true, true] : [true, false]);
        // As left by rendered frames: recorded bundles, and with static caching a rendered refit.
        const bundles = tasks().map((task) => {
            const bundle = {} as GPURenderBundle;
            task._ob.push(bundle);
            task._lastVersion = scene._renderableVersion;
            return bundle;
        });
        state._cachedContentVersion = scene._renderableVersion;
        const views = new Map(state._materialViews);
        const retirements = engine._retirements?.length ?? 0;
        const packets = tasks().map((task) => task._renderables.slice());

        ensure(casters);
        ensure(casters);

        tasks().forEach((task, t) => {
            expect(task._lastVersion).toBe(scene._renderableVersion);
            expect(task._ob).toHaveLength(1);
            expect(task._ob[0]).toBe(bundles[t]);
            expect(task._renderables).toEqual(packets[t]);
            expect(task._pendingMeshes ?? []).toHaveLength(0);
        });
        expect(engine._retirements?.length ?? 0).toBe(retirements);
        expect(state._materialViews.size).toBe(views.size);
        for (const [material, view] of state._materialViews) {
            expect(view).toBe(views.get(material));
        }
        expect(state._recordedVersion).toBe(scene._renderableVersion);
        expect(state._lastCasterVersion).toBe(3);
        expect(state._cachedContentVersion).toBe(scene._renderableVersion);
        expect(createdTasks).toHaveLength(hooks === "default" ? 2 : 4);
    });

    it.each([
        ["default", "joining"],
        ["cache", "joining"],
        ["default", "registered"],
        ["cache", "registered"],
    ] as const)("forces no %s record, redraw or refit when the same casters are re-supplied in new arrays while a %s caster stays held", (hooks, kind) => {
        const meshA = caster("a", shaderMaterial("A"));
        const meshB = caster("b", shaderMaterial("B"));
        // A material whose group is never built in this scene: its caster stays held.
        const unbuilt = { name: "unbuilt", _buildGroup: { _materialFamily: "shader" }, _uboVersion: 0 } as unknown as Material;
        const { engine, scene, state, tasks, ensure } = start(hooks, kind === "joining" ? [meshA] : [meshA, meshB]);
        meshB.material = unbuilt;
        ensure([meshA, meshB]);
        const held = state._held;
        expect(held).toEqual(new Set([meshB]));
        // As left by rendered frames: recorded cascades, a drawn map, and with static caching a rendered refit.
        record(state, scene, tasks());
        state._cachedContentVersion = scene._renderableVersion;
        runRetirements(engine);
        const packets = tasks().map((task) => task._renderables.slice());

        for (let frame = 0; frame < 3; frame++) {
            ensure([meshA, meshB]);
        }

        expect(state._held).toBe(held);
        expect(state._recordedVersion).toBe(scene._renderableVersion);
        expect(state._lastCasterVersion).toBe(3);
        expect(state._cachedContentVersion).toBe(scene._renderableVersion);
        expect(engine._retirements ?? []).toHaveLength(0);
        tasks().forEach((task, t) => {
            expect(task._renderables).toEqual(packets[t]);
            expect(task._pendingMeshes ?? []).toHaveLength(0);
        });
    });
});

describe("CSM caster reconcile of a caster joining with a rebuilt override terminal", () => {
    beforeAll(async () => {
        await preloadPcfShadowTaskState([caster("preload", shaderMaterial("preload"))]);
    });

    /** The views `mesh` casts through in `tasks`, one per packet. */
    function castViews(tasks: readonly RenderTask[], mesh: Mesh): (Material | undefined)[] {
        return tasks.flatMap((task) => task._renderables.filter((renderable) => renderable.mesh === mesh).map((renderable) => (renderable as CasterPacket).material));
    }

    it.each([
        ["default", "lost its caster"],
        ["cache", "lost its caster"],
        ["default", "was re-pointed"],
        ["cache", "was re-pointed"],
    ] as const)("gives a caster joining the %s cascades a fresh view of a rebuilt terminal another chain cached, when that chain %s in the same ensure", (hooks, end) => {
        const terminal = shaderMaterial("caster");
        const other = shaderMaterial("other");
        const visible = shaderMaterial("visible", terminal);
        const meshA = caster("a", visible);
        const { scene, state, tasks, ensure } = start(hooks, [meshA]);
        const oldView = state._materialViews.get(terminal)!;
        expect(state._materialViews.get(visible)).toBe(oldView);

        const departs = end === "lost its caster";
        if (!departs) {
            setShadowCasterMaterial(visible, other);
        }
        terminal._csmGen = 1; // rebuilt through a mesh outside the caster set
        const meshN = caster("n", terminal);
        ensure(departs ? [meshN] : [meshA, meshN]);
        record(state, scene, tasks());

        const view = state._materialViews.get(terminal)!;
        expect(view).not.toBe(oldView);
        expect(view.source).toBe(terminal);
        const joined = castViews(tasks(), meshN);
        expect(joined).toHaveLength(2);
        joined.forEach((material) => expect(material).toBe(view));
        const kept = castViews(tasks(), meshA);
        expect(kept).toHaveLength(departs ? 0 : 2);
        kept.forEach((material) => expect((material as MaterialView).source).toBe(other));
        expect([...state._materialViews.values()]).not.toContain(oldView);
    });
});
