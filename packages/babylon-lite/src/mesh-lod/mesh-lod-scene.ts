/** MeshLoD scene integration — the scene-owned registry, batching, and per-frame
 *  CPU selection.
 *
 *  Assets and instances never reference a scene (one-way ownership, GUIDANCE 4b):
 *  the scene alone owns a `MeshLoDSceneRegistry` that groups instances into batches
 *  by exact asset + exact material identity. Registration installs one deferred
 *  scene builder (via `addDeferredSceneRenderables`) that the PBR MeshLoD material
 *  module fills with a material-owned renderable — this module never touches
 *  WGSL, pipelines, or bind groups. Add/remove are idempotent and take effect
 *  before the next selection. */

import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import type { EngineContext } from "../engine/engine.js";
import type { Renderable, DrawUpdateContext } from "../render/renderable.js";
import type { Camera } from "../camera/camera.js";
import { getCameraPosition, getEffectiveAspectRatio, getProjectionMatrix } from "../camera/camera.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Material } from "../material/material.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { validateMeshLoDMaterial } from "../material/pbr/pbr-mesh-lod-material.js";
import type { MeshLoDAsset, MeshLoDInstance } from "./mesh-lod.js";
import type { MeshLoDAssetRuntime, MeshLoDStreamSelectionStats } from "./mesh-lod-runtime.js";
import type * as PbrMeshLoDModule from "../material/pbr/pbr-mesh-lod-renderable.js";
import { holdMeshLoDPages, queueMeshLoDFrame, _recoverMeshLoDAsset } from "./mesh-lod-runtime.js";
import type { MeshLoDPageDemand } from "./mesh-lod-scheduler.js";
import { createMeshLoDError, isMeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDCamera, MeshLoDSelectionResult } from "./mesh-lod-selection-cpu.js";
import { selectMeshLoDCpu } from "./mesh-lod-selection-cpu.js";
import { addMeshLoDPageBenefit } from "./mesh-lod-selection-math.js";

/** One scene-owned draw batch: all instances that share an exact asset and exact
 *  material object. Selection and expansion run per batch; the PBR module attaches
 *  a single indirect-draw `Renderable` (Task 4.4). */
export interface MeshLoDSceneBatch {
    readonly asset: MeshLoDAsset;
    readonly material: PbrMaterialProps;
    readonly instances: MeshLoDInstance[];
    /** Material-owned indirect renderable, attached by the PBR module at build time. */
    renderable?: Renderable;
    /** @internal Feature-owned per-batch GPU/CPU state, owned by the PBR module. */
    _packet?: unknown;
}

/** Scene-owned MeshLoD registry. Stored only on `SceneContext._meshLoDRegistry`;
 *  neither assets nor instances hold a back-reference to it. */
export interface MeshLoDSceneRegistry {
    /** Batches grouped by asset then by exact material object identity. */
    readonly byAsset: Map<MeshLoDAsset, Map<PbrMaterialProps, MeshLoDSceneBatch>>;
    /** Flat batch list in insertion order for deterministic iteration. */
    readonly batches: MeshLoDSceneBatch[];
    /** True once the single deferred builder has been registered on the scene. */
    builderRegistered: boolean;
    /** Serializes material packet replacement without blocking unrelated scenes. */
    materialRebuild?: Promise<void>;
}

function getOrCreateRegistry(scene: SceneContext): MeshLoDSceneRegistry {
    let registry = scene._meshLoDRegistry;
    if (!registry) {
        registry = { byAsset: new Map(), batches: [], builderRegistered: false };
        scene._meshLoDRegistry = registry;
        const owned = registry;
        scene._materialRebuild = (matches) => {
            const build = (): Promise<void> => rebuildMeshLoDMaterials(scene, matches);
            const pending = owned.materialRebuild ? owned.materialRebuild.then(build, build) : build();
            owned.materialRebuild = pending;
            const clear = (): void => {
                if (owned.materialRebuild === pending) {
                    owned.materialRebuild = undefined;
                }
            };
            void pending.then(clear, clear);
            return pending;
        };
    }
    return registry;
}

function getOrCreateBatch(registry: MeshLoDSceneRegistry, asset: MeshLoDAsset, material: PbrMaterialProps): MeshLoDSceneBatch {
    let byMaterial = registry.byAsset.get(asset);
    if (!byMaterial) {
        byMaterial = new Map();
        registry.byAsset.set(asset, byMaterial);
    }
    let batch = byMaterial.get(material);
    if (!batch) {
        batch = { asset, material, instances: [] };
        byMaterial.set(material, batch);
        registry.batches.push(batch);
    }
    return batch;
}

/** @internal Cached PBR MeshLoD material module — dynamically imported on the first
 *  scene build so this scene module never statically references the PBR MeshLoD
 *  chunk (and non-MeshLoD scenes fetch none of it). Nullable lazy cache only. */
