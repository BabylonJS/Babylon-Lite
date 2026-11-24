/** MeshLoD per-frame CPU selection and streaming demand, shared by the scene
 *  registry (mesh-lod-scene.ts) and the PBR MeshLoD renderable it lazy-loads.
 *  Kept apart from mesh-lod-scene.ts so the lazily-loaded renderable never
 *  statically imports its loader (tests/lite/build/lazy-import-cycles.test.ts). */

import type { EngineContext } from "../engine/engine.js";
import type { DrawUpdateContext } from "../render/renderable.js";
import type { Camera } from "../camera/camera.js";
import { getCameraPosition, getEffectiveAspectRatio, getProjectionMatrix } from "../camera/camera.js";
import type { MeshLoDInstance } from "./mesh-lod.js";
import type { MeshLoDAssetRuntime, MeshLoDStreamSelectionStats } from "./mesh-lod-runtime.js";
import { holdMeshLoDPages, queueMeshLoDFrame } from "./mesh-lod-runtime.js";
import type { MeshLoDSceneBatch } from "./mesh-lod-scene.js";
import type { MeshLoDPageDemand } from "./mesh-lod-scheduler.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDCamera, MeshLoDSelectionResult } from "./mesh-lod-selection-cpu.js";
import { selectMeshLoDCpu } from "./mesh-lod-selection-cpu.js";
import { addMeshLoDPageBenefit } from "./mesh-lod-selection-math.js";

/** @internal Reject engine configurations outside the MeshLoD rendering contract. */
export function validateMeshLoDEngine(engine: EngineContext): void {
    if (engine.useFloatingOrigin) {
        throw createMeshLoDError("MLOD_INVALID_OPTION", "MeshLoD v1 does not support floating-origin rendering", {
            expected: "useFloatingOrigin: false",
            actual: "useFloatingOrigin: true",
        });
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
