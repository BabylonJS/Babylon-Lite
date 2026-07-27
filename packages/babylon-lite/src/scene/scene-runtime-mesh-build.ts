import type { Mesh } from "../mesh/mesh.js";
import type { MeshGroupBuilder, MeshGroupBuildResult, Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { RuntimeSceneBuildHooks, SceneContext } from "./scene-core.js";
import type { Material } from "../material/material.js";

const byOrder = (a: Renderable, b: Renderable): number => a.order - b.order;
type RuntimeRebuild = NonNullable<MeshGroupBuilder["_rebuildSingle"]>;
interface DetachablePacket {
    _disposed: boolean;
    _owner?: DetachablePacket[];
}
type DetachableDisposer = (() => void) & { p?: DetachablePacket };

interface RuntimeBuildState {
    disposed: boolean;
    error: Error | null;
    active: Set<Promise<void>>;
    chains: WeakMap<Mesh, Promise<void>>;
    generations: WeakMap<Mesh, number>;
    installed: WeakMap<Mesh, Set<MeshGroupBuilder>>;
    installedMeshes: Set<Mesh>;
    tail: Promise<void> | null;
}

interface PbrGeometrySceneState {
    _pbrGeomContext?: unknown;
    _pbrMeshGeomContexts?: WeakMap<Mesh, unknown>;
}

interface RuntimeRebuilder {
    bases: WeakMap<SceneContext, RuntimeRebuild>;
    dispatch: RuntimeRebuild;
    scenes: WeakMap<SceneContext, WeakMap<Mesh, RuntimeRebuild>>;
}

let _builderTails: WeakMap<MeshGroupBuilder, Promise<void>> | null = null;
let _runtimeRebuilders: WeakMap<MeshGroupBuilder, RuntimeRebuilder> | null = null;

/** @internal Start one runtime build and return a promise covering it plus every earlier build in this drain. */
export function A(scene: SceneContext, material: Material | null, mesh: Mesh, pending?: Promise<void>): Promise<void> {
    if (!material || mesh.material !== material) {
        return pending ?? Promise.resolve();
    }
    const current = B(scene, material._buildGroup, mesh);
    return pending ? Promise.all([pending, current]).then(() => undefined) : current;
}

/** @internal Materialize a drain's worth of meshes whose material group has never been built.
 *
 *  Entry point for `processMaterialSwaps`, reached through a dynamic import so the runtime-build
 *  subtree stays out of scenes that never introduce a material family at runtime.
 *
 *  Builds are chained rather than coalesced per group. For the PBR family `B` rebuilds the whole
 *  group, so N meshes joining one brand-new group produce N redundant rebuilds — but `exclusive()`
 *  serializes them and each is make-before-break, so the end state is correct, and this is a rare
 *  runtime path. Coalescing them would have to exclude meshes that arrived through the
 *  `mesh.material` setter (which only enqueues): those are not in the target group yet, and only
 *  their own `moveRuntimeMeshToGroup` call puts them there. */
export function F(scene: SceneContext, meshes: readonly Mesh[], pending?: Promise<void>): Promise<void> {
    let chain = pending;
    for (const mesh of meshes) {
        chain = A(scene, mesh.material, mesh, chain);
    }
    // Route a build failure through the scene's runtime-build error hook, which rethrows it from the
    // next `onBeforeRender` — the caller only catches module-load failures.
    return (chain ?? Promise.resolve()).catch((error: unknown) => {
        scene._runtimeBuilds?._x(error);
    });
}

/** @internal Lazily install runtime-build state and materialize one post-build mesh. */
export function B(scene: SceneContext, builder: MeshGroupBuilder, mesh: Mesh): Promise<void> {
    if (scene._z || !scene.meshes.includes(mesh)) {
        return scene._runtimeBuilds?.all().catch(() => undefined) ?? Promise.resolve();
    }
    moveRuntimeMeshToGroup(scene, builder, mesh);
    if (builder._materialFamily === "pbr" && (scene._built || scene._groups.get(builder)?.r)) {
        const hooks = scene._runtimeBuilds ?? installRuntimeBuilds(scene);
        const rebuild = import("./scene-rebuild.js")
            .then(({ rebuildScenePbrPipelines }) => (scene._z ? undefined : rebuildScenePbrPipelines(scene, true)))
            .catch((error: unknown) => {
                scene._runtimeBuilds?._x(error);
            });
        return hooks.track(rebuild);
    }
    const hooks = scene._runtimeBuilds ?? installRuntimeBuilds(scene);
    return hooks.queue(builder, mesh).catch(() => undefined);
}

/** @internal Serialize a full material-group rebuild against lazy per-mesh builds. */
export function X<T>(scene: SceneContext, builder: MeshGroupBuilder, work: () => Promise<T>): Promise<T> {
    if (scene._z) {
        return Promise.resolve(undefined as T);
    }
    return (scene._runtimeBuilds ?? installRuntimeBuilds(scene)).exclusive(builder, work);
}

function installRuntimeBuilds(scene: SceneContext): RuntimeSceneBuildHooks {
    const state: RuntimeBuildState = {
        disposed: false,
        error: null,
        active: new Set(),
        chains: new WeakMap(),
        generations: new WeakMap(),
        installed: new WeakMap(),
        installedMeshes: new Set(),
        tail: null,
    };
    const pbrState = scene as SceneContext & PbrGeometrySceneState;
    const hooks: RuntimeSceneBuildHooks = {
        queue: (builder, mesh) => {
            const generation = (state.generations.get(mesh) ?? 0) + 1;
            const material = mesh.material;
            state.generations.set(mesh, generation);
            const previous = state.chains.get(mesh);
            const waits = [state.tail, _builderTails?.get(builder)].filter((wait): wait is Promise<void> => !!wait);
            let release = (): void => undefined;
            const reservation = new Promise<void>((resolve) => {
                release = resolve;
            });
            state.tail = reservation;
            (_builderTails ??= new WeakMap()).set(builder, reservation);
            const request = (previous ? previous.catch(() => undefined) : Promise.resolve())
                .then(() => Promise.all(waits))
                .then(() => materializeRuntimeMesh(scene, state, builder, mesh, material, generation))
                .catch((error: unknown) => {
                    if (isLiveRequest(scene, state, builder, mesh, material, generation)) {
                        state.error = error instanceof Error ? error : new Error("Runtime mesh build failed", { cause: error });
                    }
                    throw error;
                })
                .finally(() => {
                    release();
                    if (state.tail === reservation) {
                        state.tail = null;
                    }
                    if (_builderTails?.get(builder) === reservation) {
                        _builderTails.delete(builder);
                    }
                });
            const tracked = request.finally(() => {
                if (state.chains.get(mesh) === tracked) {
                    state.chains.delete(mesh);
                }
            });
            state.chains.set(mesh, tracked);
            return hooks.track(tracked);
        },
        all: () => Promise.all(state.active).then(() => undefined),
        track: (promise) => {
            const tracked = promise.finally(() => state.active.delete(tracked));
            state.active.add(tracked);
            return Promise.all(state.active).then(() => undefined);
        },
        base: (builder, rebuild) => {
            const runtime = _runtimeRebuilders?.get(builder);
            if (runtime) {
                runtime.bases.set(scene, rebuild);
            }
            return runtime?.dispatch ?? rebuild;
        },
        get w() {
            return !!state.tail;
        },
        reset: (mesh) => {
            resetRuntimeRebuild(scene, state, mesh);
            pbrState._pbrMeshGeomContexts?.delete(mesh);
        },
        remove: (mesh) => {
            state.generations.set(mesh, (state.generations.get(mesh) ?? 0) + 1);
            state.chains.delete(mesh);
            clearRuntimeRebuild(scene, state, mesh);
            pbrState._pbrMeshGeomContexts?.delete(mesh);
        },
        wait: async (meshes) => {
            const pending = new Set<Promise<void>>();
            for (const mesh of meshes) {
                const task = state.chains.get(mesh);
                if (task) {
                    pending.add(task);
                }
            }
            await Promise.all(pending);
        },
        _e: (clear = true) => {
            if (state.error) {
                const error = state.error;
                if (clear) {
                    state.error = null;
                }
                throw error;
            }
        },
        _x: (error) => {
            state.error = error instanceof Error ? error : new Error("Runtime mesh build failed", { cause: error });
        },
        _d: () => state.disposed,
        exclusive: (builder, work) => {
            const waits: Promise<void>[] = [];
            if (state.tail) {
                waits.push(state.tail);
            }
            const builderTail = _builderTails?.get(builder);
            if (builderTail) {
                waits.push(builderTail);
            }
            const task = Promise.all(waits).then(work);
            const tail = task.then(
                () => undefined,
                () => undefined
            );
            state.tail = tail;
            (_builderTails ??= new WeakMap()).set(builder, tail);
            void tail.then(() => {
                if (state.tail === tail) {
                    state.tail = null;
                }
                if (_builderTails?.get(builder) === tail) {
                    _builderTails.delete(builder);
                }
            });
            return task;
        },
    };
    scene._runtimeBuilds = hooks;
    (scene._beforeRender ??= []).push(() => {
        hooks._e();
    });
    scene._disposables.push(() => {
        state.disposed = true;
        state.active.clear();
        for (const mesh of state.installedMeshes) {
            resetRuntimeRebuild(scene, state, mesh);
        }
        for (const builder of scene._groups.keys()) {
            _runtimeRebuilders?.get(builder)?.bases.delete(scene);
        }
        scene._runtimeBuilds = undefined;
        pbrState._pbrMeshGeomContexts = undefined;
    });
    return hooks;
}

function moveRuntimeMeshToGroup(scene: SceneContext, builder: MeshGroupBuilder, mesh: Mesh): void {
    for (const [groupBuilder, meshes] of scene._groups) {
        if (groupBuilder !== builder) {
            const index = meshes.indexOf(mesh);
            if (index >= 0) {
                meshes.splice(index, 1);
            }
        }
    }
    let target = scene._groups.get(builder);
    if (!target) {
        target = [];
        scene._groups.set(builder, target);
    }
    if (!target.includes(mesh)) {
        target.push(mesh);
    }
}

async function materializeRuntimeMesh(scene: SceneContext, state: RuntimeBuildState, builder: MeshGroupBuilder, mesh: Mesh, material: Material, generation: number): Promise<void> {
    if (!isLiveRequest(scene, state, builder, mesh, material, generation)) {
        return;
    }

    const previousDisposers = scene._meshDisposables.get(mesh);
    if (previousDisposers) {
        scene._meshDisposables.delete(mesh);
    }
    const previousRebuild = builder._rebuildSingle;
    const runtimeRebuilder = _runtimeRebuilders?.get(builder);
    const previousSceneBase = runtimeRebuilder?.bases.get(scene) ?? scene._groups.get(builder)?.r;
    const hadBuiltGroup = !!scene._groups.get(builder)?.r;
    const disposableStart = scene._disposables.length;
    const pbrState = scene as SceneContext & PbrGeometrySceneState;
    const previousPbrContext = pbrState._pbrGeomContext;
    let builtPbrContext: unknown;
    let result: MeshGroupBuildResult;

    try {
        result = await builder(scene, [mesh]);
        builtPbrContext = pbrState._pbrGeomContext;
    } catch (error) {
        discardMeshBuild(scene, state, mesh, previousDisposers);
        discardDisposedSceneCallbacks(scene, state);
        if (!isLiveRequest(scene, state, builder, mesh, material, generation)) {
            return;
        }
        throw error;
    } finally {
        builder._rebuildSingle = previousRebuild;
        if (builder._materialFamily === "pbr" && hadBuiltGroup) {
            pbrState._pbrGeomContext = previousPbrContext;
        }
    }

    if (!isLiveRequest(scene, state, builder, mesh, material, generation)) {
        discardMeshBuild(scene, state, mesh, previousDisposers);
        discardDisposedSceneCallbacks(scene, state);
        return;
    }

    for (let i = scene._renderables.length - 1; i >= 0; i--) {
        if (scene._renderables[i]!.mesh === mesh) {
            scene._renderables.splice(i, 1);
        }
    }
    if (previousDisposers) {
        for (const dispose of previousDisposers) {
            const packet = (dispose as DetachableDisposer).p;
            if (packet) {
                packet._disposed = true;
                const owner = packet._owner;
                if (owner) {
                    const index = owner.indexOf(packet);
                    if (index >= 0) {
                        owner.splice(index, 1);
                    }
                    packet._owner = undefined;
                }
            }
        }
        retireGpuResources(scene.surface.engine, () => {
            for (const dispose of previousDisposers) {
                dispose();
            }
        });
    }
    scene._renderables.push(...result.renderables);
    if (result.updater) {
        scene._uniformUpdaters.push(result.updater);
    }
    if (hadBuiltGroup) {
        dedupeGroupCleanup(scene, disposableStart);
    }
    if (builder._materialFamily === "pbr" && hadBuiltGroup && builtPbrContext) {
        (pbrState._pbrMeshGeomContexts ??= new WeakMap()).set(mesh, builtPbrContext);
    }
    installRuntimeRebuild(scene, state, builder, mesh, result.rebuildSingle, hadBuiltGroup ? (previousSceneBase ?? previousRebuild) : result.rebuildSingle);
    (mesh.material as { _csmGen?: number })._csmGen = ((mesh.material as { _csmGen?: number })._csmGen ?? 0) + 1;
    const group = scene._groups.get(builder);
    if (group && !hadBuiltGroup) {
        group.r = result.rebuildSingle;
    }
    scene._renderables.sort(byOrder);
    scene._renderableVersion++;
    scene._materialEpoch++;
}

function installRuntimeRebuild(
    scene: SceneContext,
    state: RuntimeBuildState,
    builder: MeshGroupBuilder,
    mesh: Mesh,
    rebuild: RuntimeRebuild,
    sceneBase: RuntimeRebuild | undefined
): void {
    let runtime = _runtimeRebuilders?.get(builder);
    if (!runtime) {
        const scenes = new WeakMap<SceneContext, WeakMap<Mesh, RuntimeRebuild>>();
        const bases = new WeakMap<SceneContext, RuntimeRebuild>();
        const dispatch: RuntimeRebuild = (targetScene, targetMesh, override) => {
            const specialized = scenes.get(targetScene)?.get(targetMesh);
            if (specialized) {
                return specialized(targetScene, targetMesh, override);
            }
            const base = bases.get(targetScene) ?? targetScene._groups.get(builder)?.r;
            if (base) {
                return base(targetScene, targetMesh, override);
            }
            throw new Error("Material group has not completed its initial build");
        };
        runtime = { bases, dispatch, scenes };
        (_runtimeRebuilders ??= new WeakMap()).set(builder, runtime);
    }

    let meshes = runtime.scenes.get(scene);
    if (!meshes) {
        meshes = new WeakMap();
        runtime.scenes.set(scene, meshes);
    }
    meshes.set(mesh, rebuild);
    if (!runtime.bases.has(scene)) {
        runtime.bases.set(scene, sceneBase ?? rebuild);
    }
    const group = scene._groups.get(builder);
    if (group) {
        group.r = runtime.dispatch;
    }
    let installed = state.installed.get(mesh);
    if (!installed) {
        installed = new Set();
        state.installed.set(mesh, installed);
    }
    installed.add(builder);
    state.installedMeshes.add(mesh);
}

function clearRuntimeRebuild(scene: SceneContext, state: RuntimeBuildState, mesh: Mesh): void {
    const builders = state.installed.get(mesh);
    if (builders) {
        for (const builder of builders) {
            _runtimeRebuilders?.get(builder)?.scenes.get(scene)?.delete(mesh);
        }
        state.installed.delete(mesh);
        state.installedMeshes.delete(mesh);
    }
}

function resetRuntimeRebuild(scene: SceneContext, state: RuntimeBuildState, mesh: Mesh): void {
    clearRuntimeRebuild(scene, state, mesh);
}

function isLiveRequest(scene: SceneContext, state: RuntimeBuildState, builder: MeshGroupBuilder, mesh: Mesh, material: Material, generation: number): boolean {
    return !state.disposed && state.generations.get(mesh) === generation && scene.meshes.includes(mesh) && mesh.material === material && material._buildGroup === builder;
}

function discardMeshBuild(scene: SceneContext, state: RuntimeBuildState, mesh: Mesh, previousDisposers: (() => void)[] | undefined): void {
    const builtDisposers = scene._meshDisposables.get(mesh);
    if (builtDisposers && builtDisposers !== previousDisposers) {
        scene._meshDisposables.delete(mesh);
        for (const dispose of builtDisposers) {
            dispose();
        }
    }
    if (previousDisposers) {
        if (scene.meshes.includes(mesh)) {
            scene._meshDisposables.set(mesh, previousDisposers);
        } else if (state.disposed) {
            for (const dispose of previousDisposers) {
                dispose();
            }
        } else {
            retireGpuResources(scene.surface.engine, () => {
                for (const dispose of previousDisposers) {
                    dispose();
                }
            });
        }
    }
}

function discardDisposedSceneCallbacks(scene: SceneContext, state: RuntimeBuildState): void {
    if (!state.disposed) {
        return;
    }
    const callbacks = scene._disposables.splice(0);
    for (const dispose of callbacks) {
        dispose();
    }
}

function dedupeGroupCleanup(scene: SceneContext, start: number): void {
    const existing = new Set(scene._disposables.slice(0, start));
    for (let i = scene._disposables.length - 1; i >= start; i--) {
        if (existing.has(scene._disposables[i]!)) {
            scene._disposables.splice(i, 1);
        }
    }
}