let _pbrMeshLoDModule: typeof PbrMeshLoDModule | null = null;

async function getPbrMeshLoDModule(): Promise<typeof PbrMeshLoDModule> {
    if (!_pbrMeshLoDModule) {
        _pbrMeshLoDModule = await import("../material/pbr/pbr-mesh-lod-renderable.js");
    }
    return _pbrMeshLoDModule;
}

/** Build each material-owned indirect renderable and attach a device-recovery thunk. */
async function buildMeshLoDBatchRenderables(engine: EngineContext, scene: SceneContext, batches = scene._meshLoDRegistry?.batches ?? []): Promise<Renderable[]> {
    const renderables: Renderable[] = [];
    const pbr = await getPbrMeshLoDModule();
    if (scene._z) {
        throw createMeshLoDError("MLOD_DISPOSED", "scene was disposed during the MeshLoD build");
    }
    validateMeshLoDEngine(engine);
    for (const batch of batches) {
        if (batch.instances.length && batch.asset.state !== "failed" && !batch.asset._runtime.disposed) {
            validateMeshLoDMaterial(batch.material);
        }
    }
    const staged: Array<{ batch: MeshLoDSceneBatch; candidate: MeshLoDSceneBatch }> = [];
    try {
        for (const batch of batches) {
            if (batch.asset.state === "failed" || batch.asset._runtime.disposed) {
                continue;
            }
            const rebuild = async (): Promise<Renderable | null> => {
                const previous = batch._packet as { dispose?: () => void } | undefined;
                batch._packet = undefined;
                batch.renderable = undefined;
                try {
                    recoverMeshLoDAssets(engine, scene);
                    const next = await pbr.buildMeshLoDBatchRenderable(engine, scene, batch);
                    batch.renderable = next ?? undefined;
                    if (next) {
                        next._rebuild = rebuild;
                    }
                    return next;
                } finally {
                    previous?.dispose?.();
                }
            };
            const candidate: MeshLoDSceneBatch = { ...batch, _packet: undefined, renderable: undefined };
            staged.push({ batch, candidate });
            const renderable = await pbr.buildMeshLoDBatchRenderable(engine, scene, candidate);
            if (renderable) {
                renderable._rebuild = rebuild;
                candidate.renderable = renderable;
                renderables.push(renderable);
            }
        }
        if (scene._z) {
            throw createMeshLoDError("MLOD_DISPOSED", "scene was disposed during the MeshLoD build");
        }
    } catch (error) {
        for (const { candidate } of staged) {
            (candidate as { _packet?: { dispose?: () => void } })._packet?.dispose?.();
        }
        throw error;
    }
    for (const { batch, candidate } of staged) {
        batch._packet = candidate._packet;
        batch.renderable = candidate.renderable;
    }
    return renderables;
}

async function rebuildMeshLoDMaterials(scene: SceneContext, matches: (material: Material) => boolean): Promise<void> {
    if (!scene._built || scene._z) {
        return;
    }
    const batches = scene._meshLoDRegistry!.batches.filter((batch) => batch.renderable && !batch.asset._runtime.disposed && matches(batch.material));
    if (!batches.length) {
        return;
    }
    const previous = batches.map((batch) => ({ renderable: batch.renderable!, packet: batch._packet as { dispose?: () => void } | undefined }));
    const engine = scene.surface.engine;
    await buildMeshLoDBatchRenderables(engine, scene, batches);
    for (let i = 0; i < batches.length; i++) {
        const old = previous[i]!;
        const renderable = batches[i]!.renderable;
        const index = scene._renderables.indexOf(old.renderable);
        if (index >= 0) {
            scene._renderables.splice(index, 1, ...(renderable ? [renderable] : []));
        }
        retireGpuResources(engine, () => old.packet?.dispose?.());
    }
    scene._renderableVersion++;
    scene._materialEpoch++;
}

/** Dispose every batch's material-owned GPU packet (scene teardown). Idempotent. */
function disposeMeshLoDBatchPackets(scene: SceneContext): void {
    scene._materialRebuild = undefined;
    const registry = scene._meshLoDRegistry;
    if (!registry) {
        return;
    }
    for (const batch of registry.batches) {
        (batch as { _packet?: { dispose?: () => void } })._packet?.dispose?.();
        batch._packet = undefined;
        batch.renderable = undefined;
    }
}

