/** MeshLoD CPU selection oracle — the deterministic float32 reference selector.
 *
 *  Implements architecture sections 10 (selection) and 11.1 (page demand) exactly,
 *  and is accepted as the correctness oracle before any GPU selection. It performs
 *  deterministic per-level hierarchy traversal, conservative frustum culling,
 *  hysteretic screen-space-error group selection, the crack-free group-DAG cut with
 *  a residency-fallback term, group-atomic cluster selection, and benefit/cost page demand.
 *
 *  All comparison-sensitive arithmetic uses `Math.fround` to emulate IEEE float32,
 *  so the oracle and the WGSL selection compute pass make identical decisions. The
 *  world matrix is column-major (WebGPU/WGSL order): columns 0-2 are the basis and
 *  column 3 (`m[12..14]`) is the translation. */

import type { MeshLoDCluster, MeshLoDGroup, MeshLoDHierarchyNode, MeshLoDPageRecord } from "./mesh-lod-runtime.js";
import type { MeshLoDFrustumPlane, ProjectedSphere } from "./mesh-lod-selection-math.js";
import { fadd, fmul, fsub, maxColumnScale, meshLoDConeCullMargin, perspectivePixelScale, projectSphere, sphereOutsidePlanes } from "./mesh-lod-selection-math.js";

export type { MeshLoDFrustumPlane } from "./mesh-lod-selection-math.js";

/** Camera + projection inputs. Perspective by default; set `orthographicHeight > 0`
 *  to use the orthographic screen-space-error equation. */
export interface MeshLoDCamera {
    readonly position: readonly [number, number, number];
    readonly verticalFov: number;
    readonly near: number;
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly orthographicHeight?: number;
}

export interface MeshLoDSelectionInput {
    readonly groups: readonly MeshLoDGroup[];
    readonly clusters: readonly MeshLoDCluster[];
    readonly nodes: readonly MeshLoDHierarchyNode[];
    readonly pageRecords: readonly MeshLoDPageRecord[];
    readonly groupPageRefs: Uint32Array | readonly number[];
    readonly levelCount: number;
    /** Column-major world matrix (16 floats). */
    readonly worldMatrix: readonly number[];
    readonly camera: MeshLoDCamera;
    /** Normalized frustum planes; an empty list disables culling. */
    readonly frustumPlanes: readonly MeshLoDFrustumPlane[];
    readonly screenSpaceError: number;
    readonly lodHysteresis: number;
    /** Residency predicate over page id. */
    readonly isPageResident: (pageId: number) => boolean;
    /** Prior per-group `wasFineRequired` bits (length `groups.length`). */
    readonly wasFineRequired: Uint8Array | readonly number[];
    /** Disable for double-sided materials. Defaults to enabled. */
    readonly coneCull?: boolean;
}

export interface MeshLoDDesiredPage {
    readonly pageId: number;
    readonly priority: number;
}

export interface MeshLoDSelectionResult {
    /** Selected visible cluster ids, ascending, no duplicates. */
    readonly selectedClusterIds: Uint32Array;
    /** Missing demanded pages, sorted by descending priority then ascending id. */
    readonly desiredPages: readonly MeshLoDDesiredPage[];
    /** Updated per-group `wasFineRequired` bits for the next frame. */
    readonly fineRequired: Uint8Array;
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly renderedTriangleCount: number;
    readonly selectedMeshletCount: number;
    readonly maximumSelectedErrorPixels: number;
    readonly maximumUnmetErrorPixels: number;
}

function project(input: MeshLoDSelectionInput, worldScale: number, pixelScale: number, center: readonly [number, number, number], radius: number, error: number): ProjectedSphere {
    return projectSphere(
        input.worldMatrix,
        input.camera.position,
        input.camera.near,
        input.camera.orthographicHeight,
        input.camera.targetHeight,
        worldScale,
        pixelScale,
        center,
        radius,
        error
    );
}

function groupResident(input: MeshLoDSelectionInput, group: MeshLoDGroup): boolean {
    for (let i = 0; i < group.pageRefCount; i++) {
        if (!input.isPageResident(input.groupPageRefs[group.firstPageRef + i]!)) {
            return false;
        }
    }
    return true;
}

