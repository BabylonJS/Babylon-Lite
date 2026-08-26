import { describe, expect, it, vi } from "vitest";

import { rebuildSceneRenderables } from "../../../packages/babylon-lite/src/scene/scene-rebuild";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import { disposeScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";

function fakeScene(): SceneContext {
    return {
        surface: { engine: { _retirements: null }, _renderingContexts: [] },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        shadowGenerators: [],
        _beforeRender: [],
        _renderables: [],
        _prePasses: [],
        _pickSources: [],
        _uniformUpdaters: [],
        _materialSwapQueue: [],
        _deferredBuilders: [],
        _disposables: [],
        _groups: new Map(),
        _builtGroups: new Set(),
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _lightListVersion: 0,
        _renderableVersion: 0,
        _materialEpoch: 0,
        _built: true,
        _frameGraph: { _tasks: [], build: vi.fn() },
    } as unknown as SceneContext;
}

/** Minimal renderable — only `order` and `mesh` are read by the rebuild. */
function renderable(order: number, mesh?: unknown): Renderable {
    return { order, mesh } as unknown as Renderable;
}

/** A group builder producing one MERGED renderable (no `mesh` back-reference, like several meshes
 *  sharing a material) per call, so successive builds are distinguishable. */
function fakeBuilder(order = 1): MeshGroupBuilder & { calls: number } {
    let calls = 0;
    const builder = (async () => {
        calls++;
        builder.calls = calls;
        return { renderables: [renderable(order)], rebuildSingle: () => renderable(order) };
    }) as unknown as MeshGroupBuilder & { calls: number };
    builder.calls = 0;
    return builder;
}

/** Drain the retirement queue the way a submitted frame would. */
function drainRetirements(scene: SceneContext): void {
    const engine = scene.surface.engine as { _retirements?: Array<() => void> | null };
    const retirements = engine._retirements ?? [];
    engine._retirements = null;
    retirements.forEach((fn) => fn());
}

describe("rebuildSceneRenderables", () => {
    it("is a no-op before the scene's initial build", async () => {
        const scene = fakeScene();
        scene._built = false;
        const builder = fakeBuilder();
        scene._groups.set(builder, [{ material: { _buildGroup: builder } } as never]);

        await rebuildSceneRenderables(scene);
        expect(builder.calls).toBe(0);
    });

    it("replaces group output while preserving feature-owned renderables", async () => {
        const scene = fakeScene();
        const builder = fakeBuilder(1);
        const mesh = { material: { _buildGroup: builder } } as never;
        scene.meshes.push(mesh);

        // Simulate the initial build: a group renderable (merged, no `mesh` back-reference) plus a
        // skybox renderable pushed straight into _renderables by a loader.
        const groupRenderable = renderable(1);
        const skybox = renderable(0);
        scene._renderables.push(skybox, groupRenderable);
        scene._groups.set(builder, [mesh]);
        (scene._groups.get(builder) as unknown as { o?: Renderable[] }).o = [groupRenderable];

        await rebuildSceneRenderables(scene);

        expect(builder.calls).toBe(1);
        expect(scene._renderables).toContain(skybox);
        expect(scene._renderables).not.toContain(groupRenderable);
        expect(scene._renderables).toHaveLength(2);
        // Sorted by order — the skybox (order 0) stays first.
        expect(scene._renderables[0]).toBe(skybox);
        expect(scene._renderableVersion).toBe(1);
        expect(scene._materialEpoch).toBe(1);
        expect(scene._rebuildHook).toBeUndefined();
    });

    it("rebuilds a material-swapped mesh through its CURRENT family builder", async () => {
        const scene = fakeScene();
        const groupBuilder = fakeBuilder(1);
        const otherBuilder = fakeBuilder(1);
        // Mesh A stays in this group; mesh B was material-swapped to another family. The swap path never
        // migrates group membership, so the rebuild must reconcile it — otherwise mesh B would keep the
        // renderable it was given at swap time, still bound to the removed light's shadow resources.
        const meshA = { material: { _buildGroup: groupBuilder } } as never;
        const meshB = { material: { _buildGroup: otherBuilder } } as never;
        scene.meshes.push(meshA, meshB);
        scene._groups.set(groupBuilder, [meshA, meshB] as never);

        await rebuildSceneRenderables(scene);
        await rebuildSceneRenderables(scene);

        expect(groupBuilder.calls).toBe(2);
        expect(otherBuilder.calls).toBe(2); // rebuilt through its own family, not the stale group
        // Two rebuilds must leave ONE renderable per group, not one per rebuild: the merged renderable of the
        // previous build carries no mesh back-reference and is dropped by tracked-ownership identity.
        expect(scene._renderables).toHaveLength(2);
    });

    it("retires the old per-mesh disposers only after the rebuild, and never the aux ones", async () => {
        const scene = fakeScene();
        const builder = fakeBuilder();
        const mesh = { material: { _buildGroup: builder } } as never;
        scene.meshes.push(mesh);
        scene._groups.set(builder, [mesh]);

        let disposedAtCall = -1;
        scene._meshDisposables.set(mesh, [
            () => {
                disposedAtCall = builder.calls;
            },
        ]);
        let auxDisposed = false;
        scene._meshAuxDisposables.set(mesh, [() => (auxDisposed = true)]);

        await rebuildSceneRenderables(scene);
        expect(disposedAtCall).toBe(-1); // deferred, not run inline

        drainRetirements(scene);
        expect(disposedAtCall).toBe(1); // ran AFTER the new build (make-before-break)
        expect(auxDisposed).toBe(false); // aux disposers belong to other tasks
    });

    it("keeps group-rebuild disposer packets reachable while the async builder is blocked", async () => {
        const scene = fakeScene();
        let enterBuilder!: () => void;
        const enteredBuilder = new Promise<void>((resolve) => {
            enterBuilder = resolve;
        });
        let unblockBuilder!: () => void;
        const blockedBuilder = new Promise<void>((resolve) => {
            unblockBuilder = resolve;
        });
        const builder = (async () => {
            enterBuilder();
            await blockedBuilder;
            return { renderables: [renderable(1)], rebuildSingle: () => renderable(1) };
        }) as unknown as MeshGroupBuilder;
        const mesh = { material: { _buildGroup: builder } } as never;
        const oldDisposers: (() => void)[] = [];
        scene.meshes.push(mesh);
        scene._groups.set(builder, [mesh]);
        scene._meshDisposables.set(mesh, oldDisposers);

        const rebuilding = rebuildSceneRenderables(scene);
        await enteredBuilder;

        expect(scene._meshDisposables.has(mesh)).toBe(false);
        const pending = scene._runtimeBuilds?.pendingDisposers(mesh);
        expect(pending).toBe(oldDisposers);
        let deferredTeardownRan = false;
        pending?.push(() => {
            deferredTeardownRan = true;
        });
        expect(deferredTeardownRan).toBe(false);

        unblockBuilder();
        await rebuilding;

        expect(scene._runtimeBuilds?.pendingDisposers(mesh)).toBeUndefined();
        expect(deferredTeardownRan).toBe(false);
        drainRetirements(scene);
        expect(deferredTeardownRan).toBe(true);
    });

    it("keeps a deferred topology teardown queued when a later group's build rejects", async () => {
        const scene = fakeScene();
        const okBuilder = fakeBuilder(1);
        const failingBuilder = (async () => {
            throw new Error("builder failed");
        }) as unknown as MeshGroupBuilder;
        const meshA = { material: { _buildGroup: okBuilder } } as never;
        const meshB = { material: { _buildGroup: failingBuilder } } as never;
        scene.meshes.push(meshA, meshB);
        scene._groups.set(okBuilder, [meshA] as never);
        scene._groups.set(failingBuilder, [meshB] as never);
        let retired = false;
        scene._pendingTopologyRetirements = [() => (retired = true)];

        await expect(rebuildSceneRenderables(scene)).rejects.toThrow("builder failed");
        drainRetirements(scene);

        // The failing group still binds the removed generator's resources — freeing them would be a
        // use-after-free. They stay queued for the next successful rebuild (or disposeScene).
        expect(retired).toBe(false);
        expect(scene._pendingTopologyRetirements).toHaveLength(1);
        // The group that DID commit is still finalised (sorted + version bumped) rather than left dangling.
        expect(scene._renderableVersion).toBe(1);
    });

    it("retries a merged build whose group changed while the builder was awaited", async () => {
        const scene = fakeScene();
        const meshA = {} as never;
        const meshB = {} as never;
        let calls = 0;
        // Merged output (no `mesh` back-reference) covering every mesh handed to the builder. The first
        // attempt loses meshB mid-build, so committing would keep drawing its freed buffers; the retry sees
        // the settled membership and commits cleanly.
        const builder = (async (_scene: unknown, meshes: unknown[]) => {
            calls++;
            if (calls === 1) {
                scene.meshes.splice(scene.meshes.indexOf(meshB), 1);
            }
            return { renderables: [renderable(1)], rebuildSingle: () => renderable(1), builtCount: meshes.length };
        }) as unknown as MeshGroupBuilder;
        (meshA as unknown as { material: unknown }).material = { _buildGroup: builder };
        (meshB as unknown as { material: unknown }).material = { _buildGroup: builder };
        scene.meshes.push(meshA, meshB);
        scene._groups.set(builder, [meshA, meshB] as never);
        const previous = renderable(1);
        scene._renderables.push(previous);
        (scene._groups.get(builder) as unknown as { o?: Renderable[] }).o = [previous];
        let retired = false;
        scene._pendingTopologyRetirements = [() => (retired = true)];

        await rebuildSceneRenderables(scene);
        drainRetirements(scene);

        expect(calls).toBe(2); // raced once, then rebuilt against the settled group
        expect(scene._renderables).toHaveLength(1);
        expect(scene._renderables[0]).not.toBe(previous); // the racy build was discarded, not committed
        expect(retired).toBe(true); // fully applied, so the deferred teardown is safe to run
    });

    it("drops a group's output and keeps the teardown queued when its merged build keeps racing", async () => {
        const scene = fakeScene();
        const meshes = [{}, {}, {}, {}, {}] as never[];
        // Loses one mesh on every attempt, so no attempt ever settles.
        const builder = (async () => {
            scene.meshes.pop();
            return { renderables: [renderable(1)], rebuildSingle: () => renderable(1) };
        }) as unknown as MeshGroupBuilder;
        for (const mesh of meshes) {
            (mesh as unknown as { material: unknown }).material = { _buildGroup: builder };
        }
        scene.meshes.push(...meshes);
        scene._groups.set(builder, [...meshes] as never);
        const previous = renderable(1);
        scene._renderables.push(previous);
        (scene._groups.get(builder) as unknown as { o?: Renderable[] }).o = [previous];
        let retired = false;
        scene._pendingTopologyRetirements = [() => (retired = true)];

        await rebuildSceneRenderables(scene);
        drainRetirements(scene);

        // Drawing nothing beats drawing meshes whose buffers may be freed, and the topology change was NOT
        // applied to this group — so the deferred teardown stays queued for the next attempt.
        expect(scene._renderables).toHaveLength(0);
        expect(retired).toBe(false);
        expect(scene._pendingTopologyRetirements).toHaveLength(1);
        // A rebuild is armed so the group comes back on the next registration instead of staying blank —
        // this is the only recovery path for family-scoped callers such as setSceneImageProcessing.
        expect(scene._rebuildHook).toBeTypeOf("function");
        // The captured rebuild closure is dropped with the output: it baked the shadow topology of the build
        // being discarded, so a mesh joining this group later must not be materialised through it.
        expect((scene._groups.get(builder) as unknown as { r?: unknown }).r).toBeUndefined();
    });

    it("drops a stale rebuild closure when a group is emptied, so a later mesh is not built from it", async () => {
        const scene = fakeScene();
        const builder = fakeBuilder(1);
        const previous = renderable(1);
        const group = [] as unknown as { o?: Renderable[]; r?: unknown; length: number };
        scene._groups.set(builder, group as never);
        (group as { o?: Renderable[] }).o = [previous];
        (group as { r?: unknown }).r = () => renderable(1);
        scene._renderables.push(previous);

        await rebuildSceneRenderables(scene);

        expect(scene._renderables).toHaveLength(0);
        expect((group as { r?: unknown }).r).toBeUndefined();
        expect((group as { o?: Renderable[] }).o).toBeUndefined();
        // A rebuild stays armed: the material-swap drain skips a mesh whose group lost its rebuild closure,
        // so the next registration must rebuild the group from scratch or that mesh would never appear.
        expect(scene._rebuildHook).toBeTypeOf("function");
    });

    it("forgets the runtime build's cached closures for a dropped group", async () => {
        const scene = fakeScene();
        const builder = fakeBuilder(1);
        const dropped: unknown[] = [];
        (scene as unknown as { _runtimeBuilds: unknown })._runtimeBuilds = {
            wait: async () => undefined,
            _d: () => false,
            reset: () => undefined,
            dropBase: (b: unknown) => dropped.push(b),
        };
        const previous = renderable(1);
        const group = [] as unknown as { o?: Renderable[]; r?: unknown };
        scene._groups.set(builder, group as never);
        group.o = [previous];
        group.r = () => renderable(1);
        scene._renderables.push(previous);

        await rebuildSceneRenderables(scene);

        // Runtime closures are derived from the dropped `r` and carry the same stale shadow bindings, so
        // dispatching through them after the rebuild retires those resources would be a use-after-free.
        expect(dropped).toEqual([builder]);
    });

    it("keeps group ownership in sync when the material-swap drain rebuilds a mesh", async () => {
        const scene = fakeScene();
        const builder = fakeBuilder(1);
        const mesh = { material: { _buildGroup: builder } } as never;
        scene.meshes.push(mesh);
        const group = [mesh] as unknown as { o?: Renderable[]; r?: unknown };
        scene._groups.set(builder, group as never);

        // Initial build gives the group a merged renderable (no `mesh` back-reference) and a rebuild closure.
        await rebuildSceneRenderables(scene);
        const swapped = renderable(1);
        group.r = () => swapped;

        scene._materialSwapQueue.push(mesh);
        await processMaterialSwaps(scene);

        // The swap-built renderable must be tracked, or the next topology rebuild could not drop it (it has
        // no `mesh` to match on) and it would draw alongside its replacement.
        expect(group.o).toContain(swapped);
        await rebuildSceneRenderables(scene);
        expect(scene._renderables).not.toContain(swapped);
        expect(scene._renderables).toHaveLength(1);
    });

    it("rebuilds a mesh whose material moved to a brand-new family while a build was awaited", async () => {
        const scene = fakeScene();
        const lateBuilder = fakeBuilder(1);
        const meshA = {} as never;
        const meshB = {} as never;
        let calls = 0;
        const builder = (async () => {
            calls++;
            if (calls === 1) {
                // Material swap lands mid-build, moving meshB to a family that has no group yet.
                (meshB as unknown as { material: unknown }).material = { _buildGroup: lateBuilder };
            }
            return { renderables: [renderable(1, meshA)], rebuildSingle: () => renderable(1) };
        }) as unknown as MeshGroupBuilder;
        (meshA as unknown as { material: unknown }).material = { _buildGroup: builder };
        (meshB as unknown as { material: unknown }).material = { _buildGroup: builder };
        scene.meshes.push(meshA, meshB);
        scene._groups.set(builder, [meshA, meshB] as never);

        await rebuildSceneRenderables(scene);

        // The second pass must create the new family's group and build it, otherwise the swap drain would
        // skip the mesh (no `r` on a group that does not exist) and it would never be drawn.
        expect(lateBuilder.calls).toBe(1);
        expect(scene._groups.get(lateBuilder)).toContain(meshB);
    });
});

describe("light topology invalidation", () => {
    function sceneWithShadowLight(): { scene: SceneContext; light: never; disposed: () => number } {
        const scene = fakeScene();
        let disposed = 0;
        const sg = { _shadowType: "pcf", _light: {} as never, _shadowTaskState: { _task: { dispose: () => disposed++ } } };
        const light = { lightType: "spot", children: [], shadowGenerator: sg } as never;
        sg._light = light;
        scene.lights.push(light);
        scene.shadowGenerators.push(sg as never);
        return { scene, light, disposed: () => disposed };
    }

    it("bumps the light list version and installs the rebuild hook on removal", () => {
        const { scene, light } = sceneWithShadowLight();
        removeFromScene(scene, light);
        expect(scene.lights).toHaveLength(0);
        // Exactly one bump for one removal, not one per internal step.
        expect(scene._lightListVersion).toBe(1);
        expect(scene._rebuildHook).toBeTypeOf("function");
    });

    it("defers the shadow-generator teardown until the rebuild replaced the bind groups", async () => {
        const { scene, light, disposed } = sceneWithShadowLight();
        const builder = fakeBuilder();
        const mesh = { material: { _buildGroup: builder } } as never;
        scene.meshes.push(mesh);
        scene._groups.set(builder, [mesh]);

        removeFromScene(scene, light);
        expect(disposed()).toBe(0); // still bound by the pre-rebuild renderables

        await rebuildSceneRenderables(scene);
        expect(disposed()).toBe(0); // queued behind the frame that may still reference it
        drainRetirements(scene);
        expect(disposed()).toBe(1);

        // Idempotent: a second removal + rebuild must not dispose twice.
        removeFromScene(scene, light);
        await rebuildSceneRenderables(scene);
        drainRetirements(scene);
        expect(disposed()).toBe(1);
    });

    it("detaches a directly-removed shadow generator from its light", () => {
        const { scene, light } = sceneWithShadowLight();
        const sg = (light as unknown as { shadowGenerator: unknown }).shadowGenerator;
        removeFromScene(scene, sg as never);
        expect((light as unknown as { shadowGenerator: unknown }).shadowGenerator).toBeUndefined();
        expect(scene.shadowGenerators).toHaveLength(0);
    });

    it("runs a pending teardown on disposeScene when the app never rebuilds", () => {
        const { scene, light, disposed } = sceneWithShadowLight();
        removeFromScene(scene, light);
        disposeScene(scene);
        expect(disposed()).toBe(1);
    });
});
