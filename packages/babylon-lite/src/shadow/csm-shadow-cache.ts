/** Opt-in CSM static-shadow cache.
 *
 * Dynamically imported only when `refitAngle > 0`, keeping the default CSM runtime
 * byte-identical apart from the tiny feature gate in `csm-shadow-task-hooks.ts`.
 */

import { _cameraChangeKey, getViewProjectionMatrix, type Camera } from "../camera/camera.js";
import { invertMat4ToRefOrIdentity } from "../math/invert-mat4-to-ref-or-identity.js";
import type { DirectionalLight } from "../light/directional-light.js";
import type { EngineContext } from "../engine/engine.js";
import type { Material, MaterialView } from "../material/material.js";
import type { Mesh } from "../mesh/mesh.js";
import type { RenderTarget } from "../engine/render-target.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addMeshToTask, _buildBindings, _enableTaskMeshPopulation, _resolvePendingMeshes, createRenderTask, type RenderTask } from "../frame-graph/render-task.js";
import type { MeshRebuildResources } from "../render/renderable.js";
import type { RenderTaskBindingGeneration, RenderTaskPopulation } from "../frame-graph/render-task-base.js";
import { retireGpuResources, runGpuResourceCallbacks } from "../engine/gpu-resource-retirement.js";
import { createShadowCamera, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, snapshotShadowCasterMaterial } from "./pcf-shadow-task-hooks.js";
import { createCsmRefitGate, createCsmStaticRefitScheduler, type CsmRefitGate, type CsmStaticRefitScheduler } from "./csm-refit-gate.js";
import {
    _biasViewProjection,
    _computeCsmCascades,
    _createCascadeScratch,
    _csmSliceCornersInto,
    _dropTaskMeshes,
    _reconcileCsmCasters,
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
    /** Scene renderable version the cached static layer was last RENDERED at; -1 forces the next frame to refit
     *  (set when a reconcile dropped or requeued a caster). */
    _cachedContentVersion: number;
    /** Opt-in camera-coverage refit (`cascadeCoveragePadding`); null keeps "every camera change refits". */
    _coverage: CsmCoverageState | null;
    /** Per-cascade OWNED copies of the published light view and biased caster view-projection. A shadow camera keeps
     *  references to the arrays it is given (`updateShadowCameraBase`), and both a spread refit and a coverage refit
     *  recompute the shared cascade scratch while other cascades stay published, so they must not alias that scratch. */
    _publishedViews: Float32Array[];
    _publishedTransforms: Float32Array[];
}

/** Camera-coverage refit state. A camera POSE change no longer refits: each cascade keeps its published map until the
 *  camera's current slice leaves the area that map covers, then that cascade alone is refit and re-rendered in the
 *  same frame. Every fit is widened by `_radiusScale`, so a fresh fit leaves room for the camera to move. */