/** Recover assets on a replacement device once, failing the recovery if coarse data is lost. */
function recoverMeshLoDAssets(engine: EngineContext, scene: SceneContext): void {
    const registry = scene._meshLoDRegistry;
    if (!registry) {
        return;
    }
    for (const asset of registry.byAsset.keys()) {
        if (asset._runtime.disposed || asset._runtime.gpuDevice === engine._device) {
            continue;
        }
        asset.state = "recovering";
        try {
            _recoverMeshLoDAsset(engine, asset._runtime);
            asset.state = "ready";
        } catch (error) {
            asset.state = "failed";
            asset.error = isMeshLoDError(error)
                ? error
                : createMeshLoDError("MLOD_DEVICE_RECOVERY", "failed to rebuild MeshLoD coarse residency", {
                      cause: error,
                      actual: error instanceof Error ? error.message : String(error),
                  });
            throw asset.error;
        }
    }
}

function registerDeferredBuilder(scene: SceneContext): void {
    addDeferredSceneRenderables(scene, async (engine, sc) => {
        try {
            return {
                renderables: await buildMeshLoDBatchRenderables(engine, sc),
                dispose: () => disposeMeshLoDBatchPackets(scene),
            };
        } catch (error) {
            if (!scene._z) {
                registerDeferredBuilder(scene);
            }
            throw error;
        }
    });
}

/** @internal Register an instance into its scene-owned batch. Idempotent for the
 *  same scene/instance; validates the guaranteed opaque PBR subset immediately and
 *  writes no scene reference into the instance. */
export function addMeshLoDInstanceToScene(scene: SceneContext, instance: MeshLoDInstance): void {
    if (instance._asset._runtime.engine !== scene.surface.engine) {
        throw createMeshLoDError("MLOD_INVALID_OPTION", "MeshLoD instances must be registered with the asset's loading engine");
    }
    validateMeshLoDEngine(scene.surface.engine);
    validateMeshLoDMaterial(instance._material);
    const existingBatch = scene._meshLoDRegistry?.byAsset.get(instance._asset)?.get(instance._material);
    if (scene._built && !existingBatch?.renderable) {
        throw createMeshLoDError(
            "MLOD_INVALID_OPTION",
            "Add MeshLoD asset/material batches before registering the scene; only instances of batches with a live renderable can be added afterward"
        );
    }
    const registry = getOrCreateRegistry(scene);
    const batch = getOrCreateBatch(registry, instance._asset, instance._material);
    if (!batch.instances.includes(instance)) {
        batch.instances.push(instance);
    }
    if (!registry.builderRegistered) {
        registry.builderRegistered = true;
        registerDeferredBuilder(scene);
    }
}

/** @internal Reject engine configurations outside the MeshLoD rendering contract. */
export function validateMeshLoDEngine(engine: EngineContext): void {
    if (engine.useFloatingOrigin) {
        throw createMeshLoDError("MLOD_INVALID_OPTION", "MeshLoD v1 does not support floating-origin rendering", {
            expected: "useFloatingOrigin: false",
            actual: "useFloatingOrigin: true",
        });
    }
}

/** @internal Remove an instance from its scene-owned batch. Idempotent; the
 *  instance stops being selected and submitted immediately. */
export function removeMeshLoDInstanceFromScene(scene: SceneContext, instance: MeshLoDInstance): void {
    const registry = scene._meshLoDRegistry;
    const batch = registry?.byAsset.get(instance._asset)?.get(instance._material);
    if (!batch) {
        return;
    }
    const index = batch.instances.indexOf(instance);
    if (index !== -1) {
        batch.instances.splice(index, 1);
        instance._selectionVersion = (instance._selectionVersion ?? 0) + 1;
    }
}

/** One instance's per-frame selection output. */
export interface MeshLoDInstanceSelection {
    readonly instance: MeshLoDInstance;
    readonly result: MeshLoDSelectionResult;
}

/** CPU hysteresis for one stable instance ID in a single render binding. */
export interface MeshLoDCpuInstanceHistory {
    readonly selectionVersion: number;
    readonly fineRequired: Uint8Array;
}

/** @internal Resolve viewport pixels and the active projection's SSE scale for both selectors. */
export function getMeshLoDSelectionCamera(camera: Camera, context: DrawUpdateContext): MeshLoDCamera {
    const position = getCameraPosition(camera);
    const ortho = camera.ortho;
    const targetHeight = context.targetHeight * (camera.viewport?.height ?? 1);
    return {
        position: [position.x, position.y, position.z],
        verticalFov: camera.fov,
        perspectivePixelScale: ortho
            ? undefined
            : Math.fround((targetHeight * Math.abs(getProjectionMatrix(camera, getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight))[5]!)) / 2),
        near: camera.nearPlane,
        targetWidth: context.targetWidth * (camera.viewport?.width ?? 1),
        targetHeight,
        orthographicHeight: ortho ? (ortho.top ?? ortho.halfHeight) - (ortho.bottom ?? -ortho.halfHeight) : undefined,
    };
}

