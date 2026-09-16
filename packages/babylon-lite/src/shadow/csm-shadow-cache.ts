/** Opt-in CSM static-shadow cache.
 *
 * Dynamically imported only when `refitAngle > 0`, keeping the default CSM runtime
 * byte-identical apart from the tiny feature gate in `csm-shadow-task-hooks.ts`.
 */

import { _cameraChangeKey } from "../camera/camera.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import {
    addMeshToTask,
    _buildBindings,
    _enableTaskMeshPopulation,
    _resolvePendingMeshes,
    createRenderTask,
    removeMeshFromTask,
    type RenderTask,
} from "../frame-graph/render-task.js";
import type { MeshRebuildResources } from "../render/renderable.js";
import type { RenderTaskBindingGeneration, RenderTaskPopulation } from "../frame-graph/render-task-base.js";
import { retireGpuResources, runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import { createShadowCamera, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, shadowCasterMaterialChanged, snapshotShadowCasterMaterial } from "./pcf-shadow-task-hooks.js";
import { createCsmRefitGate, createCsmStaticRefitScheduler, type CsmRefitGate, type CsmStaticRefitScheduler } from "./csm-refit-gate.js";
import {
    _biasViewProjection,
    _computeCsmCascades,
    _createCascadeScratch,
    _writeCsmUbo,
    csmCameraAspect,
    csmWorldBiasClipOffset,
    type CsmCascades,
    type CsmConfig,
    type CsmTaskState,
} from "./csm-shadow-task-hooks.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

interface CsmCachedTaskState extends CsmTaskState {
    _staticTasks: RenderTask[];
    _cacheTexture: GPUTexture;
    _gate: CsmRefitGate<Mesh>;
    /** Spreads a drift-only refit's static re-render over frames (`staticCascadesPerFrame`). */
    _staticScheduler: CsmStaticRefitScheduler;
    /** Pending cascade generation. Each layer is published only when its matching depth is rendered. */
    _pendingCascades: CsmCascades | null;
    _onPromote: (mesh: Mesh) => void;
    _onDemote: (mesh: Mesh) => void;
    /** Tasks the last gate decision moved meshes INTO, rebuilt once after the decision. */
    _pendingTransfers: Set<RenderTask>;
    /** Scene renderable version the cached static layer was last RENDERED at. Distinct from
     *  `_renderableVersion`, which records when the caster/task membership was last reconciled. */
    _cachedContentVersion: number;
}

interface MeshTransfer {
    from: RenderTask;
    mesh: object;
}

let pendingTransfers: WeakMap<RenderTask, MeshTransfer[]> | null = null;

/** @internal Commit a destination's queued transfers and bindings together. */
export function rebuildTransferTarget(to: RenderTask): void {
    const transfers = pendingTransfers?.get(to);
    if (!transfers?.length) {
        return;
    }
    applyTransfers(to, transfers);
    pendingTransfers!.delete(to);
}

/** @internal Move a resolved mesh between same-signature tasks without rebuilding its packet.
 *
 *  `pending` batches the destination rebuild: `_buildBindings` re-binds EVERY renderable of the
 *  destination task, so rebuilding inside this call makes a burst of moves O(moved × task size).
 *  The gate applies all of a quiet period's demotions inside one refit, so that burst is the normal
 *  case, not a corner. Callers that pass a set rebuild each touched task ONCE after the batch;
 *  omitting it keeps the original eager behaviour for single ad-hoc moves. */
export function transferMeshBetweenTasks(from: RenderTask, to: RenderTask, mesh: object, pendingTargets?: Set<RenderTask>): void {
    if (from === to || (!from._pendingMeshes?.some((entry) => entry.mesh === mesh) && !from._renderables.some((renderable) => renderable.mesh === mesh))) {
        return;
    }
    if (from.scene !== to.scene || from.engine !== to.engine || from._disposed || to._disposed) {
        throw new Error("Render-task transfers require live tasks in the same scene.");
    }
    _enableTaskMeshPopulation(to);
    if (pendingTargets) {
        pendingTransfers ??= new WeakMap();
        let transfers = pendingTransfers.get(to);
        if (!transfers) {
            pendingTransfers.set(to, (transfers = []));
        }
        transfers.push({ from, mesh });
        pendingTargets.add(to);
        return;
    }
    applyTransfers(to, [{ from, mesh }]);
}

function applyTransfers(to: RenderTask, transfers: readonly MeshTransfer[]): void {
    const tasks = [...new Set(transfers.map((transfer) => transfer.from)), to];
    transactRenderTasks(
        tasks,
        (candidates) => {
            const destination = candidates[candidates.length - 1]!;
            for (const { from, mesh } of transfers) {
                const source = candidates[tasks.indexOf(from)]!;
                destination.population._pendingMeshes.push(...source.population._pendingMeshes.filter((entry) => entry.mesh === mesh));
                source.population._pendingMeshes = source.population._pendingMeshes.filter((entry) => entry.mesh !== mesh);
                for (const renderable of source.population._renderables) {
                    if (renderable.mesh === mesh && !destination.population._renderables.includes(renderable)) {
                        destination.population._renderables.push(renderable);
                    }
                }
                source.population._renderables = source.population._renderables.filter((renderable) => renderable.mesh !== mesh);
                source.generation._renderables = source.population._renderables;
                source.generation._opaqueBindings = source.generation._opaqueBindings.filter((binding) => binding.renderable.mesh !== mesh);
                source.generation._directBindings = source.generation._directBindings.filter((binding) => binding.renderable.mesh !== mesh);
                source.generation._transparentBindings = source.generation._transparentBindings.filter((binding) => binding.renderable.mesh !== mesh);
                source.generation._batchState = source.generation._batchState?._select([
                    source.generation._opaqueBindings,
                    source.generation._directBindings,
                    source.generation._transparentBindings,
                ]);
                source.generation._ob = [];
                source.generation._lastVersion = -1;
            }
        },
        to._sceneBG ? [to] : []
    );
}

interface TaskTransferCandidate {
    task: RenderTask;
    previousBatchState?: RenderTaskBindingGeneration["_batchState"];
    population: RenderTaskPopulation;
    generation: RenderTaskBindingGeneration;
    created: MeshRebuildResources[];
}

function transactRenderTasks(tasks: readonly RenderTask[], prepare: (tasks: TaskTransferCandidate[]) => void, rebind: readonly RenderTask[]): void {
    const transactions: TaskTransferCandidate[] = tasks.map((task) => {
        const population: RenderTaskPopulation = {
            scene: task.scene,
            _renderables: task._renderables.slice(),
            _pendingMeshes: task._pendingMeshes!.slice(),
        };
        return {
            task,
            previousBatchState: task._batchState,
            population,
            generation: {
                _renderables: population._renderables,
                _opaqueBindings: task._opaqueBindings,
                _directBindings: task._directBindings,
                _transparentBindings: task._transparentBindings,
                _ob: [],
                _lastVersion: task._lastVersion,
                _lastVis: task._lastVis,
                _batchState: task._batchState,
            },
            created: [],
        };
    });
    try {
        prepare(transactions);
        const retained = transactions.map((transaction) => transaction.previousBatchState);
        for (const transaction of transactions) {
            if (rebind.includes(transaction.task)) {
                _resolvePendingMeshes(transaction.population, transaction.created);
                transaction.generation = _buildBindings(transaction.task, transaction.population._renderables, false, false, retained);
            }
        }
    } catch (error) {
        const retained = transactions.map((transaction) => transaction.previousBatchState);
        for (const transaction of transactions) {
            for (const resources of transaction.created) {
                runGpuResourceCallbacks(resources._lifetimeDisposers);
            }
            transaction.generation._batchState?._release(undefined, retained);
        }
        throw error;
    }
    for (const transaction of transactions) {
        transaction.task._pendingMeshes = transaction.population._pendingMeshes;
        Object.assign(transaction.task, transaction.generation);
    }
    const retained = transactions.map((transaction) => transaction.generation._batchState);
    for (const transaction of transactions) {
        transaction.previousBatchState?._release(transaction.task.engine, retained);
    }
}

/** Build or update the opt-in static-cache CSM task state. */
export function ensureCsmShadowCacheState(
    engine: EngineContext,
    scene: SceneContext,
    sg: ShadowGenerator,
    cfg: CsmConfig,
    casterMeshes: readonly Mesh[],
    existingState: ShadowTaskInternalState | null
): CsmTaskState {
    let existing = existingState as CsmCachedTaskState | null;
    let replacedDefaultState = false;
    if (existing && !existing._gate) {
        retireGpuResources(engine, existing._task.dispose);
        existing = null;
        replacedDefaultState = true;
    }
    if (existing) {
        let casterMatChanged = false;
        for (const mesh of casterMeshes) {
            const material = mesh.material;
            if (material && shadowCasterMaterialChanged(material, existing._casterMaterials, existing._casterMatGens)) {
                casterMatChanged = true;
                break;
            }
        }
        if (!casterMatChanged && existing._casterMeshes === casterMeshes && existing._renderableVersion === scene._renderableVersion) {
            return existing;
        }
        if (!casterMatChanged && existing._casterMeshes === casterMeshes && existing._materialEpoch === scene._materialEpoch) {
            existing._renderableVersion = scene._renderableVersion;
            return existing;
        }
        if (!casterMatChanged) {
            const nextSet = new Set(casterMeshes);
            const views = existing._materialViews;
            const materials = existing._casterMaterials;
            const gens = existing._casterMatGens;
            const caps = existing._casterMaxCascades;
            existing._gate.syncCasters(casterMeshes);
            for (const mesh of existing._casterMeshes) {
                if (!nextSet.has(mesh) || mesh._shadowMaxCascade !== caps.get(mesh)) {
                    caps.delete(mesh);
                    for (const task of existing._tasks) {
                        removeMeshFromTask(task, mesh);
                    }
                    for (const task of existing._staticTasks) {
                        removeMeshFromTask(task, mesh);
                    }
                }
            }
            for (const mesh of casterMeshes) {
                const maxCascade = mesh._shadowMaxCascade;
                if (!caps.has(mesh) && mesh.material) {
                    const view = getNoColorView(mesh.material, views);
                    for (let cascade = 0; cascade < existing._tasks.length; cascade++) {
                        if (cascade <= (maxCascade ?? cascade)) {
                            addMeshToTask(existing._tasks[cascade]!, mesh, { material: view });
                        }
                    }
                    snapshotShadowCasterMaterial(mesh.material, materials, gens);
                    existing._gate.markDynamic(mesh);
                }
                caps.set(mesh, maxCascade);
            }
            for (const task of existing._tasks) {
                task._lastVersion = -1;
                task._ob.length = 0;
            }
            existing._casterMeshes = casterMeshes;
            existing._renderableVersion = scene._renderableVersion;
            return existing;
        }
        retireGpuResources(engine, existing._task.dispose);
    }

    const materialViews = new Map<Material, MaterialView>();
    const cascadeCount = cfg._numCascades;
    const cache = sg._csmCache!;
    const gate = existing?._gate ?? createCsmRefitGate<Mesh>({ refitAngle: cache._refitAngle, refitMaxIntervalMs: cache._refitMaxIntervalMs });
    gate.syncCasters(casterMeshes);
    const cacheTexture = engine._device.createTexture({
        label: "csm-static-cache",
        size: { width: cfg._mapSize, height: cfg._mapSize, depthOrArrayLayers: cascadeCount },
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const tasks: RenderTask[] = [];
    const staticTasks: RenderTask[] = [];
    const cameras = [];
    for (let cascade = 0; cascade < cascadeCount; cascade++) {
        const camera = createShadowCamera(sg);
        const staticTask = createRenderTask(
            {
                name: `csm${cascade}-static`,
                rt: createLayerTarget(cacheTexture, cascade, cfg._mapSize),
                clr: true,
                cam: camera,
                autoMirror: false,
                _skipClusteredLights: true,
            },
            engine,
            scene
        );
        const dynamicTask = createRenderTask(
            {
                name: `csm${cascade}`,
                rt: createLayerTarget(sg._depthTexture, cascade, cfg._mapSize),
                clr: false,
                depthClear: false,
                cam: camera,
                autoMirror: false,
                _skipClusteredLights: true,
            },
            engine,
            scene
        );
        for (const mesh of casterMeshes) {
            const material = mesh.material;
            if (material && cascade <= (mesh._shadowMaxCascade ?? cascade)) {
                const target = gate.isDynamic(mesh) ? dynamicTask : staticTask;
                addMeshToTask(target, mesh, { material: getNoColorView(material, materialViews) });
            }
        }
        staticTasks.push(staticTask);
        tasks.push(dynamicTask);
        cameras.push(camera);
    }

    // Destination tasks touched by the promote/demote callbacks of ONE gate decision. The gate calls
    // back while it walks the casters, so the rebuild of each destination is deferred to a single pass
    // after the walk (see `transferMeshBetweenTasks`).
    const pendingTransferTargets = new Set<RenderTask>();
    const onPromote = (mesh: Mesh): void => {
        for (let cascade = 0; cascade < tasks.length; cascade++) {
            transferMeshBetweenTasks(staticTasks[cascade]!, tasks[cascade]!, mesh, pendingTransferTargets);
        }
    };
    const onDemote = (mesh: Mesh): void => {
        for (let cascade = 0; cascade < tasks.length; cascade++) {
            transferMeshBetweenTasks(tasks[cascade]!, staticTasks[cascade]!, mesh, pendingTransferTargets);
        }
    };
    const compositeTask = {
        record(): void {
            for (const task of staticTasks) {
                task.record();
            }
            for (const task of tasks) {
                task.record();
            }
        },
        execute(): number {
            let draws = 0;
            for (const task of tasks) {
                draws += task.execute?.() ?? 0;
            }
            return draws;
        },
        dispose(): void {
            for (const task of staticTasks) {
                task.dispose();
            }
            for (const task of tasks) {
                task.dispose();
            }
            cacheTexture.destroy();
        },
    };
    const casterMatGens = new Map<Material, number | undefined>();
    const casterMaterials = new Map<Material, Material>();
    const casterMaxCascades = new Map<Mesh, number | undefined>();
    for (const mesh of casterMeshes) {
        casterMaxCascades.set(mesh, mesh._shadowMaxCascade);
        if (mesh.material) {
            snapshotShadowCasterMaterial(mesh.material, casterMaterials, casterMatGens);
        }
    }
    const state: CsmCachedTaskState = {
        _task: compositeTask,
        _tasks: tasks,
        _cameras: cameras,
        _scene: scene,
        _lastCasterVersion: -1,
        _lastLightVersion: -1,
        _lastCamVersion: -1,
        _lastCamAspect: -1,
        _uboData: new Float32Array(80),
        _casterMeshes: casterMeshes,
        _renderableVersion: scene._renderableVersion,
        _materialEpoch: scene._materialEpoch,
        _materialViews: materialViews,
        _casterMaterials: casterMaterials,
        _casterMatGens: casterMatGens,
        _casterMaxCascades: casterMaxCascades,
        _cascadeScratch: _createCascadeScratch(cascadeCount),
        _staticTasks: staticTasks,
        _cacheTexture: cacheTexture,
        _gate: gate,
        _staticScheduler: createCsmStaticRefitScheduler(cascadeCount, cache._staticCascadesPerFrame ?? 0),
        _pendingCascades: null,
        _onPromote: onPromote,
        _onDemote: onDemote,
        _pendingTransfers: pendingTransferTargets,
        _cachedContentVersion: -1,
    };
    if (replacedDefaultState) {
        const version = scene._renderableVersion;
        state._task.record();
        state._recordedVersion = version;
    }
    return state;
}

/** Render one static-cache CSM frame. */
export function renderCsmShadowMapCached(engine: EngineContext, sg: ShadowGenerator, state: CsmTaskState, cfg: CsmConfig): number {
    const cached = state as CsmCachedTaskState;
    const camera = cached._scene.camera;
    if (!camera) {
        return 0;
    }
    const camVersion = _cameraChangeKey(camera);
    const camAspect = csmCameraAspect(cached._scene, camera);
    const cameraChanged = camVersion !== cached._lastCamVersion || camAspect !== cached._lastCamAspect;
    const light = sg._light as DirectionalLight;
    // A caster's DEPTH can change without its transform changing: a procedural mesh re-uploads its
    // geometry, a mesh set is re-registered, buffers are reallocated. `_renderableVersion` is the
    // engine's own "every cached draw recording is now invalid" signal, and the static layer IS a
    // cached draw recording — the one that lives in a texture instead of a render bundle. So a bump
    // must re-render it, exactly like a sun-angle change. Without this the layer keeps drawing the
    // previous geometry until some unrelated refit (a camera move) happens to redraw it.
    const contentChanged = cached._scene._renderableVersion !== cached._cachedContentVersion;
    cached._gate.syncCasters(cached._casterMeshes);
    const lightWorld = light.worldMatrix;
    const direction = light.direction;
    const decision = cached._gate.update(
        lightWorld[0]! * direction.x + lightWorld[4]! * direction.y + lightWorld[8]! * direction.z,
        lightWorld[1]! * direction.x + lightWorld[5]! * direction.y + lightWorld[9]! * direction.z,
        lightWorld[2]! * direction.x + lightWorld[6]! * direction.y + lightWorld[10]! * direction.z,
        typeof performance !== "undefined" ? performance.now() : Date.now(),
        cameraChanged,
        cfg._forceRefreshEveryFrame || contentChanged,
        cached._onPromote,
        cached._onDemote
    );
    // One rebuild per task the decision touched, not one per moved caster.
    if (cached._pendingTransfers.size) {
        for (const task of cached._pendingTransfers) {
            rebuildTransferTarget(task);
        }
        cached._pendingTransfers.clear();
    }
    const scheduler = cached._staticScheduler;
    const hadPending = scheduler.pending();
    if (!decision.renderDynamic && !hadPending) {
        return 0;
    }
    let draws = 0;
    if (decision.refit) {
        cached._pendingCascades = _computeCsmCascades(cached._scene, camera, sg._light as DirectionalLight, cfg, cached._casterMeshes, cached._cascadeScratch);
        cached._lastCamVersion = camVersion;
        cached._lastCamAspect = camAspect;
        cached._cachedContentVersion = cached._scene._renderableVersion;
        scheduler.arm(cached._gate._lastRefitDriftOnly() && !scheduler.pending());
    }
    const cascades = scheduler.pending() ? scheduler.take() : null;
    if (cascades) {
        publishCsmCascades(engine, sg, cached, cfg, cached._pendingCascades!, cascades);
        for (const cascade of cascades) {
            draws += cached._staticTasks[cascade]!.execute?.() ?? 0;
        }
        if (!scheduler.pending()) {
            cached._pendingCascades = null;
        }
    }
    // A dynamic-caster change requires clearing and redrawing every live layer. Otherwise a spread
    // frame touches only the cascades whose static depth and receiver transform were just advanced.
    if (cached._gate._lastDynamicChanged() || cascades?.length === cfg._numCascades) {
        engine._currentEncoder.copyTextureToTexture(
            { texture: cached._cacheTexture },
            { texture: sg._depthTexture },
            { width: cfg._mapSize, height: cfg._mapSize, depthOrArrayLayers: cfg._numCascades }
        );
        for (const task of cached._tasks) {
            if (task._renderables.length || task._pendingMeshes?.length) {
                draws += task.execute?.() ?? 0;
            }
        }
    } else if (cascades) {
        for (const cascade of cascades) {
            engine._currentEncoder.copyTextureToTexture(
                { texture: cached._cacheTexture, origin: { x: 0, y: 0, z: cascade } },
                { texture: sg._depthTexture, origin: { x: 0, y: 0, z: cascade } },
                { width: cfg._mapSize, height: cfg._mapSize, depthOrArrayLayers: 1 }
            );
            const task = cached._tasks[cascade]!;
            if (task._renderables.length || task._pendingMeshes?.length) {
                draws += task.execute?.() ?? 0;
            }
        }
    }
    return draws;
}

function publishCsmCascades(engine: EngineContext, sg: ShadowGenerator, state: CsmTaskState, cfg: CsmConfig, cascades: CsmCascades, updatedCascades: readonly number[]): void {
    const fullUpdate = updatedCascades.length === cfg._numCascades;
    if (fullUpdate) {
        _writeCsmUbo(state._uboData, cascades, cfg);
    }
    for (const cascade of updatedCascades) {
        const transform = cascades._transforms[cascade]!;
        if (!fullUpdate) {
            state._uboData.set(transform, cascade * 16);
        }
        const cascadeCamera = state._cameras[cascade]!;
        cascadeCamera.fov = 1;
        const clipBias = cfg._worldSpaceBias === null ? cfg._bias * 0.5 : csmWorldBiasClipOffset(cfg._worldSpaceBias, cascades._near[cascade]!, cascades._far[cascade]!);
        _biasViewProjection(transform, clipBias);
        updateShadowCameraBase(cascadeCamera, cascadeCamera.worldMatrixVersion + 1, cascades._near[cascade]!, cascades._far[cascade]!, cascades._views[cascade]!, transform);
    }
    sg._version++;
    engine._device.queue.writeBuffer(sg._shadowUBO, 0, state._uboData as Float32Array<ArrayBuffer>);
    const receiverCbs = sg._onReceiverData;
    if (receiverCbs) {
        for (let i = 0; i < receiverCbs.length; i++) {
            receiverCbs[i]!(state._uboData);
        }
    }
}

function createLayerTarget(texture: GPUTexture, cascade: number, mapSize: number): RenderTarget {
    return {
        _descriptor: {
            size: { width: mapSize, height: mapSize },
            dFormat: "depth32float",
            _depthClearValue: 1,
            _depthCompare: "less-equal",
            samples: 1,
        },
        _colorTexture: null,
        _colorView: null,
        _depthTexture: texture,
        _depthView: texture.createView({ dimension: "2d", baseArrayLayer: cascade, arrayLayerCount: 1 }),
        _width: mapSize,
        _height: mapSize,
        _eager: true,
        _ownsDepthTexture: false,
    };
}