interface CsmCoverageState {
    /** 1 + padding: the bounding-sphere scale passed to `_computeCsmCascades`. */
    _radiusScale: number;
    /** Projection revision (`Camera._projRev`, a PER-CAMERA counter) the published splits were fit for; a change of it,
     *  or of the camera itself (`CsmTaskState._lastCamera`), forces a full refit. */
    _projRev: number;
    /** Camera transform version last tested, so a still camera costs no test. */
    _poseVersion: number;
    /** Camera and transform version the shared fit scratch was computed for. A spread refit publishes its later
     *  cascades from that scratch one or two frames after the fit; when the camera moved meanwhile they are refit
     *  first, so every cascade published while the camera moves is fit to the pose it is shown with. */
    _fitCamera: Camera | null;
    _fitPose: number;
    /** Camera change key the receiver callbacks were last invoked for. `onCsmReceiverUpdate` promises a callback
     *  every frame the cascades are recomputed, and without the option that is every frame the camera changes;
     *  consumers rely on that cadence (some re-upload their own camera terms from it). A camera change that refits
     *  no cascade therefore still invokes them, with the unchanged receiver data. */
    _notifiedCamVersion: number;
    _invViewProj: Float32Array;
    _corners: number[][];
    /** Reused output of `cascadesLeavingCoverage`, then the frame's merged cascade list. */
    _missed: number[];
    _merged: number[];
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
        const gate = existing._gate;
        gate.syncCasters(casterMeshes);
        const dropped = _reconcileCsmCasters(scene, sg, existing, casterMeshes);
        if (dropped) {
            for (let cascade = 0; cascade < existing._tasks.length; cascade++) {
                const staticTask = existing._staticTasks[cascade]!;
                // Held casters are dropped too: they leave the static layer as well.
                _dropTaskMeshes(staticTask, dropped);
                // The reconcile queues into the dynamic overlay. A caster the gate holds static (one re-capped or
                // requeued for a material change) goes back into the static layer, so it keeps its class. A caster
                // that left the set earlier and returns is new to the gate (`syncCasters` forgot it): dynamic.
                const task = existing._tasks[cascade]!;
                const pending = task._pendingMeshes ?? [];
                const requeued = pending.filter((request) => !gate.isDynamic(request.mesh));
                if (requeued.length) {
                    task._pendingMeshes = pending.filter((request) => gate.isDynamic(request.mesh));
                    _enableTaskMeshPopulation(staticTask);
                    staticTask._pendingMeshes!.push(...requeued);
                }
            }
            // Force a full (non-drift) refit: every static cascade re-renders without the dropped casters' old depth.
            existing._cachedContentVersion = -1;
        }
        return existing;
    }

    const materialViews = new Map<Material, MaterialView>();
    const cascadeCount = cfg._numCascades;
    const cache = sg._csmCache!;
    const gate = createCsmRefitGate<Mesh>({ refitAngle: cache._refitAngle, refitMaxIntervalMs: cache._refitMaxIntervalMs });
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
    const publishedViews: Float32Array[] = [];
    const publishedTransforms: Float32Array[] = [];
    for (let cascade = 0; cascade < cascadeCount; cascade++) {
        const camera = createShadowCamera(sg);
        publishedViews.push(new Float32Array(16));
        publishedTransforms.push(new Float32Array(16));
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
    const casterMatFeatures = new Map<Material, unknown>();
    const casterMaterials = new Map<Material, Material>();
    const casterMaxCascades = new Map<Mesh, number | undefined>();
    const casterGens = new Map<Mesh, number | undefined>();
    // A caster without a material gets no packet, and so no cap entry: it waits in `_held`, and the reconcile queues it
    // once it has one, also when it gets it before the next ensure.
    let held: Set<Mesh> | undefined;
    for (const mesh of casterMeshes) {
        if (mesh.material) {
            casterMaxCascades.set(mesh, mesh._shadowMaxCascade);
            casterGens.set(mesh, mesh._renderableGen);
            snapshotShadowCasterMaterial(mesh.material, casterMaterials, casterMatGens, casterMatFeatures);
        } else {
            (held ??= new Set()).add(mesh);
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
        _lastCamera: null,
        _lastCamAspect: -1,
        _uboData: new Float32Array(80),
        _casterMeshes: casterMeshes,
        _materialViews: materialViews,
        _casterMaterials: casterMaterials,
        _casterMatGens: casterMatGens,
        _casterMatFeatures: casterMatFeatures,
        _casterMaxCascades: casterMaxCascades,
        _casterGens: casterGens,
        _held: held,
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
        _coverage: cache._cascadeCoveragePadding ? createCoverageState(cache._cascadeCoveragePadding) : null,
        _publishedViews: publishedViews,
        _publishedTransforms: publishedTransforms,
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
    const swapped = camera !== cached._lastCamera;
    const cameraChanged = swapped || camVersion !== cached._lastCamVersion || camAspect !== cached._lastCamAspect;
    const coverage = cached._coverage;
    // With the coverage refit, only a camera swap or a projection or aspect change moves the splits and slice shapes and
    // refits every cascade; a pose change is answered per cascade by the coverage test below. Not under a floating
    // origin: the camera view-projection is then eye-relative (`getViewMatrix`), so a pure translation moves no slice
    // corner and the test could never see it; every camera change refits there, as without the option.
    const coverageRefit = !!coverage && !camera._useFloatingOrigin;
    const refitForCamera = coverageRefit ? swapped || (camera._projRev ?? 0) !== coverage._projRev || camAspect !== cached._lastCamAspect : cameraChanged;
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
        refitForCamera,
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
    // Tested against the maps published so far, before this frame publishes anything: that also covers the cascades a
    // spread refit has not reached yet, which keep showing their previous map meanwhile.
    let missed: number[] | null = null;
    if (coverageRefit && camera.worldMatrixVersion !== coverage._poseVersion) {
        coverage._poseVersion = camera.worldMatrixVersion;
        missed = cascadesLeavingCoverage(cached, camera, camAspect, coverage);
    }
    const notifyCamera = coverageRefit && camVersion !== coverage._notifiedCamVersion;
    if (coverage) {
        coverage._notifiedCamVersion = camVersion;
    }
    if (!decision.renderDynamic && !hadPending && !missed) {
        if (notifyCamera) {
            notifyReceivers(sg, cached._uboData);
        }
        return 0;
    }
    let draws = 0;
    if (decision.refit || missed) {
        // A coverage miss needs a fresh fit too. Recomputing overwrites the shared scratch, which is safe: published
        // cascades read their owned copies, and cascades still pending take the fresher fit.
        cached._pendingCascades = _computeCsmCascades(
            cached._scene,
            camera,
            sg._light as DirectionalLight,
            cfg,
            cached._casterMeshes,
            cached._cascadeScratch,
            coverage?._radiusScale ?? 1
        );
        if (coverage) {
            coverage._fitCamera = camera;
            coverage._fitPose = camera.worldMatrixVersion;
        }
    }
    if (decision.refit) {
        cached._lastCamVersion = camVersion;
        cached._lastCamAspect = camAspect;
        cached._lastCamera = camera;
        cached._cachedContentVersion = cached._scene._renderableVersion;
        scheduler.arm(cached._gate._lastRefitDriftOnly() && !scheduler.pending());
        if (coverage) {
            coverage._projRev = camera._projRev ?? 0;
        }
    }
    let cascades = scheduler.pending() ? scheduler.take() : null;
    if (missed) {
        // The missed cascades are re-rendered NOW, outside the spread budget: their published map no longer covers
        // the camera, so waiting would show its clamped edge.
        const merged = coverage!._merged;
        merged.length = 0;
        if (cascades) {
            merged.push(...cascades);
        }
        for (const cascade of missed) {
            if (!merged.includes(cascade)) {
                scheduler.claim(cascade);
                merged.push(cascade);
            }
        }
        cascades = merged;
    } else if (cascades && coverageRefit && (coverage._fitCamera !== camera || coverage._fitPose !== camera.worldMatrixVersion)) {
        // Spread cascades about to be published from a fit of an earlier pose: refit them to the pose they are shown
        // with, or they could miss the slice and, once the camera stops, never be tested again.
        cached._pendingCascades = _computeCsmCascades(
            cached._scene,
            camera,
            sg._light as DirectionalLight,
            cfg,
            cached._casterMeshes,
            cached._cascadeScratch,
            coverage._radiusScale
        );
        coverage._fitCamera = camera;
        coverage._fitPose = camera.worldMatrixVersion;
    }
    if (cascades) {
        publishCsmCascades(engine, sg, cached, cfg, cached._pendingCascades!, cascades);
        for (const cascade of cascades) {
            draws += cached._staticTasks[cascade]!.execute?.() ?? 0;
        }
        if (!scheduler.pending()) {
            cached._pendingCascades = null;
        }
    } else if (notifyCamera) {
        notifyReceivers(sg, cached._uboData);
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

function publishCsmCascades(
    engine: EngineContext,
    sg: ShadowGenerator,
    state: CsmCachedTaskState,
    cfg: CsmConfig,
    cascades: CsmCascades,
    updatedCascades: readonly number[]
): void {
    const fullUpdate = updatedCascades.length === cfg._numCascades;
    if (fullUpdate) {
        _writeCsmUbo(state._uboData, cascades, cfg);
    }
    for (const cascade of updatedCascades) {
        if (!fullUpdate) {
            state._uboData.set(cascades._transforms[cascade]!, cascade * 16);
        }
        // Publish owned copies (see `CsmCachedTaskState._publishedViews`); the receiver UBO above keeps the unbiased matrix.
        const transform = state._publishedTransforms[cascade]!;
        transform.set(cascades._transforms[cascade]!);
        const view = state._publishedViews[cascade]!;
        view.set(cascades._views[cascade]!);
        const cascadeCamera = state._cameras[cascade]!;
        cascadeCamera.fov = 1;
        const clipBias = cfg._worldSpaceBias === null ? cfg._bias * 0.5 : csmWorldBiasClipOffset(cfg._worldSpaceBias, cascades._near[cascade]!, cascades._far[cascade]!);
        _biasViewProjection(transform, clipBias);
        updateShadowCameraBase(cascadeCamera, cascadeCamera.worldMatrixVersion + 1, cascades._near[cascade]!, cascades._far[cascade]!, view, transform);
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

function notifyReceivers(sg: ShadowGenerator, data: Float32Array): void {
    const receiverCbs = sg._onReceiverData;
    if (receiverCbs) {
        for (let i = 0; i < receiverCbs.length; i++) {
            receiverCbs[i]!(data);
        }
    }
}

function createCoverageState(padding: number): CsmCoverageState {
    return {
        _radiusScale: 1 + padding,
        _projRev: -1,
        _poseVersion: -1,
        _fitCamera: null,
        _fitPose: -1,
        _notifiedCamVersion: -1,
        _invViewProj: new Float32Array(16),
        _corners: Array.from({ length: 8 }, () => [0, 0, 0]),
        _missed: [],
        _merged: [],
    };
}

/** The cascades whose PUBLISHED map no longer covers the camera's current slice, or null when every one still does.
 *
 *  A slice is covered when its eight corners (the slice is convex) lie inside the unit disc of the cascade's shadow
 *  clip space, read from the receiver UBO, and inside its light-depth range [0, 2R], read from the published light
 *  view. That is the coverage a fresh unpadded stabilized fit guarantees: its corners lie in the bounding sphere of
 *  radius R, so within the disc and that depth range. The depth range is taken before the caster-bound tightening,
 *  which only trims depth that holds no caster. The splits are the published ones: a projection change refits first. */
function cascadesLeavingCoverage(state: CsmCachedTaskState, camera: Camera, aspect: number, coverage: CsmCoverageState): number[] | null {
    const out = coverage._missed;
    out.length = 0;
    const ubo = state._uboData;
    const near = camera.nearPlane;
    const range = camera.farPlane - near;
    const invViewProj = coverage._invViewProj;
    invertMat4ToRefOrIdentity(getViewProjectionMatrix(camera, aspect) as never, invViewProj as never);
    const corners = coverage._corners;
    let prevSplit = 0;
    for (let cascade = 0; cascade < state._cameras.length; cascade++) {
        // The UBO stores the split as a camera view-space distance; the fit slices by fraction of the depth range.
        const split = (ubo[64 + cascade]! - near) / range;
        _csmSliceCornersInto(corners, invViewProj, prevSplit, split);
        prevSplit = split;
        const t = cascade * 16;
        const view = state._publishedViews[cascade]!;
        // A stabilized fit's ortho X row is the light right axis scaled by 1/R, so its length gives R back.
        const depth = 2 / Math.hypot(ubo[t]!, ubo[t + 4]!, ubo[t + 8]!);
        for (const corner of corners) {
            const px = corner[0]!;
            const py = corner[1]!;
            const pz = corner[2]!;
            const x = ubo[t]! * px + ubo[t + 4]! * py + ubo[t + 8]! * pz + ubo[t + 12]!;
            const y = ubo[t + 1]! * px + ubo[t + 5]! * py + ubo[t + 9]! * pz + ubo[t + 13]!;
            const z = view[2]! * px + view[6]! * py + view[10]! * pz + view[14]!;
            if (x * x + y * y > 1 || z < 0 || z > depth) {
                out.push(cascade);
                break;
            }
        }
    }
    return out.length ? out : null;
}

function createLayerTarget(texture: GPUTexture, cascade: number, mapSize: number): RenderTarget {
    return {
        _descriptor: {
            size: { width: mapSize, height: mapSize },
            dFormat: "depth32float",
            depthClearValue: 1,
            depthCompare: "less-equal",
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