/** Run the deterministic CPU selection oracle for every visible instance in a
 *  batch. Coarse-only Phase 4 leaves frustum culling disabled (empty plane list);
 *  GPU selection adds it. Returns one result per visible instance, updating each
 *  instance's prior hysteresis state in the caller's binding-owned map. */
export function selectMeshLoDBatch(batch: MeshLoDSceneBatch, context: DrawUpdateContext, history: Map<number, MeshLoDCpuInstanceHistory>): MeshLoDInstanceSelection[] {
    const registeredIds = new Set(batch.instances.map((instance) => instance._instanceId));
    for (const id of history.keys()) {
        if (!registeredIds.has(id)) {
            history.delete(id);
        }
    }
    const camera = context._camera;
    if (!camera || batch.instances.length === 0) {
        return [];
    }
    const runtime: MeshLoDAssetRuntime = batch.asset._runtime;
    const oracleCamera = getMeshLoDSelectionCamera(camera, context);
    const isPageResident = (pageId: number): boolean => runtime.gpu.pages[pageId]?.state === "gpu-resident";
    const groupCount = runtime.groups.length;

    const selections: MeshLoDInstanceSelection[] = [];
    for (const instance of batch.instances) {
        if (!instance.visible) {
            continue;
        }
        const selectionVersion = instance._selectionVersion ?? 0;
        const prior = history.get(instance._instanceId);
        const wasFineRequired = prior?.selectionVersion === selectionVersion && prior.fineRequired.length === groupCount ? prior.fineRequired : new Uint8Array(groupCount);
        const result = selectMeshLoDCpu({
            groups: runtime.groups,
            clusters: runtime.clusters,
            nodes: runtime.hierarchyNodes,
            pageRecords: runtime.pageRecords,
            groupPageRefs: runtime.groupPageRefs,
            levelCount: runtime.header.levelCount,
            worldMatrix: instance.worldMatrix as unknown as readonly number[],
            camera: oracleCamera,
            frustumPlanes: [],
            screenSpaceError: instance.screenSpaceError ?? runtime.settings.screenSpaceError,
            lodHysteresis: runtime.settings.lodHysteresis,
            isPageResident,
            wasFineRequired,
            coneCull: batch.material.doubleSided !== true,
        });
        history.set(instance._instanceId, { selectionVersion, fineRequired: result.fineRequired });
        selections.push({ instance, result });
    }
    return selections;
}

/** Aggregate one batch's per-instance selection into asset-level fine-page demand and
 *  drive the asset's streaming step. Unions each instance's desired pages (keeping the
 *  summed float32 benefit before transfer-cost normalization), collects the pages every selected cluster references (so
 *  they hold a frame reference and are never evicted while the built frame is in flight),
 *  and publishes the visible/fallback/error selection diagnostics. Called once per frame
 *  by each material binding after selection, before it writes the draw stream.
 *  The producer is that binding's packet, not the shared scene batch. */
export function driveMeshLoDStreaming(batch: MeshLoDSceneBatch, selections: readonly MeshLoDInstanceSelection[], producer: object): void {
    const runtime: MeshLoDAssetRuntime = batch.asset._runtime;
    const benefitByPage = new Map<number, number>();
    const referenced = new Set<number>();
    let visibleGroupCount = 0;
    let fallbackGroupCount = 0;
    let maximumSelectedErrorPixels = 0;
    let maximumUnmetErrorPixels = 0;
    for (const { result } of selections) {
        for (const [pageId, benefit] of result.pageBenefits) {
            benefitByPage.set(pageId, addMeshLoDPageBenefit(benefitByPage.get(pageId) ?? 0, benefit));
        }
        for (const clusterId of result.selectedClusterIds) {
            referenced.add(runtime.clusters[clusterId]!.pageId);
        }
        visibleGroupCount = Math.max(visibleGroupCount, result.visibleGroupCount);
        fallbackGroupCount = Math.max(fallbackGroupCount, result.fallbackGroupCount);
        maximumSelectedErrorPixels = Math.max(maximumSelectedErrorPixels, result.maximumSelectedErrorPixels);
        maximumUnmetErrorPixels = Math.max(maximumUnmetErrorPixels, result.maximumUnmetErrorPixels);
    }
    const demand: MeshLoDPageDemand[] = [];
    for (const [pageId, benefit] of benefitByPage) {
        demand.push({ pageId, priority: benefit / runtime.pageRecords[pageId]!.storedBytes });
    }
    demand.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.pageId - b.pageId));
    const stats: MeshLoDStreamSelectionStats = { visibleGroupCount, fallbackGroupCount, maximumSelectedErrorPixels, maximumUnmetErrorPixels };
    const frame = queueMeshLoDFrame(runtime, producer, "cpu", demand, stats);
    holdMeshLoDPages(runtime, [...referenced], frame, true);
}