/** Run the deterministic CPU selection oracle. */
export function selectMeshLoDCpu(input: MeshLoDSelectionInput): MeshLoDSelectionResult {
    const groupCount = input.groups.length;
    const worldScale = maxColumnScale(input.worldMatrix);
    const pixelScale = perspectivePixelScale(input.camera.targetHeight, input.camera.verticalFov);
    const refineBoundary = fmul(input.screenSpaceError, fadd(1, input.lodHysteresis));
    const coarsenBoundary = fmul(input.screenSpaceError, fsub(1, input.lodHysteresis));

    // Per-group projected error, fine-required decision, and residency.
    const groupErrorPx = new Float64Array(groupCount);
    const fineRequired = new Uint8Array(groupCount);
    const resident = new Uint8Array(groupCount);
    for (let g = 0; g < groupCount; g++) {
        const group = input.groups[g]!;
        resident[g] = groupResident(input, group) ? 1 : 0;
        if (group.terminal || !Number.isFinite(group.simplifiedError)) {
            fineRequired[g] = 1;
            groupErrorPx[g] = Number.POSITIVE_INFINITY;
            continue;
        }
        const errorPx = project(input, worldScale, pixelScale, group.center, group.radius, group.simplifiedError).errorPx;
        groupErrorPx[g] = errorPx;
        fineRequired[g] = (input.wasFineRequired[g] ? errorPx >= coarsenBoundary : errorPx > refineBoundary) ? 1 : 0;
    }

    // Deterministic per-level traversal marks conservatively visible groups.
    const visible = new Uint8Array(groupCount);
    const stack: number[] = [];
    for (let level = input.levelCount - 1; level >= 0; level--) {
        stack.push(level); // roots processed in ascending level order (LIFO seeded descending)
    }
    while (stack.length > 0) {
        const nodeIndex = stack.pop()!;
        const node = input.nodes[nodeIndex]!;
        const p = project(input, worldScale, pixelScale, node.center, node.radius, node.error);
        if (sphereOutsidePlanes(input.frustumPlanes, p.worldCenter, p.worldRadius)) {
            continue;
        }
        if (node.groupId === -1) {
            for (let c = node.childCount - 1; c >= 0; c--) {
                stack.push(node.childOffset + c);
            }
        } else {
            visible[node.groupId] = 1;
        }
    }

    // Crack-free group-DAG cut. Once a group survives hierarchy culling, keep its
    // selected clusters atomic: a second, tighter cluster-sphere test can disagree
    // with conservative group coverage and create view-dependent holes.
    const selected: number[] = [];
    const demandShare = new Map<number, number>();
    const demandedGroups = new Set<number>();
    let renderedTriangleCount = 0;
    let maximumSelectedErrorPixels = 0;
    for (let c = 0; c < input.clusters.length; c++) {
        const cluster = input.clusters[c]!;
        const g = cluster.groupId;
        if (!visible[g] || !resident[g] || !fineRequired[g]) {
            continue;
        }
        const r = cluster.refinedGroupId;
        const refineHere = r !== -1 && fineRequired[r] === 1 && resident[r] === 1;
        if (refineHere) {
            continue; // the finer group is wanted and resident: it will draw instead
        }
        if (
            input.coneCull !== false &&
            !(input.camera.orthographicHeight !== undefined && input.camera.orthographicHeight > 0) &&
            meshLoDConeCullMargin(input.worldMatrix, input.camera.position, cluster.center, cluster.radius, cluster.normalCone) <= 0
        ) {
            continue;
        }
        selected.push(c);
        renderedTriangleCount += cluster.triangleCount;
        const err = groupErrorPx[g]!;
        if (Number.isFinite(err) && err > maximumSelectedErrorPixels) {
            maximumSelectedErrorPixels = err;
        }
        // Fallback: the finer group is wanted but not resident → demand its pages.
        if (r !== -1 && fineRequired[r] === 1 && resident[r] === 0) {
            demandedGroups.add(r);
        }
    }

    // Page demand priority (architecture 11.1).
    let maximumUnmetErrorPixels = 0;
    for (const r of demandedGroups) {
        const group = input.groups[r]!;
        const missing: number[] = [];
        for (let i = 0; i < group.pageRefCount; i++) {
            const pageId = input.groupPageRefs[group.firstPageRef + i]!;
            if (!input.isPageResident(pageId)) {
                missing.push(pageId);
            }
        }
        if (missing.length === 0) {
            continue;
        }
        const p = project(input, worldScale, pixelScale, group.center, group.radius, group.simplifiedError);
        const errorPx = p.errorPx;
        if (errorPx > maximumUnmetErrorPixels) {
            maximumUnmetErrorPixels = errorPx;
        }
        const areaCap = input.camera.targetWidth * input.camera.targetHeight;
        const projectedAreaPx = Math.min(Math.PI * p.projectedRadiusPx * p.projectedRadiusPx, areaCap);
        const qualityPressure = Math.max(0, errorPx / input.screenSpaceError - 1);
        const groupBenefit = projectedAreaPx * qualityPressure;
        const pageShare = groupBenefit / missing.length;
        for (const pageId of missing) {
            demandShare.set(pageId, (demandShare.get(pageId) ?? 0) + pageShare);
        }
    }

    const desiredPages: MeshLoDDesiredPage[] = [];
    for (const [pageId, share] of demandShare) {
        const stored = input.pageRecords[pageId]?.storedBytes ?? 1;
        desiredPages.push({ pageId, priority: share / stored });
    }
    desiredPages.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.pageId - b.pageId));

    let visibleGroupCount = 0;
    for (let g = 0; g < groupCount; g++) {
        visibleGroupCount += visible[g]!;
    }

    return {
        selectedClusterIds: Uint32Array.from(selected),
        desiredPages,
        fineRequired,
        visibleGroupCount,
        fallbackGroupCount: demandedGroups.size,
        renderedTriangleCount,
        selectedMeshletCount: selected.length,
        maximumSelectedErrorPixels,
        maximumUnmetErrorPixels,
    };
}
