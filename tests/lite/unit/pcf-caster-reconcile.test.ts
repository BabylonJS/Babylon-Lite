import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type * as RenderTaskModule from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { RenderTask, RenderTaskConfig } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { Material, MaterialView } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshRebuildResources, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type * as ShadowBase from "../../../packages/babylon-lite/src/shadow/shadow-base";
import type { PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { enableDeformableShadowBounds } from "../../../packages/babylon-lite/src/shadow/deformable-shadow-casters";

vi.mock("../../../packages/babylon-lite/src/shadow/shadow-base.js", async (importOriginal) => ({
    ...(await importOriginal<typeof ShadowBase>()),
    createShadowCamera: () => ({ worldMatrixVersion: 0 }),
    updateShadowCameraBase: vi.fn(),
}));

// Keep real queueing, binding transactions and fenced packet retirement, without GPU render targets.
vi.mock("../../../packages/babylon-lite/src/frame-graph/render-task.js", async (importOriginal) => {
    const actual = await importOriginal<typeof RenderTaskModule>();
    return {
        ...actual,
        createRenderTask: vi.fn((config: RenderTaskConfig, engine: EngineContext, scene: SceneContext) => {
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
                record: vi.fn(() => {
                    if (task._pendingMeshes) {
                        actual._rebindRenderTask(task);
                    }
                    task._sceneBG = {} as GPUBindGroup;
                }),
                execute: vi.fn(() => task._renderables.length),
                dispose: vi.fn(),
            } as unknown as RenderTask;
            return task;
        }),
    };
});

const { createRenderTask } = await import("../../../packages/babylon-lite/src/frame-graph/render-task");
const { setShadowTaskCasterMeshes } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-inputs");
const { createShadowTask } = await import("../../../packages/babylon-lite/src/frame-graph/shadow-task");
const { ensurePcfShadowTaskState, preloadPcfShadowTaskState, renderPcfShadowMap } = await import("../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks");

const shaderGroup = { _materialFamily: "shader" } as unknown as Material["_buildGroup"];
function material(name: string, override?: Material): Material {
    return { name, _buildGroup: shaderGroup, _csmGen: 0, _shadowCasterMaterial: override } as Material;
}

function caster(name: string, mat: Material | null = material(name)): Mesh {
    return { name, material: mat, _renderableGen: 0, worldMatrixVersion: 0, thinInstances: null } as unknown as Mesh;
}

type Packet = Renderable & { material: MaterialView };
const rebuild = vi.fn((_scene: SceneContext, mesh: Mesh, view?: Material, resources?: MeshRebuildResources): Renderable => {
    resources!._lifetimeDisposers.push(vi.fn());
    const packet = { mesh, material: view, order: 0, bind: vi.fn(() => ({ renderable: packet })) } as unknown as Packet;
    return packet;
});

function setup(casters: readonly Mesh[]) {
    const engine = { _device: { queue: { writeBuffer: vi.fn() } } } as unknown as EngineContext;
    const sg = {
        _config: { _mapSize: 64, _bias: 0 },
        _depthTexture: { createView: () => ({}) },
        _light: { _lightVersion: 0, lightType: "directional" },
        _lightMatrix: new Float32Array(16),
        _depthValues: new Float32Array(2),
        _shadowsInfo: new Float32Array(4),
        _version: 0,
    } as unknown as ShadowGenerator;
    const scene = { lights: [{ shadowGenerator: sg }], _renderableVersion: 1, _groups: new Map([[shaderGroup, { r: rebuild }]]) } as unknown as SceneContext;
    const state = ensurePcfShadowTaskState(engine, scene, sg, casters, null);
    state._task.record();
    state._recordedVersion = scene._renderableVersion;
    state._lastCasterVersion = 0;
    const ensure = (next = casters): PcfTaskState => ensurePcfShadowTaskState(engine, scene, sg, next, state);
    return { engine, scene, sg, state, task: state._task, ensure };
}

function packet(state: PcfTaskState, mesh: Mesh): Packet {
    const found = state._task._renderables.find((entry) => entry.mesh === mesh);
    expect(found).toBeDefined();
    return found as Packet;
}

function fence(engine: EngineContext): void {
    for (const retire of engine._retirements?.splice(0) ?? []) {
        retire();
    }
}

