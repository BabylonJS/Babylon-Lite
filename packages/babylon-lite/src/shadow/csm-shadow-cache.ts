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
import { _buildBindings, _resolvePendingMeshes, createRenderTask, removeMeshFromTask, type RenderTask } from "../frame-graph/render-task.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { createShadowCamera, updateShadowCameraBase } from "./shadow-base.js";
import { getNoColorView, shadowCasterMaterialChanged, snapshotShadowCasterMaterial } from "./pcf-shadow-task-hooks.js";
import { createCsmRefitGate, type CsmRefitGate } from "./csm-refit-gate.js";
import {
    _biasViewProjection,
    _computeCsmCascades,
    _createCascadeScratch,
    _writeCsmUbo,
    csmCameraAspect,
    csmWorldBiasClipOffset,
    type CsmConfig,
    type CsmTaskState,
} from "./csm-shadow-task-hooks.js";
import type { ShadowGenerator, ShadowTaskInternalState } from "./shadow-generator.js";

interface CsmCachedTaskState extends CsmTaskState {
    _staticTasks: RenderTask[];
    _cacheTexture: GPUTexture;
    _gate: CsmRefitGate<Mesh>;
    _onPromote: (mesh: Mesh) => void;
    _onDemote: (mesh: Mesh) => void;
    /** Tasks the last gate decision moved meshes INTO, rebuilt once after the decision. */
    _pendingTransfers: Set<RenderTask>;
    /** Scene renderable version the cached static layer was last RENDERED at. Distinct from
     *  `_renderableVersion`, which records when the caster/task membership was last reconciled. */
    _cachedContentVersion: number;
}

/** @internal Rebuild one destination task's binding lists after `transferMeshBetweenTasks` moved meshes into it. */
function rebuildTransferTarget(to: RenderTask): void {
    if (!to._recorded) {
        return;
    }
    _resolvePendingMeshes(to, to.scene as SceneContext);
    to._af = false;
    _buildBindings(to, to.engine as EngineContext, to._targetSignature);
}

/** @internal Move a resolved mesh between same-signature tasks without rebuilding its packet.
 *
 *  `pending` batches the destination rebuild: `_buildBindings` re-binds EVERY renderable of the
 *  destination task, so rebuilding inside this call makes a burst of moves O(moved × task size).
 *  The gate applies all of a quiet period's demotions inside one refit, so that burst is the normal
 *  case, not a corner. Callers that pass a set rebuild each touched task ONCE after the batch;
 *  omitting it keeps the original eager behaviour for single ad-hoc moves. */
export function transferMeshBetweenTasks(from: RenderTask, to: RenderTask, mesh: object, pendingTargets?: Set<RenderTask>): void {
    let moved = false;
    for (let i = from._pendingMeshes.length - 1; i >= 0; i--) {
        const pending = from._pendingMeshes[i]!;
        if (pending.mesh === mesh) {
            from._pendingMeshes.splice(i, 1);
            to._pendingMeshes.push(pending);
            moved = true;
        }
    }
    for (let i = from._renderables.length - 1; i >= 0; i--) {
        const renderable = from._renderables[i]!;
        if (renderable.mesh === mesh) {
            from._renderables.splice(i, 1);
            if (!to._renderables.includes(renderable)) {
                to._renderables.push(renderable);
            }
            moved = true;
        }
    }
    if (!moved) {
        return;
    }
    for (const bindings of [from._opaqueBindings, from._directBindings, from._transparentBindings]) {
        for (let i = bindings.length - 1; i >= 0; i--) {
            if (bindings[i]!.renderable.mesh === mesh) {
                bindings.splice(i, 1);
            }
        }
    }
    from._ob.length = 0;
    from._lastVersion = -1;
    if (pendingTargets) {
        pendingTargets.add(to);
        return;
    }
    rebuildTransferTarget(to);
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
                            existing._tasks[cascade]!.addMesh(mesh, { material: view });
                        }
                    }
                    snapshotShadowCasterMaterial(mesh.material, materials, gens);
                    existing._gate.markDynamic(mesh);
                }
                caps.set(mesh, maxCascade);
            }
            for (const task of existing._tasks) {
                task._lastVersion = -1;
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
                target.addMesh(mesh, { material: getNoColorView(material, materialViews) });
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
        _cameraVersion: 0,
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
        _onPromote: onPromote,
        _onDemote: onDemote,
        _pendingTransfers: pendingTransferTargets,
        _cachedContentVersion: -1,
    };
    if (replacedDefaultState) {
        state._task.record();
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
    const decision = cached._gate.update(
        light.direction.x,
        light.direction.y,
        light.direction.z,
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
    if (!decision.renderDynamic) {
        return 0;
    }
    let draws = 0;
    if (decision.refit) {
        applyCsmRefit(engine, sg, cached, cfg, camera);
        cached._lastCamVersion = camVersion;
        cached._lastCamAspect = camAspect;
        cached._cachedContentVersion = cached._scene._renderableVersion;
        for (const task of cached._staticTasks) {
            draws += task.execute?.() ?? 0;
        }
    }
    engine._currentEncoder.copyTextureToTexture(
        { texture: cached._cacheTexture },
        { texture: sg._depthTexture },
        { width: cfg._mapSize, height: cfg._mapSize, depthOrArrayLayers: cfg._numCascades }
    );
    for (const task of cached._tasks) {
        draws += task.execute?.() ?? 0;
    }
    return draws;
}

function applyCsmRefit(engine: EngineContext, sg: ShadowGenerator, state: CsmTaskState, cfg: CsmConfig, camera: NonNullable<SceneContext["camera"]>): void {
    const cascades = _computeCsmCascades(state._scene, camera, sg._light as DirectionalLight, cfg, state._casterMeshes, state._cascadeScratch);
    _writeCsmUbo(state._uboData, cascades, cfg);
    sg._version++;
    engine._device.queue.writeBuffer(sg._shadowUBO, 0, state._uboData as Float32Array<ArrayBuffer>);
    const receiverCbs = sg._onReceiverData;
    if (receiverCbs) {
        for (let i = 0; i < receiverCbs.length; i++) {
            receiverCbs[i]!(state._uboData);
        }
    }
    state._cameraVersion++;
    for (let i = 0; i < cascades._transforms.length; i++) {
        const cascadeCamera = state._cameras[i]!;
        cascadeCamera.fov = 1;
        const clipBias = cfg._worldSpaceBias === null ? cfg._bias * 0.5 : csmWorldBiasClipOffset(cfg._worldSpaceBias, cascades._near[i]!, cascades._far[i]!);
        _biasViewProjection(cascades._transforms[i]!, clipBias);
        updateShadowCameraBase(cascadeCamera, state._cameraVersion, cascades._near[i]!, cascades._far[i]!, cascades._views[i]!, cascades._transforms[i]!);
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