describe("incremental PCF casters", () => {
    beforeAll(async () => {
        await preloadPcfShadowTaskState([caster("preload")]);
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("keeps the task, target, camera, UBO and old packets when adding a caster, binding once through the scheduler", async () => {
        const shared = material("shared");
        const a = caster("a", shared);
        const b = caster("b", shared);
        const { engine, scene, sg, state, task } = setup([a]);
        const old = packet(state, a);
        const target = task._config.rt;
        const camera = state._camera;
        const ubo = state._shadowUboData;
        sg._shadowTaskState = state;
        sg._ensureShadowTaskState = (eng, sc, meshes) => (sg._shadowTaskState = ensurePcfShadowTaskState(eng, sc, sg, meshes, sg._shadowTaskState ?? null));
        sg._renderShadowMap = (_eng, current) => (current as PcfTaskState)._task.execute!();
        const scheduler = createShadowTask(engine, scene);
        setShadowTaskCasterMeshes(sg, [a, b]);
        await scheduler._preload!();
        vi.mocked(task.record).mockClear();
        vi.mocked(old.bind).mockClear();
        rebuild.mockClear();

        expect(scheduler.execute!()).toBe(2);

        expect(sg._shadowTaskState).toBe(state);
        expect(createRenderTask).toHaveBeenCalledOnce();
        expect(task._config.rt).toBe(target);
        expect(state._camera).toBe(camera);
        expect(state._shadowUboData).toBe(ubo);
        expect(packet(state, a)).toBe(old);
        expect(packet(state, b).material).toBe(old.material);
        expect(rebuild).toHaveBeenCalledExactlyOnceWith(scene, b, old.material, expect.anything());
        expect(task.record).toHaveBeenCalledOnce();
        expect(old.bind).toHaveBeenCalledOnce();
        expect(task.dispose).not.toHaveBeenCalled();
        scheduler.execute!();
        expect(task.record).toHaveBeenCalledOnce();
    });

    it("queues several additions without synchronous per-caster rebinds", () => {
        const a = caster("a");
        const { state, task, ensure } = setup([a]);
        const old = packet(state, a);
        vi.mocked(old.bind).mockClear();
        rebuild.mockClear();
        const added = [caster("b"), caster("c")];
        expect(ensure([a, ...added])).toBe(state);
        expect(rebuild).not.toHaveBeenCalled();
        expect(old.bind).not.toHaveBeenCalled();
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual(added);
        task.record();
        expect(rebuild).toHaveBeenCalledTimes(2);
        expect(old.bind).toHaveBeenCalledOnce();
        expect(task.execute!()).toBe(3);
    });

    it("drops only the removed caster, selects batches once and fences only its resources", () => {
        const a = caster("a");
        const b = caster("b");
        const { engine, state, task, ensure } = setup([a, b]);
        const removed = packet(state, a);
        const kept = packet(state, b);
        const select = vi.fn(() => undefined);
        const release = vi.fn();
        task._batchState = { _select: select, _release: release } as unknown as NonNullable<RenderTask["_batchState"]>;

        expect(ensure([b])).toBe(state);

        expect(task._renderables).toEqual([kept]);
        expect(task._opaqueBindings.map(({ renderable }) => renderable)).toEqual([kept]);
        expect(select).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(state._recordedVersion).toBe(1);
        expect(state._lastCasterVersion).toBe(-1);
        expect(removed._lifetimeDisposers![0]).not.toHaveBeenCalled();
        fence(engine);
        expect(removed._lifetimeDisposers![0]).toHaveBeenCalledOnce();
        expect(kept._lifetimeDisposers![0]).not.toHaveBeenCalled();
        expect(state._materialSnapshots.has(a.material!)).toBe(false);
    });

    it.each(["material", "generation", "features", "mesh"] as const)("requeues only the caster with a changed %s", (change) => {
        const a = caster("a");
        const b = caster("b");
        const { state, task, ensure } = setup([a, b]);
        const old = packet(state, a);
        const kept = packet(state, b);
        if (change === "material") {
            a.material = material("replacement");
        } else if (change === "generation") {
            a.material!._csmGen!++;
        } else if (change === "features") {
            a.material!._renderFeatures = { features: 1 };
        } else {
            a._renderableGen!++;
        }

        expect(ensure()).toBe(state);
        expect(task._renderables).toEqual([kept]);
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual([a]);
        expect(state._recordedVersion).toBe(-1);
        task.record();
        expect(packet(state, b)).toBe(kept);
        expect(packet(state, a).material.source).toBe(a.material);
        expect(packet(state, a).material === old.material).toBe(change === "mesh");
        const binds = vi.mocked(kept.bind).mock.calls.length;
        ensure();
        expect(task._pendingMeshes).toEqual([]);
        expect(kept.bind).toHaveBeenCalledTimes(binds);
    });

    it("invalidates shared stale override chains before building one fresh view", () => {
        const terminal = material("terminal");
        const a = caster("a", material("receive-a", terminal));
        const b = caster("b", material("receive-b", terminal));
        const { state, task, ensure } = setup([a, b]);
        const old = packet(state, a).material;
        terminal._csmGen!++;
        ensure();
        expect(task._pendingMeshes).toHaveLength(2);
        expect(task._pendingMeshes![0]!.material).toBe(task._pendingMeshes![1]!.material);
        expect(task._pendingMeshes![0]!.material).not.toBe(old);
        expect(state._casterSnapshots.get(a)!._terminal).toBe(terminal);
        expect(state._casterSnapshots.get(b)!._terminal).toBe(terminal);
        expect(state._materialSnapshots.get(terminal)!._generation).toBe(1);
    });

    it("shares a current terminal view with a joining receive-material override without requeueing its peers", () => {
        const terminal = material("terminal");
        const a = caster("a", material("receive-a", terminal));
        const b = caster("b", material("receive-b", terminal));
        const { state, task, ensure } = setup([a]);
        const kept = packet(state, a);
        ensure([a, b]);
        expect(task._renderables).toEqual([kept]);
        expect(task._pendingMeshes).toEqual([{ mesh: b, material: kept.material }]);
        task.record();
        expect(packet(state, a)).toBe(kept);
        expect(packet(state, b).material).toBe(kept.material);
    });

    it("keeps an own-material caster held even when an override has refreshed the shared terminal cache", () => {
        const terminal = material("terminal");
        const own = caster("own", terminal);
        const override = caster("override", material("receive", terminal));
        const { scene, state, task, ensure } = setup([own, override]);
        const group = scene._groups.get(shaderGroup)!;
        scene._groups.clear();
        terminal._csmGen!++;
        ensure();
        expect(state._casterSnapshots.get(own)).toBeNull();
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual([override]);
        ensure();
        expect(state._casterSnapshots.get(own)).toBeNull();
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual([override]);
        scene._groups.set(shaderGroup, group);
        ensure();
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual([override, own]);
        task.record();
        expect(packet(state, own).material).toBe(packet(state, override).material);
    });

    it("holds a caster reassigned to an unbuilt own material even when an override already cached its view", () => {
        const terminal = material("terminal");
        const a = caster("a");
        const b = caster("override", material("receive", terminal));
        const { scene, state, task, ensure } = setup([a, b]);
        const kept = packet(state, b);
        const group = scene._groups.get(shaderGroup)!;
        scene._groups.clear();
        a.material = terminal;
        ensure();
        expect(state._casterSnapshots.get(a)).toBeNull();
        expect(task._renderables).toEqual([kept]);
        expect(task._pendingMeshes).toEqual([]);
        scene._groups.set(shaderGroup, group);
        ensure();
        expect(task._pendingMeshes).toEqual([{ mesh: a, material: kept.material }]);
        task.record();
        expect(packet(state, a).material).toBe(kept.material);
    });

    it("adopts a reordered identical set without invalidating packets or bundles", () => {
        const a = caster("a");
        const b = caster("b");
        const { state, task, ensure } = setup([a, b]);
        const packets = task._renderables.slice();
        const bundle = {} as GPURenderBundle;
        task._ob.push(bundle);
        task._lastVersion = 1;
        const next = [b, a];
        ensure(next);
        expect(state._casterMeshes).toBe(next);
        expect(task._renderables).toEqual(packets);
        expect(task._ob).toEqual([bundle]);
        expect(task._lastVersion).toBe(1);
        expect(state._lastCasterVersion).toBe(0);
    });

    it("drops changed pending requests before the first recording", () => {
        const a = caster("a");
        const { engine, scene, sg } = setup([]);
        const state = ensurePcfShadowTaskState(engine, scene, sg, [a], null);
        a.material = material("replacement");
        ensurePcfShadowTaskState(engine, scene, sg, [a], state);
        expect(state._task._pendingMeshes).toHaveLength(1);
        expect((state._task._pendingMeshes![0]!.material as MaterialView).source).toBe(a.material);
        state._task.record();
        expect(state._task._renderables).toHaveLength(1);
    });

    it("keeps the captured feature snapshot while adopting a set during a pending material rebuild", () => {
        const a = caster("a");
        const features = { features: 1 };
        a.material._renderFeatures = features;
        const { state, task, ensure } = setup([a]);
        const old = packet(state, a);
        a.material._renderFeatures = undefined;
        ensure([a]);
        expect(state._materialSnapshots.get(a.material)!._features).toBe(features);
        a.material._renderFeatures = features;
        ensure([a]);
        expect(packet(state, a)).toBe(old);
        expect(task._pendingMeshes).toEqual([]);
    });

    it("forgets a removed held caster without redrawing an unchanged empty map", () => {
        const a = caster("a");
        const { scene, state, task, ensure } = setup([]);
        scene._groups.clear();
        ensure([a]);
        expect(state._casterSnapshots.get(a)).toBeNull();
        state._lastCasterVersion = 0;
        ensure([]);
        expect(state._casterSnapshots.has(a)).toBe(false);
        expect(state._lastCasterVersion).toBe(0);
        expect(task._pendingMeshes).toBeUndefined();
    });

    it("removes a materialless caster's old packet, then queues its first usable material", () => {
        const a = caster("a");
        const { state, task, ensure } = setup([a]);
        Object.assign(a, { material: null });
        ensure();
        expect(task._renderables).toEqual([]);
        expect(state._casterSnapshots.get(a)).toBeNull();
        a.material = material("next");
        ensure();
        expect(task._pendingMeshes).toHaveLength(1);
        task.record();
        expect(packet(state, a).material.source).toBe(a.material);
    });

    it("holds an unbuilt caster once and rejoins in the same task when the group becomes available", () => {
        const a = caster("a");
        const b = caster("b");
        const { engine, scene, state, task, ensure } = setup([a, b]);
        const kept = packet(state, b);
        a.material = { ...material("building"), _buildGroup: { _materialFamily: "shader" } } as Material;
        ensure();
        expect(state._casterSnapshots.get(a)).toBeNull();
        expect(task._renderables).toEqual([kept]);
        expect(task._pendingMeshes).toEqual([]);
        fence(engine);
        ensure();
        ensure();
        expect(engine._retirements).toEqual([]);
        scene._groups.set(a.material._buildGroup, scene._groups.get(shaderGroup)!);
        ensure();
        expect(state._casterSnapshots.get(a)!._material).toBe(a.material);
        expect(task._pendingMeshes?.map(({ mesh }) => mesh)).toEqual([a]);
        task.record();
        expect(packet(state, b)).toBe(kept);
        expect(createRenderTask).toHaveBeenCalledOnce();
    });

    it("redraws stationary casters after a material change without a scene version bump", () => {
        const a = caster("a");
        const { engine, sg, state, task, ensure } = setup([a]);
        const compute = vi.fn(() => ({ _view: new Float32Array(16), _viewProj: new Float32Array(16), _near: 1, _far: 10 }));
        renderPcfShadowMap(engine, sg, state, compute);
        expect(renderPcfShadowMap(engine, sg, state, compute)).toBe(0);
        a.material!._csmGen!++;
        ensure();
        task.record();
        expect(renderPcfShadowMap(engine, sg, state, compute)).toBe(1);
        expect(compute).toHaveBeenCalledTimes(2);
        expect(engine._device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    });

    it.each(["texture", "size"] as const)("rebuilds behind the frame fence only when the captured target %s changes", (change) => {
        const { engine, sg, state, task, ensure } = setup([caster("a")]);
        if (change === "texture") {
            sg._depthTexture = { createView: () => ({}) } as unknown as GPUTexture;
        } else {
            sg._config._mapSize = 128;
        }
        const next = ensure();
        expect(next).not.toBe(state);
        expect(next._task._config.rt._depthTexture).toBe(sg._depthTexture);
        expect(next._task._config.rt._width).toBe(sg._config._mapSize);
        expect(task.dispose).not.toHaveBeenCalled();
        fence(engine);
        expect(task.dispose).toHaveBeenCalledOnce();
    });

    it("drops actual deformable substitute meshes when a preloaded caster set is re-supplied", async () => {
        const a = caster("a");
        const b = caster("b");
        const { engine, scene, sg, state } = setup([]);
        sg._shadowTaskState = state;
        sg._preloadShadowTask = preloadPcfShadowTaskState;
        sg._ensureShadowTaskState = (eng, sc, meshes) => (sg._shadowTaskState = ensurePcfShadowTaskState(eng, sc, sg, meshes, sg._shadowTaskState ?? null));
        sg._renderShadowMap = () => 0;
        enableDeformableShadowBounds(sg, { kind: "morph", applies: () => true, getLocalBounds: () => null });
        const casters = [a, b];
        await sg._preloadShadowTask!(casters);
        sg._ensureShadowTaskState!(engine, scene, casters)._task.record();
        const old = state._task._renderables.slice();
        expect(old.every(({ mesh }) => mesh !== a && mesh !== b)).toBe(true);
        const next = [b];
        await sg._preloadShadowTask!(next);
        expect(sg._ensureShadowTaskState!(engine, scene, next)).toBe(state);
        state._task.record();
        expect(state._task._renderables).toHaveLength(1);
        expect(state._task._renderables[0]!.mesh!.name).toBe("b");
        expect(state._casterMeshes).toBe(next);
        expect(state._task._renderables.some((entry) => old.includes(entry))).toBe(false);
    });
});
