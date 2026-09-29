/** MeshLoD GPU selection buffers — persistent packed metadata and per-batch state.
 *
 *  Phase 5 moves selection/expansion to compute. This module owns the CPU→GPU data
 *  contract only (architecture §12.1): it packs the parsed immutable hierarchy into
 *  the exact `Uint32Array` word layouts the selection WGSL reads, allocates the
 *  device-limit-checked persistent storage buffers, keeps the mutable page-state and
 *  per-instance/prior-state buffers in sync, and grows the transient-capacity buffers
 *  make-before-break. It never parses WGSL strings and never exposes a raw GPU handle
 *  outside the internal runtime/material records.
 *
 *  Buffer ownership mirrors the sharing model:
 *  - immutable node/group/cluster/page-ref buffers and the mutable page-state buffer
 *    are per **asset** (`MeshLoDGpuAssetBuffers`), so every scene batch and instance
 *    that shares one hierarchy reuses them;
 *  - the instance transform buffer and per-instance/group prior-hysteresis bitset are
 *    per **batch** (`MeshLoDGpuInstanceState`), so instance state stays independent. */

import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import type { DrawUpdateBatch } from "../render/renderable.js";
import type { RenderTargetSignature } from "../engine/render-target.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDFrustumPlane } from "./mesh-lod-selection-math.js";
import {
    extractFrustumPlanes,
    isSimilarityTransform,
    maxColumnScale,
    meshLoDConeCullMargin,
    perspectivePixelScale,
    projectSphere,
    sphereOutsidePlanes,
} from "./mesh-lod-selection-math.js";
import type {
    MeshLoDAssetRuntime,
    MeshLoDCluster,
    MeshLoDGroup,
    MeshLoDHierarchyNode,
    MeshLoDPageRecord,
    MeshLoDPageRuntime,
    MeshLoDStreamSelectionStats,
} from "./mesh-lod-runtime.js";
import { stepMeshLoDStreaming } from "./mesh-lod-runtime.js";
import type { MeshLoDPageDemand } from "./mesh-lod-scheduler.js";
import selectionWgsl from "./mesh-lod-selection.wgsl?raw";

// ─── Record word/byte layouts (architecture §12.1) ───────────────────

/** 8 × u32 words per 32-byte hierarchy node. */
export const NODE_WORDS = 8;
/** 16 × u32 words per 64-byte group. */
export const GROUP_WORDS = 16;
/** 16 × u32 words per 64-byte cluster. */
export const CLUSTER_WORDS = 16;
/** 8 × u32 words per 32-byte page-state record. */
export const PAGE_STATE_WORDS = 8;
/** 128-byte / 32-word instance record. */
export const INSTANCE_BYTES = 128;
export const INSTANCE_WORDS = INSTANCE_BYTES / 4;
/** 24-byte packed vertex (position f32x3, oct-normal, half-UV, reserved) → 6 words. */
export const VERTEX_WORDS = 6;

/** Page-state flag bits (word 0). */
export const PAGE_FLAG_RESIDENT = 0x1;
export const PAGE_FLAG_PINNED = 0x2;
export const PAGE_FLAG_FAILED = 0x4;
export const PAGE_FLAG_UPLOADING = 0x8;

const F32_SCRATCH = new Float32Array(1);
const U32_SCRATCH = new Uint32Array(F32_SCRATCH.buffer);

/** Reinterpret a float32 as its u32 bit pattern (the WGSL `bitcast<u32>` a shader
 *  reverses with `bitcast<f32>`). */
function f32Bits(value: number): number {
    F32_SCRATCH[0] = value;
    return U32_SCRATCH[0]!;
}

/** Reinterpret a u32 bit pattern back to float32 (mirrors the WGSL `bitcast<f32>`). */
function u32ToF32(bits: number): number {
    U32_SCRATCH[0] = bits;
    return F32_SCRATCH[0]!;
}

// ─── Immutable metadata packing ──────────────────────────────────────

/** Pack the 8-wide hierarchy nodes into `NODE_WORDS` words each: center xyz + radius
 *  + error as float bits, then `groupId` (i32, `-1` internal), child offset, child
 *  count. */
export function packHierarchyNodes(nodes: readonly MeshLoDHierarchyNode[]): Uint32Array {
    const out = new Uint32Array(Math.max(nodes.length, 1) * NODE_WORDS);
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const b = i * NODE_WORDS;
        out[b] = f32Bits(n.center[0]);
        out[b + 1] = f32Bits(n.center[1]);
        out[b + 2] = f32Bits(n.center[2]);
        out[b + 3] = f32Bits(n.radius);
        out[b + 4] = f32Bits(n.error);
        out[b + 5] = n.groupId | 0;
        out[b + 6] = n.childOffset;
        out[b + 7] = n.childCount;
    }
    return out;
}

/** Pack groups into `GROUP_WORDS` words: center/radius/simplifiedError float bits,
 *  depth, cluster range, page-ref range, terminal/pinned flags, and triangle counts. */
export function packGroups(groups: readonly MeshLoDGroup[]): Uint32Array {
    const out = new Uint32Array(Math.max(groups.length, 1) * GROUP_WORDS);
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i]!;
        const b = i * GROUP_WORDS;
        out[b] = f32Bits(g.center[0]);
        out[b + 1] = f32Bits(g.center[1]);
        out[b + 2] = f32Bits(g.center[2]);
        out[b + 3] = f32Bits(g.radius);
        out[b + 4] = f32Bits(g.simplifiedError);
        out[b + 5] = g.depth;
        out[b + 6] = g.firstCluster;
        out[b + 7] = g.clusterCount;
        out[b + 8] = g.firstPageRef;
        out[b + 9] = g.pageRefCount;
        out[b + 10] = (g.terminal ? 0x1 : 0) | (g.pinned ? 0x2 : 0);
        out[b + 11] = g.sourceTriangleCount;
        out[b + 12] = g.outputTriangleCount;
    }
    return out;
}

/** Pack clusters into `CLUSTER_WORDS` words: center/radius/error float bits, group
 *  id, `refinedGroupId` (i32, `-1` finest), page id, vertex/index offsets, vertex and
 *  triangle counts. */
export function packClusters(clusters: readonly MeshLoDCluster[]): Uint32Array {
    const out = new Uint32Array(Math.max(clusters.length, 1) * CLUSTER_WORDS);
    for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i]!;
        const b = i * CLUSTER_WORDS;
        out[b] = f32Bits(c.center[0]);
        out[b + 1] = f32Bits(c.center[1]);
        out[b + 2] = f32Bits(c.center[2]);
        out[b + 3] = f32Bits(c.radius);
        out[b + 4] = f32Bits(c.error);
        out[b + 5] = c.groupId;
        out[b + 6] = c.refinedGroupId | 0;
        out[b + 7] = c.pageId;
        out[b + 8] = c.vertexOffset;
        out[b + 9] = c.indexOffset;
        out[b + 10] = c.vertexCount;
        out[b + 11] = c.triangleCount;
        out[b + 12] = c.sourceTriangleCount;
        if (c.normalCone) {
            const packSnorm8 = (value: number): number => Math.round(Math.max(-1, Math.min(1, value)) * 127) & 0xff;
            out[b + 13] = packSnorm8(c.normalCone[0]) | (packSnorm8(c.normalCone[1]) << 8) | (packSnorm8(c.normalCone[2]) << 16);
            out[b + 14] = f32Bits(c.normalCone[3]);
            out[b + 15] = 1;
        }
    }
    return out;
}

/** Pack the flat group→page-ref table as raw `u32` page IDs. */
export function packGroupPageRefs(refs: Uint32Array): Uint32Array {
    return refs.length > 0 ? Uint32Array.from(refs) : new Uint32Array(1);
}

/** Write one page-state record (`PAGE_STATE_WORDS` words) from a runtime page and its
 *  immutable record. Vertex/index byte offsets are absolute within the arena so the
 *  expansion kernel can index the raw geometry directly; they read as zero until the
 *  page is resident. */
export function writePageStateRecord(out: Uint32Array, wordBase: number, page: MeshLoDPageRuntime, record: MeshLoDPageRecord, generation: number): void {
    const resident = page.state === "gpu-resident" && page.arenaOffset >= 0;
    const base = resident ? page.arenaOffset : 0;
    out[wordBase] = (resident ? PAGE_FLAG_RESIDENT : 0) | (record.pinned ? PAGE_FLAG_PINNED : 0) | (page.state === "terminal-failed" ? PAGE_FLAG_FAILED : 0);
    out[wordBase + 1] = base;
    out[wordBase + 2] = resident ? base + record.vertexByteOffset : 0;
    out[wordBase + 3] = resident ? base + record.indexByteOffset : 0;
    out[wordBase + 4] = record.vertexCount;
    out[wordBase + 5] = record.localIndexCount;
    out[wordBase + 6] = resident ? generation : 0;
    out[wordBase + 7] = 0;
}

/** Build the full page-state array from the current runtime residency. */
export function buildPageStateData(pages: readonly MeshLoDPageRuntime[], records: readonly MeshLoDPageRecord[], generation: number): Uint32Array {
    const out = new Uint32Array(Math.max(pages.length, 1) * PAGE_STATE_WORDS);
    for (let i = 0; i < pages.length; i++) {
        writePageStateRecord(out, i * PAGE_STATE_WORDS, pages[i]!, records[i]!, generation);
    }
    return out;
}

// ─── Instance record packing ─────────────────────────────────────────

/** Structural instance input consumed by {@link uploadMeshLoDInstances}; avoids a
 *  runtime dependency on the public `MeshLoDInstance` type. */
export interface MeshLoDGpuInstanceInput {
    readonly worldMatrix: ArrayLike<number>;
    readonly worldMatrixVersion: number;
    readonly visible: boolean;
    /** @internal Stable per-asset instance ID (slot identity for version gating). */
    readonly _instanceId: number;
}

/** Write one 128-byte instance record: world matrix, cofactor normal matrix as three
 *  padded `vec4` rows, maximum world scale, visibility flag, and stable instance ID.
 *  The cofactor matrix `(c1×c2, c2×c0, c0×c1)` is the inverse-transpose up to
 *  determinant — correct after the shader's `normalize()`. */
export function packInstanceRecord(f32: Float32Array, u32: Uint32Array, wordBase: number, world: ArrayLike<number>, visible: boolean, instanceId: number): void {
    for (let i = 0; i < 16; i++) {
        f32[wordBase + i] = world[i]!;
    }
    const c0x = world[0]!,
        c0y = world[1]!,
        c0z = world[2]!;
    const c1x = world[4]!,
        c1y = world[5]!,
        c1z = world[6]!;
    const c2x = world[8]!,
        c2y = world[9]!,
        c2z = world[10]!;
    f32[wordBase + 16] = c1y * c2z - c1z * c2y;
    f32[wordBase + 17] = c1z * c2x - c1x * c2z;
    f32[wordBase + 18] = c1x * c2y - c1y * c2x;
    f32[wordBase + 19] = 0;
    f32[wordBase + 20] = c2y * c0z - c2z * c0y;
    f32[wordBase + 21] = c2z * c0x - c2x * c0z;
    f32[wordBase + 22] = c2x * c0y - c2y * c0x;
    f32[wordBase + 23] = 0;
    f32[wordBase + 24] = c0y * c1z - c0z * c1y;
    f32[wordBase + 25] = c0z * c1x - c0x * c1z;
    f32[wordBase + 26] = c0x * c1y - c0y * c1x;
    f32[wordBase + 27] = 0;
    f32[wordBase + 28] = maxColumnScale(world); // bytes 112–115: maximum world scale
    u32[wordBase + 29] = visible ? 1 : 0; // bytes 116–119: visibility flags
    u32[wordBase + 30] = instanceId >>> 0; // bytes 120–123: stable instance ID
    u32[wordBase + 31] = isSimilarityTransform(world) ? 1 : 0;
}

// ─── Deterministic GPU selection model (WGSL mirror for Node equivalence) ──

/** Camera + selection parameters for the GPU model, matching the params UBO the
 *  WGSL compute reads. */
export interface MeshLoDGpuSelectionParams {
    readonly cameraPos: readonly [number, number, number];
    readonly verticalFov: number;
    readonly near: number;
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly orthographicHeight?: number;
    readonly frustumPlanes: readonly MeshLoDFrustumPlane[];
    readonly screenSpaceError: number;
    readonly lodHysteresis: number;
    readonly levelCount: number;
    readonly coneCull?: boolean;
}

/** Packed inputs to the GPU selection model — exactly the buffers uploaded to the
 *  GPU. Reading them here validates the byte packing along the selection path. */
export interface MeshLoDGpuSelectionModelInput {
    readonly nodes: Uint32Array;
    readonly groups: Uint32Array;
    readonly clusters: Uint32Array;
    readonly groupPageRefs: Uint32Array;
    readonly pageState: Uint32Array;
    readonly pageStoredBytes: ArrayLike<number>;
    /** Packed 128-byte instance records (`Float32Array`, `INSTANCE_WORDS` per slot). */
    readonly instances: Float32Array;
    /** Same buffer as `instances`, `u32` view (visibility/id words). */
    readonly instancesU32: Uint32Array;
    /** Prior per-instance/group `wasFineRequired` bitset; updated in place. */
    readonly priorState: Uint32Array;
    readonly instanceCount: number;
    readonly nodeCount: number;
    readonly groupCount: number;
    readonly clusterCount: number;
    readonly pageCount: number;
    readonly wordsPerInstance: number;
    readonly params: MeshLoDGpuSelectionParams;
    /** Optional selected-list capacity; exceeding it sets `overflow` without OOB writes. */
    readonly maxSelected?: number;
}

/** One selected (cluster, instance) pair in deterministic append order. */
export interface MeshLoDGpuSelectedPair {
    readonly clusterId: number;
    readonly instanceId: number;
}

export interface MeshLoDGpuSelectionModelResult {
    readonly selected: MeshLoDGpuSelectedPair[];
    readonly desiredPages: { readonly pageId: number; readonly priority: number }[];
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly renderedTriangleCount: number;
    readonly selectedMeshletCount: number;
    readonly maximumSelectedErrorPixels: number;
    readonly maximumUnmetErrorPixels: number;
    readonly overflow: boolean;
}

function priorBit(prior: Uint32Array, slot: number, wordsPerInstance: number, group: number): boolean {
    return (prior[slot * wordsPerInstance + (group >>> 5)]! & (1 << (group & 31))) !== 0;
}

function setPriorBit(prior: Uint32Array, slot: number, wordsPerInstance: number, group: number, value: boolean): void {
    const idx = slot * wordsPerInstance + (group >>> 5);
    const mask = 1 << (group & 31);
    prior[idx] = value ? prior[idx]! | mask : prior[idx]! & ~mask;
}

function nodeCenter(nodes: Uint32Array, base: number): [number, number, number] {
    return [u32ToF32(nodes[base]!), u32ToF32(nodes[base + 1]!), u32ToF32(nodes[base + 2]!)];
}

function pageResident(pageState: Uint32Array, pageId: number): boolean {
    return (pageState[pageId * PAGE_STATE_WORDS]! & PAGE_FLAG_RESIDENT) !== 0;
}

function groupPagesResident(input: MeshLoDGpuSelectionModelInput, firstPageRef: number, pageRefCount: number): boolean {
    for (let i = 0; i < pageRefCount; i++) {
        if (!pageResident(input.pageState, input.groupPageRefs[firstPageRef + i]!)) {
            return false;
        }
    }
    return true;
}

/** Run the deterministic GPU selection model over the packed buffers. It reproduces
 *  the selection WGSL exactly (shared float32 math, per-instance dispatch, per-leaf
 *  frustum visibility, crack-free residency cut, atomic-append ordering, and the
 *  benefit/cost page demand) so Node fixtures can compare GPU selection to the CPU
 *  oracle without a real device. Returns selected (cluster, instance) pairs in
 *  append order (ascending instance, then ascending cluster). */
export function runMeshLoDGpuSelection(input: MeshLoDGpuSelectionModelInput): MeshLoDGpuSelectionModelResult {
    const { params, groupCount, clusterCount, nodeCount, wordsPerInstance } = input;
    const pixelScale = perspectivePixelScale(params.targetHeight, params.verticalFov);
    const refineBoundary = Math.fround(params.screenSpaceError * Math.fround(1 + params.lodHysteresis));
    const coarsenBoundary = Math.fround(params.screenSpaceError * Math.fround(1 - params.lodHysteresis));
    const maxSelected = input.maxSelected ?? Number.POSITIVE_INFINITY;

    const selected: MeshLoDGpuSelectedPair[] = [];
    const demandShare = new Map<number, number>();
    let visibleGroupCount = 0;
    let fallbackGroupCount = 0;
    let renderedTriangleCount = 0;
    let selectedMeshletCount = 0;
    let maximumSelectedErrorPixels = 0;
    let maximumUnmetErrorPixels = 0;
    let overflow = false;

    const world = new Float32Array(16);
    const groupErrorPx = new Float64Array(groupCount);
    const fineRequired = new Uint8Array(groupCount);
    const resident = new Uint8Array(groupCount);
    const visible = new Uint8Array(groupCount);

    for (let s = 0; s < input.instanceCount; s++) {
        const iBase = s * INSTANCE_WORDS;
        if (input.instancesU32[iBase + 29] === 0) {
            continue; // invisible instance contributes nothing
        }
        for (let i = 0; i < 16; i++) {
            world[i] = input.instances[iBase + i]!;
        }
        const worldScale = input.instances[iBase + 28]!; // precomputed max column scale

        // Group evaluation + prior-state hysteresis update.
        for (let g = 0; g < groupCount; g++) {
            const gBase = g * GROUP_WORDS;
            resident[g] = groupPagesResident(input, input.groups[gBase + 8]!, input.groups[gBase + 9]!) ? 1 : 0;
            const simplifiedError = u32ToF32(input.groups[gBase + 4]!);
            const terminal = (input.groups[gBase + 10]! & 0x1) !== 0;
            if (terminal || !Number.isFinite(simplifiedError)) {
                fineRequired[g] = 1;
                groupErrorPx[g] = Number.POSITIVE_INFINITY;
                setPriorBit(input.priorState, s, wordsPerInstance, g, true);
                continue;
            }
            const center: [number, number, number] = [u32ToF32(input.groups[gBase]!), u32ToF32(input.groups[gBase + 1]!), u32ToF32(input.groups[gBase + 2]!)];
            const radius = u32ToF32(input.groups[gBase + 3]!);
            const errorPx = projectSphere(
                world,
                params.cameraPos,
                params.near,
                params.orthographicHeight,
                params.targetHeight,
                worldScale,
                pixelScale,
                center,
                radius,
                simplifiedError
            ).errorPx;
            groupErrorPx[g] = errorPx;
            const wasFine = priorBit(input.priorState, s, wordsPerInstance, g);
            const fine = wasFine ? errorPx >= coarsenBoundary : errorPx > refineBoundary;
            fineRequired[g] = fine ? 1 : 0;
            setPriorBit(input.priorState, s, wordsPerInstance, g, fine);
        }

        // Per-leaf-node frustum visibility (equivalent to root-down traversal under
        // conservative bounds: a not-outside leaf's ancestors are all not-outside).
        visible.fill(0);
        for (let n = 0; n < nodeCount; n++) {
            const nBase = n * NODE_WORDS;
            const gid = input.nodes[nBase + 5]! | 0;
            if (gid === -1) {
                continue;
            }
            const p = projectSphere(
                world,
                params.cameraPos,
                params.near,
                params.orthographicHeight,
                params.targetHeight,
                worldScale,
                pixelScale,
                nodeCenter(input.nodes, nBase),
                u32ToF32(input.nodes[nBase + 3]!),
                u32ToF32(input.nodes[nBase + 4]!)
            );
            if (!sphereOutsidePlanes(params.frustumPlanes, p.worldCenter, p.worldRadius)) {
                visible[gid] = 1;
            }
        }
        for (let g = 0; g < groupCount; g++) {
            visibleGroupCount += visible[g]!;
        }

        // Crack-free group-DAG cut. Hierarchy-visible groups remain atomic so
        // tighter cluster bounds cannot punch holes in visible coverage.
        const demandedGroups = new Set<number>();
        for (let c = 0; c < clusterCount; c++) {
            const cBase = c * CLUSTER_WORDS;
            const g = input.clusters[cBase + 5]!;
            if (!visible[g] || !resident[g] || !fineRequired[g]) {
                continue;
            }
            const r = input.clusters[cBase + 6]! | 0;
            if (r !== -1 && fineRequired[r] === 1 && resident[r] === 1) {
                continue; // finer group wanted and resident: it will draw instead
            }
            if (
                params.coneCull !== false &&
                !(params.orthographicHeight !== undefined && params.orthographicHeight > 0) &&
                input.instancesU32[iBase + 31] !== 0 &&
                input.clusters[cBase + 15] !== 0
            ) {
                const packed = input.clusters[cBase + 13]!;
                const snorm8 = (shift: number): number => {
                    const byte = (packed >>> shift) & 0xff;
                    return (byte >= 0x80 ? byte - 0x100 : byte) / 127;
                };
                const normalCone: [number, number, number, number] = [snorm8(0), snorm8(8), snorm8(16), u32ToF32(input.clusters[cBase + 14]!)];
                const center: [number, number, number] = [u32ToF32(input.clusters[cBase]!), u32ToF32(input.clusters[cBase + 1]!), u32ToF32(input.clusters[cBase + 2]!)];
                if (meshLoDConeCullMargin(world, params.cameraPos, center, u32ToF32(input.clusters[cBase + 3]!), normalCone) <= 0) {
                    continue;
                }
            }
            if (selected.length >= maxSelected) {
                overflow = true;
                break;
            }
            selected.push({ clusterId: c, instanceId: s });
            selectedMeshletCount++;
            renderedTriangleCount += input.clusters[cBase + 11]!;
            const err = groupErrorPx[g]!;
            if (Number.isFinite(err) && err > maximumSelectedErrorPixels) {
                maximumSelectedErrorPixels = err;
            }
            if (r !== -1 && fineRequired[r] === 1 && resident[r] === 0) {
                demandedGroups.add(r);
            }
        }

        // Page demand priority (architecture §11.1), per demanded finer group.
        for (const r of demandedGroups) {
            const gBase = r * GROUP_WORDS;
            const firstPageRef = input.groups[gBase + 8]!;
            const pageRefCount = input.groups[gBase + 9]!;
            const missing: number[] = [];
            for (let i = 0; i < pageRefCount; i++) {
                const pageId = input.groupPageRefs[firstPageRef + i]!;
                if (!pageResident(input.pageState, pageId)) {
                    missing.push(pageId);
                }
            }
            if (missing.length === 0) {
                continue;
            }
            fallbackGroupCount++;
            const center: [number, number, number] = [u32ToF32(input.groups[gBase]!), u32ToF32(input.groups[gBase + 1]!), u32ToF32(input.groups[gBase + 2]!)];
            const p = projectSphere(
                world,
                params.cameraPos,
                params.near,
                params.orthographicHeight,
                params.targetHeight,
                worldScale,
                pixelScale,
                center,
                u32ToF32(input.groups[gBase + 3]!),
                u32ToF32(input.groups[gBase + 4]!)
            );
            if (p.errorPx > maximumUnmetErrorPixels) {
                maximumUnmetErrorPixels = p.errorPx;
            }
            const areaCap = params.targetWidth * params.targetHeight;
            const projectedAreaPx = Math.min(Math.PI * p.projectedRadiusPx * p.projectedRadiusPx, areaCap);
            const qualityPressure = Math.max(0, p.errorPx / params.screenSpaceError - 1);
            const groupBenefit = projectedAreaPx * qualityPressure;
            const pageShare = groupBenefit / missing.length;
            for (const pageId of missing) {
                demandShare.set(pageId, (demandShare.get(pageId) ?? 0) + pageShare);
            }
        }
    }

    const desiredPages: { pageId: number; priority: number }[] = [];
    for (const [pageId, share] of demandShare) {
        const stored = input.pageStoredBytes[pageId] ?? 1;
        desiredPages.push({ pageId, priority: share / stored });
    }
    desiredPages.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.pageId - b.pageId));

    return {
        selected,
        desiredPages,
        visibleGroupCount,
        fallbackGroupCount,
        renderedTriangleCount,
        selectedMeshletCount,
        maximumSelectedErrorPixels,
        maximumUnmetErrorPixels,
        overflow,
    };
}

/** Packed inputs to the GPU expansion model — the buffers the expandClusters kernel
 *  reads. */
export interface MeshLoDGpuExpansionInput {
    readonly selected: readonly MeshLoDGpuSelectedPair[];
    readonly clusters: Uint32Array;
    readonly clusterWordOffset?: number;
    readonly pageState: Uint32Array;
    /** Decoded geometry arena words (vertex + index blocks per page). */
    readonly arena: Uint32Array;
    readonly drawVertexCapacity: number;
}

export interface MeshLoDGpuExpansionResult {
    /** 4 words per expanded vertex: arena vertex-word offset, cluster ID, slot, flags. */
    readonly drawVertices: Uint32Array;
    readonly vertexCount: number;
    readonly overflow: boolean;
}

function readArenaU16(arena: Uint32Array, byteOffset: number): number {
    const word = arena[byteOffset >>> 2]!;
    const shift = (byteOffset & 2) * 8;
    return (word >>> shift) & 0xffff;
}

/** Run the deterministic GPU expansion model — the exact TS mirror of the WGSL
 *  `expandClusters` kernel over the same packed buffers. Expands each selected cluster
 *  in order into absolute arena vertex-word offsets + IDs, bounded by capacity. Used by
 *  Node fixtures to prove exact expanded records; the WGSL is browser-validated. */
export function runMeshLoDGpuExpansion(input: MeshLoDGpuExpansionInput): MeshLoDGpuExpansionResult {
    const cwo = input.clusterWordOffset ?? 0;
    const cap = input.drawVertexCapacity;
    const draw = new Uint32Array(Math.max(cap, 0) * 4);
    let vertexCount = 0;
    let overflow = false;
    for (const { clusterId, instanceId } of input.selected) {
        const cBase = cwo + clusterId * CLUSTER_WORDS;
        const pageId = input.clusters[cBase + 7]!;
        const clusterIndexOffset = input.clusters[cBase + 9]!;
        const indexCount = input.clusters[cBase + 11]! * 3;
        const psBase = pageId * PAGE_STATE_WORDS;
        const arenaVertexWord = input.pageState[psBase + 2]! >>> 2;
        const arenaIndexByte = input.pageState[psBase + 3]!;
        const base = vertexCount;
        for (let k = 0; k < indexCount; k++) {
            const dst = base + k;
            if (dst >= cap) {
                overflow = true;
                continue;
            }
            const localVertex = readArenaU16(input.arena, arenaIndexByte + (clusterIndexOffset + k) * 2);
            const o = dst * 4;
            draw[o] = arenaVertexWord + localVertex * VERTEX_WORDS;
            draw[o + 1] = clusterId;
            draw[o + 2] = instanceId;
            draw[o + 3] = 0;
        }
        vertexCount += indexCount;
    }
    return { drawVertices: draw, vertexCount: Math.min(vertexCount, cap), overflow };
}

// ─── Device-limit-checked storage buffers ────────────────────────────

function checkedStorageBuffer(engine: EngineContext, byteLength: number, label: string, extraUsage = 0): GPUBuffer {
    const size = Math.max(byteLength, 4);
    const limits = engine._device.limits;
    const cap = Math.min(limits?.maxStorageBufferBindingSize ?? size, limits?.maxBufferSize ?? size);
    if (size > cap) {
        throw createMeshLoDError("MLOD_DEVICE_LIMIT", `MeshLoD ${label} exceeds the device storage-buffer limit`, { expected: cap, actual: size });
    }
    return engine._device.createBuffer({ label, size, usage: BU.STORAGE | BU.COPY_DST | extraUsage });
}

/** Cheap content-sensitive signature over (generation, per-page residency + arena
 *  offset). It changes whenever which pages are resident or where they live changes,
 *  so the page-state upload can be skipped when nothing moved — including the
 *  evict-A/load-B case where the resident count is unchanged. */
function residencySignature(runtime: MeshLoDAssetRuntime): number {
    let sig = Math.imul(runtime.generation + 1, 2654435761) >>> 0;
    const pages = runtime.gpu.pages;
    for (let i = 0; i < pages.length; i++) {
        const p = pages[i]!;
        const resident = p.state === "gpu-resident" && p.arenaOffset >= 0;
        const failed = p.state === "terminal-failed" ? 0x40000000 : 0;
        sig = (sig ^ ((resident ? p.arenaOffset + 1 : 0) | failed)) >>> 0;
        sig = Math.imul(sig ^ i, 2246822519) >>> 0;
    }
    return sig;
}

// ─── Per-asset persistent buffers ────────────────────────────────────

/** Immutable per-asset metadata buffer plus the mutable page-state buffer. Shared by
 *  every scene batch and instance referencing the same asset. The four immutable
 *  tables are concatenated into one `metaBuffer` (nodes ++ groups ++ clusters ++
 *  group-page-refs) so the selection compute stays within the 8-storage-buffer limit;
 *  their word offsets are published for the params UBO and bind-group indexing. */
export interface MeshLoDGpuAssetBuffers {
    readonly device: GPUDevice;
    readonly metaBuffer: GPUBuffer;
    readonly pageStateBuffer: GPUBuffer;
    /** CPU mirror of the page-state words, re-derived and re-uploaded on residency change. */
    readonly pageStateData: Uint32Array;
    /** `u32` word offsets into `metaBuffer` for each concatenated table. */
    readonly nodeWordOffset: number;
    readonly groupWordOffset: number;
    readonly clusterWordOffset: number;
    readonly pageRefWordOffset: number;
    readonly nodeCount: number;
    readonly groupCount: number;
    readonly clusterCount: number;
    readonly pageCount: number;
    /** Residency generation of the last page-state upload, to skip redundant writes. */
    residencyEpoch: number;
    /** Total bytes across the owned buffers, for diagnostics only. */
    readonly byteLength: number;
}

/** Build (once) and return the shared per-asset GPU buffers, caching them on the
 *  runtime. Recreated after a device change so caches auto-invalidate. */
export function getMeshLoDGpuAssetBuffers(engine: EngineContext, runtime: MeshLoDAssetRuntime): MeshLoDGpuAssetBuffers {
    const existing = runtime.gpuSelection;
    if (existing && existing.device === engine._device) {
        return existing;
    }
    if (existing) {
        disposeMeshLoDGpuAssetBuffers(existing);
    }

    const nodes = packHierarchyNodes(runtime.hierarchyNodes);
    const groups = packGroups(runtime.groups);
    const clusters = packClusters(runtime.clusters);
    const refs = packGroupPageRefs(runtime.groupPageRefs);
    const pageState = buildPageStateData(runtime.gpu.pages, runtime.pageRecords, runtime.generation);

    const nodeWordOffset = 0;
    const groupWordOffset = nodeWordOffset + nodes.length;
    const clusterWordOffset = groupWordOffset + groups.length;
    const pageRefWordOffset = clusterWordOffset + clusters.length;
    const meta = new Uint32Array(pageRefWordOffset + refs.length);
    meta.set(nodes, nodeWordOffset);
    meta.set(groups, groupWordOffset);
    meta.set(clusters, clusterWordOffset);
    meta.set(refs, pageRefWordOffset);

    const metaBuffer = checkedStorageBuffer(engine, meta.byteLength, "mesh-lod-meta");
    const pageStateBuffer = checkedStorageBuffer(engine, pageState.byteLength, "mesh-lod-page-state");

    const q = engine._device.queue;
    q.writeBuffer(metaBuffer, 0, meta.buffer, meta.byteOffset, meta.byteLength);
    q.writeBuffer(pageStateBuffer, 0, pageState.buffer, pageState.byteOffset, pageState.byteLength);

    const buffers: MeshLoDGpuAssetBuffers = {
        device: engine._device,
        metaBuffer,
        pageStateBuffer,
        pageStateData: pageState,
        nodeWordOffset,
        groupWordOffset,
        clusterWordOffset,
        pageRefWordOffset,
        nodeCount: runtime.hierarchyNodes.length,
        groupCount: runtime.groups.length,
        clusterCount: runtime.clusters.length,
        pageCount: runtime.gpu.pages.length,
        residencyEpoch: residencySignature(runtime),
        byteLength: meta.byteLength + pageState.byteLength,
    };
    runtime.gpuSelection = buffers;
    return buffers;
}

/** Re-derive and re-upload the mutable page-state buffer from current residency.
 *  A monotonically bumped `residencyEpoch` skips the upload when nothing changed. */
export function syncMeshLoDPageState(engine: EngineContext, buffers: MeshLoDGpuAssetBuffers, runtime: MeshLoDAssetRuntime, force = false): void {
    const signature = residencySignature(runtime);
    if (!force && buffers.residencyEpoch === signature) {
        return;
    }
    const data = buffers.pageStateData;
    for (let i = 0; i < runtime.gpu.pages.length; i++) {
        writePageStateRecord(data, i * PAGE_STATE_WORDS, runtime.gpu.pages[i]!, runtime.pageRecords[i]!, runtime.generation);
    }
    engine._device.queue.writeBuffer(buffers.pageStateBuffer, 0, data.buffer, data.byteOffset, data.byteLength);
    buffers.residencyEpoch = signature;
}

/** Destroy all buffers owned by a per-asset record. Idempotent-safe. */
export function disposeMeshLoDGpuAssetBuffers(buffers: MeshLoDGpuAssetBuffers): void {
    buffers.metaBuffer.destroy();
    buffers.pageStateBuffer.destroy();
}

// ─── Per-batch instance + prior-hysteresis state ─────────────────────

/** Per-batch instance transform buffer and per-instance/group prior-hysteresis
 *  bitset. Both grow make-before-break as the batch's instance count rises. */
export interface MeshLoDGpuInstanceState {
    readonly groupCount: number;
    /** `u32` words of prior-state bitset per instance (`ceil(groupCount / 32)`). */
    readonly wordsPerInstance: number;
    capacity: number;
    instanceCount: number;
    device: GPUDevice | null;
    instanceBuffer: GPUBuffer | null;
    priorStateBuffer: GPUBuffer | null;
    /** CPU scratch for packing instance records (`capacity * INSTANCE_WORDS`). */
    scratchF32: Float32Array;
    scratchU32: Uint32Array;
    /** Last-uploaded `worldMatrixVersion` per slot (`-1` = dirty). */
    slotVersion: Int32Array;
    /** Last-uploaded stable instance ID per slot (`-1` = empty). */
    slotId: Int32Array;
    /** Last-uploaded visibility per slot. */
    slotVisible: Uint8Array;
}

/** Create empty per-batch instance state for a hierarchy with `groupCount` groups. */
export function createMeshLoDGpuInstanceState(groupCount: number): MeshLoDGpuInstanceState {
    return {
        groupCount,
        wordsPerInstance: Math.max(Math.ceil(groupCount / 32), 1),
        capacity: 0,
        instanceCount: 0,
        device: null,
        instanceBuffer: null,
        priorStateBuffer: null,
        scratchF32: new Float32Array(0),
        scratchU32: new Uint32Array(0),
        slotVersion: new Int32Array(0),
        slotId: new Int32Array(0),
        slotVisible: new Uint8Array(0),
    };
}

/** Grow (never shrink) the instance and prior-state buffers to hold `count` slots,
 *  following make-before-break: allocate the replacements, copy the retained
 *  prior-state bits, switch the state to the new buffers, and retire the old ones
 *  after the next frame drains. All slot version tracking resets so the next upload
 *  fully repopulates the new instance buffer. */
export function ensureMeshLoDInstanceCapacity(engine: EngineContext, state: MeshLoDGpuInstanceState, count: number): void {
    const device = engine._device;
    if (state.device !== device) {
        // Device change: drop stale handles; caches auto-invalidate.
        state.instanceBuffer = null;
        state.priorStateBuffer = null;
        state.capacity = 0;
        state.device = device;
    }
    if (count <= state.capacity && state.instanceBuffer && state.priorStateBuffer) {
        return;
    }

    let capacity = Math.max(state.capacity, 1);
    while (capacity < count) {
        capacity *= 2;
    }

    const oldInstance = state.instanceBuffer;
    const oldPrior = state.priorStateBuffer;
    const oldCapacity = state.capacity;

    const newInstance = device.createBuffer({ label: "mesh-lod-instances", size: capacity * INSTANCE_BYTES, usage: BU.STORAGE | BU.COPY_DST });
    const priorBytes = capacity * state.wordsPerInstance * 4;
    const newPrior = device.createBuffer({ label: "mesh-lod-prior-state", size: Math.max(priorBytes, 4), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });

    // Preserve resident hysteresis bits for the slots that already existed.
    if (oldPrior && oldCapacity > 0) {
        engine._currentEncoder.copyBufferToBuffer(oldPrior, 0, newPrior, 0, oldCapacity * state.wordsPerInstance * 4);
    }

    state.instanceBuffer = newInstance;
    state.priorStateBuffer = newPrior;
    state.capacity = capacity;
    state.scratchF32 = new Float32Array(capacity * INSTANCE_WORDS);
    state.scratchU32 = new Uint32Array(state.scratchF32.buffer);
    state.slotVersion = new Int32Array(capacity).fill(-1);
    state.slotId = new Int32Array(capacity).fill(-1);
    state.slotVisible = new Uint8Array(capacity);

    if (oldInstance || oldPrior) {
        retireGpuResources(engine, () => {
            oldInstance?.destroy();
            oldPrior?.destroy();
        });
    }
}

/** Version-gate and upload changed instance records. Each instance occupies a stable
 *  slot equal to its index; a slot is re-packed only when its transform version,
 *  stable ID, or visibility changed since the last upload. Contiguous dirty slots are
 *  coalesced into one `writeBuffer`. Returns the active instance count. */
export function uploadMeshLoDInstances(engine: EngineContext, state: MeshLoDGpuInstanceState, instances: readonly MeshLoDGpuInstanceInput[]): number {
    ensureMeshLoDInstanceCapacity(engine, state, Math.max(instances.length, 1));
    const f32 = state.scratchF32;
    const u32 = state.scratchU32;
    let runStart = -1;
    const flush = (endExclusive: number): void => {
        if (runStart < 0) {
            return;
        }
        engine._device.queue.writeBuffer(
            state.instanceBuffer!,
            runStart * INSTANCE_BYTES,
            f32.buffer,
            f32.byteOffset + runStart * INSTANCE_BYTES,
            (endExclusive - runStart) * INSTANCE_BYTES
        );
        runStart = -1;
    };
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i]!;
        const visible = inst.visible ? 1 : 0;
        const dirty = state.slotVersion[i] !== inst.worldMatrixVersion || state.slotId[i] !== inst._instanceId || state.slotVisible[i] !== visible;
        if (dirty) {
            packInstanceRecord(f32, u32, i * INSTANCE_WORDS, inst.worldMatrix, inst.visible, inst._instanceId);
            state.slotVersion[i] = inst.worldMatrixVersion;
            state.slotId[i] = inst._instanceId;
            state.slotVisible[i] = visible;
            if (runStart < 0) {
                runStart = i;
            }
        } else {
            flush(i);
        }
    }
    flush(instances.length);
    state.instanceCount = instances.length;
    return instances.length;
}

/** Destroy the per-batch instance/prior-state buffers. Idempotent-safe. */
export function disposeMeshLoDGpuInstanceState(state: MeshLoDGpuInstanceState): void {
    state.instanceBuffer?.destroy();
    state.priorStateBuffer?.destroy();
    state.instanceBuffer = null;
    state.priorStateBuffer = null;
    state.capacity = 0;
    state.instanceCount = 0;
}

// ─── Compute orchestration: pipelines, params, transient buffers, batch ──

/** Params UBO byte size (13 × vec4, architecture §12; allocated at 256 for margin). */
const PARAMS_BYTES = 208;
const PARAMS_ALLOC = 256;
/** control[0..2] = indirect (count, 1, 1); control[3] = draw-vertex count (Task 5.3). */
const CONTROL_DIAG_OFFSET = 4;
/** diag words: visibleGroupCount, renderedTriangleCount, overflow, fallbackGroupCount. */
const CONTROL_DIAG_WORDS = 4;
/** First control word of the per-page demand region (one benefit accumulator per page). */
export const CONTROL_PAGE_DEMAND_OFFSET = CONTROL_DIAG_OFFSET + CONTROL_DIAG_WORDS;
const SELECTION_WORKGROUP = 64;

/** Diagnostics word indices within the control buffer (relative to its base). */
export const CONTROL_COUNT_WORD = 0;
export const CONTROL_DRAW_VERTEX_WORD = 3;
export const CONTROL_VISIBLE_GROUP_WORD = CONTROL_DIAG_OFFSET;
export const CONTROL_TRIANGLE_WORD = CONTROL_DIAG_OFFSET + 1;
export const CONTROL_OVERFLOW_WORD = CONTROL_DIAG_OFFSET + 2;
export const CONTROL_FALLBACK_WORD = CONTROL_DIAG_OFFSET + 3;

/** Fixed-point scale the `computeDemand` kernel accumulates per-page benefit with
 *  (`FIXED_SCALE` in mesh-lod-selection.wgsl). Readback divides it back out. */
const DEMAND_FIXED_SCALE = 256;

/** Decoded GPU selection readback: streaming page demand plus the per-frame diagnostics
 *  the control buffer accumulates (architecture §12.3 step 8). */
export interface MeshLoDGpuReadback {
    /** Missing demanded pages, sorted by descending priority then ascending id. */
    readonly demand: MeshLoDPageDemand[];
    readonly selectedClusterCount: number;
    readonly renderedTriangleCount: number;
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly overflow: boolean;
}

/** Decode a copied selection control buffer into streaming demand + diagnostics. Each
 *  per-page word holds accumulated benefit (pageShare × {@link DEMAND_FIXED_SCALE});
 *  dividing by the page's stored bytes reproduces the CPU oracle's benefit/cost priority
 *  (§11.1). Pure over the control words + a stored-bytes accessor so Node fixtures can
 *  compare it against the deterministic selection model. */
export function decodeMeshLoDGpuReadback(control: ArrayLike<number>, pageCount: number, storedBytesOf: (pageId: number) => number): MeshLoDGpuReadback {
    const demand: MeshLoDPageDemand[] = [];
    for (let pageId = 0; pageId < pageCount; pageId++) {
        const benefit = control[CONTROL_PAGE_DEMAND_OFFSET + pageId] ?? 0;
        if (benefit > 0) {
            const stored = storedBytesOf(pageId) || 1;
            demand.push({ pageId, priority: benefit / DEMAND_FIXED_SCALE / stored });
        }
    }
    demand.sort((a, b) => (b.priority !== a.priority ? b.priority - a.priority : a.pageId - b.pageId));
    return {
        demand,
        selectedClusterCount: control[CONTROL_COUNT_WORD] ?? 0,
        renderedTriangleCount: control[CONTROL_TRIANGLE_WORD] ?? 0,
        visibleGroupCount: control[CONTROL_VISIBLE_GROUP_WORD] ?? 0,
        fallbackGroupCount: control[CONTROL_FALLBACK_WORD] ?? 0,
        overflow: (control[CONTROL_OVERFLOW_WORD] ?? 0) !== 0,
    };
}

interface MeshLoDSelectionPipelines {
    readonly device: GPUDevice;
    readonly layout: GPUBindGroupLayout;
    readonly pipelineLayout: GPUPipelineLayout;
    readonly traverse: GPUComputePipeline;
    readonly evaluate: GPUComputePipeline;
    readonly select: GPUComputePipeline;
    readonly demand: GPUComputePipeline;
    readonly clamp: GPUComputePipeline;
    readonly expandLayout: GPUBindGroupLayout;
    readonly expand: GPUComputePipeline;
    readonly finalize: GPUComputePipeline;
    readonly module: GPUShaderModule;
}

let _pipelines: MeshLoDSelectionPipelines | null = null;

/** Build (once per device) the selection + expansion compute pipelines. The five
 *  selection-pass kernels share one explicit bind-group layout (bindings 0-7);
 *  expansion uses its own layout (bindings 0,1,2,6,8,9,10 — no `control`, the indirect-
 *  dispatch source) so each stage stays within the 8-storage-buffer limit and no buffer
 *  is both writable storage and indirect in one synchronization scope. */
export function getMeshLoDSelectionPipelines(engine: EngineContext): MeshLoDSelectionPipelines {
    if (_pipelines && _pipelines.device === engine._device) {
        return _pipelines;
    }
    const device = engine._device;
    const C = 0x4; // GPUShaderStage.COMPUTE
    const buf = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: C, buffer: { type } });
    const layout = device.createBindGroupLayout({
        label: "mesh-lod-selection",
        entries: [
            buf(0, "uniform"),
            buf(1, "read-only-storage"),
            buf(2, "read-only-storage"),
            buf(3, "read-only-storage"),
            buf(4, "storage"),
            buf(5, "storage"),
            buf(6, "storage"),
            buf(7, "storage"),
        ],
    });
    const expandLayout = device.createBindGroupLayout({
        label: "mesh-lod-expand",
        entries: [
            buf(0, "uniform"),
            buf(1, "read-only-storage"),
            buf(2, "read-only-storage"),
            buf(6, "storage"),
            buf(8, "read-only-storage"),
            buf(9, "storage"),
            buf(10, "storage"),
        ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const expandPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [expandLayout] });
    const module = device.createShaderModule({ label: "mesh-lod-selection", code: selectionWgsl });
    const pipe = (pl: GPUPipelineLayout, entryPoint: string): GPUComputePipeline =>
        device.createComputePipeline({ label: `mesh-lod-${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    _pipelines = {
        device,
        layout,
        pipelineLayout,
        module,
        traverse: pipe(pipelineLayout, "traverse"),
        evaluate: pipe(pipelineLayout, "evaluateGroups"),
        select: pipe(pipelineLayout, "selectClusters"),
        demand: pipe(pipelineLayout, "computeDemand"),
        clamp: pipe(pipelineLayout, "clampSelectedCount"),
        expandLayout,
        expand: pipe(expandPipelineLayout, "expandClusters"),
        finalize: pipe(expandPipelineLayout, "finalizeDraw"),
    };
    return _pipelines;
}

/** Per-batch transient GPU selection state: group-state/selected/control buffers,
 *  the params UBO, and the cached bind group. Grows make-before-break with the
 *  batch's instance capacity. */
export interface MeshLoDGpuBatchState {
    device: GPUDevice | null;
    groupStateBuffer: GPUBuffer | null;
    selectedBuffer: GPUBuffer | null;
    controlBuffer: GPUBuffer | null;
    paramsBuffer: GPUBuffer | null;
    bindGroup: GPUBindGroup | null;
    instanceCapacity: number;
    selectedCapacity: number;
    controlWords: number;
    groupCount: number;
    clusterCount: number;
    nodeCount: number;
    pageCount: number;
    paramsBytes: ArrayBuffer;
    paramsF32: Float32Array;
    paramsU32: Uint32Array;
    boundMeta: GPUBuffer | null;
    boundPageState: GPUBuffer | null;
    boundInstances: GPUBuffer | null;
    boundPrior: GPUBuffer | null;
    // ── Task 5.3 expansion + indirect draw ──
    drawVertexBuffer: GPUBuffer | null;
    drawArgsBuffer: GPUBuffer | null;
    expandBindGroup: GPUBindGroup | null;
    drawVertexCapacity: number;
    /** Per-instance draw-vertex bound (coarse expanded vertices) the buffer is sized from. */
    drawVertexBound: number;
    boundArena: GPUBuffer | null;
    // ── Task 7 (GPU streaming) async demand readback + adaptive draw growth ──
    /** Small ring of MAP_READ staging buffers the control buffer is copied into each
     *  frame; each entry maps independently so the CPU→GPU→CPU demand loop never stalls. */
    readbackSlots: MeshLoDReadbackSlot[];
    /** Per-instance draw-vertex bound ratcheted up by the async readback as streamed
     *  refinement selects more triangles, so GPU mode renders past the coarse bound. */
    growthDrawVertexBound: number;
}

/** Create empty per-batch transient selection state. */
export function createMeshLoDGpuBatchState(): MeshLoDGpuBatchState {
    const paramsBytes = new ArrayBuffer(PARAMS_ALLOC);
    return {
        device: null,
        groupStateBuffer: null,
        selectedBuffer: null,
        controlBuffer: null,
        paramsBuffer: null,
        bindGroup: null,
        instanceCapacity: 0,
        selectedCapacity: 0,
        controlWords: 0,
        groupCount: 0,
        clusterCount: 0,
        nodeCount: 0,
        pageCount: 0,
        paramsBytes,
        paramsF32: new Float32Array(paramsBytes),
        paramsU32: new Uint32Array(paramsBytes),
        boundMeta: null,
        boundPageState: null,
        boundInstances: null,
        boundPrior: null,
        drawVertexBuffer: null,
        drawArgsBuffer: null,
        expandBindGroup: null,
        drawVertexCapacity: 0,
        drawVertexBound: 0,
        boundArena: null,
        readbackSlots: [],
        growthDrawVertexBound: 0,
    };
}

/** Size the transient buffers for `instanceCapacity` instances of the asset. The
 *  group-state and selected-list scale with instance capacity; growth retires the old
 *  buffers after the next frame drains and invalidates the bind group. */
function ensureMeshLoDBatchBuffers(
    engine: EngineContext,
    state: MeshLoDGpuBatchState,
    instanceCapacity: number,
    drawVertexBound: number,
    assetBuffers: MeshLoDGpuAssetBuffers
): void {
    const device = engine._device;
    if (state.device !== device) {
        state.groupStateBuffer = state.selectedBuffer = state.controlBuffer = state.paramsBuffer = null;
        state.drawVertexBuffer = state.drawArgsBuffer = null;
        state.bindGroup = state.expandBindGroup = null;
        state.instanceCapacity = 0;
        state.drawVertexCapacity = 0;
        for (const slot of state.readbackSlots) {
            slot.buffer.destroy();
        }
        state.readbackSlots = [];
        state.growthDrawVertexBound = 0;
        state.device = device;
    }
    state.groupCount = assetBuffers.groupCount;
    state.clusterCount = assetBuffers.clusterCount;
    state.nodeCount = assetBuffers.nodeCount;
    state.pageCount = assetBuffers.pageCount;
    state.drawVertexBound = drawVertexBound;
    const controlWords = CONTROL_PAGE_DEMAND_OFFSET + Math.max(assetBuffers.pageCount, 1);
    if (!state.controlBuffer) {
        state.controlBuffer = device.createBuffer({ label: "mesh-lod-control", size: controlWords * 4, usage: BU.STORAGE | BU.INDIRECT | BU.COPY_DST | BU.COPY_SRC });
        state.controlWords = controlWords;
        // Fixed indirect Y/Z = 1 (count in word 0 is filled by the atomic each frame).
        device.queue.writeBuffer(state.controlBuffer, 4, Uint32Array.from([1, 1]).buffer);
        state.bindGroup = null;
    }
    if (!state.drawArgsBuffer) {
        // 5 words: vertexCount, instanceCount, firstVertex, firstInstance, expansion-overflow.
        state.drawArgsBuffer = device.createBuffer({ label: "mesh-lod-draw-args", size: 20, usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST });
        device.queue.writeBuffer(state.drawArgsBuffer, 8, Uint32Array.from([0, 0, 0]).buffer); // firstVertex/firstInstance/overflow = 0
        state.expandBindGroup = null;
    }
    if (!state.paramsBuffer) {
        state.paramsBuffer = device.createBuffer({ label: "mesh-lod-params", size: PARAMS_ALLOC, usage: BU.UNIFORM | BU.COPY_DST });
        state.bindGroup = state.expandBindGroup = null;
    }
    const drawVertexCapacity = Math.max(drawVertexBound * Math.max(instanceCapacity, 1), 3);
    const growInstances = instanceCapacity > state.instanceCapacity || !state.groupStateBuffer || !state.selectedBuffer;
    const growDraw = drawVertexCapacity > state.drawVertexCapacity || !state.drawVertexBuffer;
    if (!growInstances && !growDraw) {
        return;
    }
    let capacity = Math.max(state.instanceCapacity, 1);
    while (capacity < instanceCapacity) {
        capacity *= 2;
    }
    const oldGroupState = state.groupStateBuffer;
    const oldSelected = state.selectedBuffer;
    const oldDrawVertex = state.drawVertexBuffer;
    if (growInstances) {
        const selectedCapacity = Math.max(assetBuffers.clusterCount * capacity, 1);
        state.groupStateBuffer = device.createBuffer({ label: "mesh-lod-group-state", size: Math.max(capacity * assetBuffers.groupCount, 1) * 4, usage: BU.STORAGE | BU.COPY_DST });
        state.selectedBuffer = device.createBuffer({ label: "mesh-lod-selected", size: selectedCapacity * 2 * 4, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC });
        state.instanceCapacity = capacity;
        state.selectedCapacity = selectedCapacity;
        state.bindGroup = null;
        state.expandBindGroup = null;
    }
    if (growDraw) {
        state.drawVertexBuffer = device.createBuffer({ label: "mesh-lod-draw-vertices", size: drawVertexCapacity * 16, usage: BU.STORAGE | BU.COPY_DST });
        state.drawVertexCapacity = drawVertexCapacity;
        state.expandBindGroup = null;
    }
    if (oldGroupState || oldSelected || oldDrawVertex) {
        retireGpuResources(engine, () => {
            if (growInstances) {
                oldGroupState?.destroy();
                oldSelected?.destroy();
            }
            if (growDraw) {
                oldDrawVertex?.destroy();
            }
        });
    }
}

function ensureMeshLoDBindGroup(
    engine: EngineContext,
    state: MeshLoDGpuBatchState,
    pipelines: MeshLoDSelectionPipelines,
    assetBuffers: MeshLoDGpuAssetBuffers,
    instanceState: MeshLoDGpuInstanceState,
    arena: GPUBuffer
): void {
    const instances = instanceState.instanceBuffer!;
    const prior = instanceState.priorStateBuffer!;
    if (
        state.bindGroup &&
        state.expandBindGroup &&
        state.boundMeta === assetBuffers.metaBuffer &&
        state.boundPageState === assetBuffers.pageStateBuffer &&
        state.boundInstances === instances &&
        state.boundPrior === prior &&
        state.boundArena === arena
    ) {
        return;
    }
    state.bindGroup = engine._device.createBindGroup({
        label: "mesh-lod-selection",
        layout: pipelines.layout,
        entries: [
            { binding: 0, resource: { buffer: state.paramsBuffer! } },
            { binding: 1, resource: { buffer: assetBuffers.metaBuffer } },
            { binding: 2, resource: { buffer: assetBuffers.pageStateBuffer } },
            { binding: 3, resource: { buffer: instances } },
            { binding: 4, resource: { buffer: prior } },
            { binding: 5, resource: { buffer: state.groupStateBuffer! } },
            { binding: 6, resource: { buffer: state.selectedBuffer! } },
            { binding: 7, resource: { buffer: state.controlBuffer! } },
        ],
    });
    state.expandBindGroup = engine._device.createBindGroup({
        label: "mesh-lod-expand",
        layout: pipelines.expandLayout,
        entries: [
            { binding: 0, resource: { buffer: state.paramsBuffer! } },
            { binding: 1, resource: { buffer: assetBuffers.metaBuffer } },
            { binding: 2, resource: { buffer: assetBuffers.pageStateBuffer } },
            { binding: 6, resource: { buffer: state.selectedBuffer! } },
            { binding: 8, resource: { buffer: arena } },
            { binding: 9, resource: { buffer: state.drawVertexBuffer! } },
            { binding: 10, resource: { buffer: state.drawArgsBuffer! } },
        ],
    });
    state.boundMeta = assetBuffers.metaBuffer;
    state.boundPageState = assetBuffers.pageStateBuffer;
    state.boundInstances = instances;
    state.boundPrior = prior;
    state.boundArena = arena;
}

/** Destroy the per-batch transient selection buffers. Idempotent-safe. */
export function disposeMeshLoDGpuBatchState(state: MeshLoDGpuBatchState): void {
    state.groupStateBuffer?.destroy();
    state.selectedBuffer?.destroy();
    state.controlBuffer?.destroy();
    state.paramsBuffer?.destroy();
    state.drawVertexBuffer?.destroy();
    state.drawArgsBuffer?.destroy();
    for (const slot of state.readbackSlots) {
        slot.buffer.destroy();
    }
    state.readbackSlots = [];
    state.growthDrawVertexBound = 0;
    state.groupStateBuffer = state.selectedBuffer = state.controlBuffer = state.paramsBuffer = null;
    state.drawVertexBuffer = state.drawArgsBuffer = null;
    state.bindGroup = state.expandBindGroup = null;
    state.instanceCapacity = 0;
    state.drawVertexCapacity = 0;
}

// ─── Async demand readback + adaptive draw growth (architecture §12.3 step 8) ──

const READBACK_RING = 3;

interface MeshLoDReadbackSlot {
    readonly buffer: GPUBuffer;
    busy: boolean;
}

/** One queued control-buffer readback: the copy source, its MAP_READ staging slot, and
 *  the decode/apply closure run once the frame submits. */
interface MeshLoDReadbackJob {
    readonly control: GPUBuffer;
    readonly slot: MeshLoDReadbackSlot;
    readonly bytes: number;
    readonly apply: (control: Uint32Array) => void;
}

/** Reserve a free MAP_READ staging slot from the batch's small ring (growing it up to
 *  {@link READBACK_RING}); returns `null` when every slot still has a map in flight, so
 *  the frame skips the readback rather than stall. */
function acquireMeshLoDReadbackSlot(engine: EngineContext, state: MeshLoDGpuBatchState, bytes: number): MeshLoDReadbackSlot | null {
    for (const slot of state.readbackSlots) {
        if (!slot.busy) {
            slot.busy = true;
            return slot;
        }
    }
    if (state.readbackSlots.length >= READBACK_RING) {
        return null;
    }
    const buffer = engine._device.createBuffer({ label: "mesh-lod-readback", size: bytes, usage: BU.MAP_READ | BU.COPY_DST });
    const slot: MeshLoDReadbackSlot = { buffer, busy: true };
    state.readbackSlots.push(slot);
    return slot;
}

/** Map the staging copy after the frame submits, decode it, and release the slot. The
 *  `await Promise.resolve()` lets the frame's encoder submit first (a buffer with a
 *  pending map cannot be used by an in-flight submit — see engine/screenshot-readback.ts). */
async function pumpMeshLoDReadback(job: MeshLoDReadbackJob): Promise<void> {
    const { slot } = job;
    try {
        await Promise.resolve();
        await slot.buffer.mapAsync(GPUMapMode.READ, 0, job.bytes);
        const control = new Uint32Array(slot.buffer.getMappedRange(0, job.bytes).slice(0));
        slot.buffer.unmap();
        job.apply(control);
    } catch {
        // Device lost / disposed / destroyed staging — drop this frame's readback.
    } finally {
        slot.busy = false;
    }
}

/** Ratchet the draw-vertex growth bound up so `neededVertices` (the GPU-reported selected
 *  triangle count × 3, across all instances) fits next frame. Doubles for amortized growth
 *  and never shrinks, mirroring the CPU path's make-before-break growth. */
function growMeshLoDDrawBound(state: MeshLoDGpuBatchState, neededVertices: number): void {
    if (neededVertices <= state.drawVertexCapacity) {
        return;
    }
    const cap = Math.max(state.instanceCapacity, 1);
    const target = Math.ceil(neededVertices / cap);
    let bound = Math.max(state.growthDrawVertexBound, state.drawVertexBound, 1);
    while (bound < target) {
        bound *= 2;
    }
    if (bound > state.growthDrawVertexBound) {
        state.growthDrawVertexBound = bound;
    }
}

/** Apply one frame's async GPU selection readback: decode per-page demand + diagnostics
 *  from the control buffer, drive the shared streaming engine (demand + resident frame
 *  references + diagnostics), and ratchet the draw-vertex growth bound so streamed
 *  refinement renders past the coarse bound. A stale readback (disposed asset, or a
 *  generation bump from disposal/device recovery) is dropped. Exported as the internal
 *  test seam that stands in for the real mapAsync resolution. */
export function applyMeshLoDGpuReadback(runtime: MeshLoDAssetRuntime, state: MeshLoDGpuBatchState, control: Uint32Array, pageCount: number, generation: number): void {
    if (runtime.disposed || runtime.generation !== generation) {
        return;
    }
    const records = runtime.pageRecords;
    const decoded = decodeMeshLoDGpuReadback(control, pageCount, (pageId) => records[pageId]?.storedBytes ?? 1);
    // Frame references: every currently gpu-resident page (pinned + streamed fine) may
    // be read by the in-flight command buffer, so hold it and keep its LRU age fresh.
    const referenced: number[] = [];
    const pages = runtime.gpu.pages;
    for (let i = 0; i < pages.length; i++) {
        if (pages[i]!.state === "gpu-resident") {
            referenced.push(i);
        }
    }
    const diag = runtime.diagnostics as { renderedTriangleCount: number; selectedMeshletCount: number };
    diag.renderedTriangleCount = decoded.renderedTriangleCount;
    diag.selectedMeshletCount = decoded.selectedClusterCount;
    const stats: MeshLoDStreamSelectionStats = {
        visibleGroupCount: decoded.visibleGroupCount,
        fallbackGroupCount: decoded.fallbackGroupCount,
        maximumSelectedErrorPixels: 0,
        maximumUnmetErrorPixels: 0,
    };
    stepMeshLoDStreaming(runtime, decoded.demand, referenced, stats);
    growMeshLoDDrawBound(state, decoded.renderedTriangleCount * 3);
}

/** Camera + selection inputs for one frame's GPU selection, produced by the scene from
 *  the active pass camera. */
export interface MeshLoDGpuFrameParams {
    readonly cameraPos: readonly [number, number, number];
    readonly verticalFov: number;
    readonly near: number;
    readonly targetWidth: number;
    readonly targetHeight: number;
    readonly orthographicHeight?: number;
    /** Column-major view-projection for frustum-plane extraction. */
    readonly viewProjection: ArrayLike<number>;
    /** Enable frustum culling (GPU render path); `false` disables it (planeCount = 0). */
    readonly frustumCull: boolean;
    /** Disable for double-sided materials. */
    readonly coneCull?: boolean;
    readonly screenSpaceError: number;
    readonly lodHysteresis: number;
    readonly levelCount: number;
}

function writeSelectionParams(
    state: MeshLoDGpuBatchState,
    assetBuffers: MeshLoDGpuAssetBuffers,
    instanceCount: number,
    wordsPerInstance: number,
    frame: MeshLoDGpuFrameParams
): void {
    const f = state.paramsF32;
    const u = state.paramsU32;
    const planes = frame.frustumCull ? extractFrustumPlanes(frame.viewProjection) : [];
    for (let i = 0; i < 6; i++) {
        const p = planes[i] ?? [0, 0, 0, 1];
        f[i * 4] = p[0];
        f[i * 4 + 1] = p[1];
        f[i * 4 + 2] = p[2];
        f[i * 4 + 3] = p[3];
    }
    f[24] = frame.cameraPos[0];
    f[25] = frame.cameraPos[1];
    f[26] = frame.cameraPos[2];
    f[27] = frame.near;
    f[28] = frame.targetWidth;
    f[29] = frame.targetHeight;
    f[30] = perspectivePixelScale(frame.targetHeight, frame.verticalFov);
    f[31] = frame.orthographicHeight ?? 0;
    f[32] = frame.screenSpaceError;
    f[33] = Math.fround(frame.screenSpaceError * Math.fround(1 + frame.lodHysteresis));
    f[34] = Math.fround(frame.screenSpaceError * Math.fround(1 - frame.lodHysteresis));
    f[35] = planes.length;
    u[36] = instanceCount;
    u[37] = assetBuffers.groupCount;
    u[38] = assetBuffers.clusterCount;
    u[39] = assetBuffers.nodeCount;
    u[40] = wordsPerInstance;
    u[41] = state.selectedCapacity;
    u[42] = assetBuffers.pageCount;
    u[43] = frame.levelCount;
    u[44] = assetBuffers.nodeWordOffset;
    u[45] = assetBuffers.groupWordOffset;
    u[46] = assetBuffers.clusterWordOffset;
    u[47] = assetBuffers.pageRefWordOffset;
    u[48] = CONTROL_DIAG_OFFSET;
    u[49] = CONTROL_PAGE_DEMAND_OFFSET;
    u[50] = state.drawVertexCapacity; // params.control.z — expansion draw-vertex capacity
    u[51] = frame.coneCull !== false ? 1 : 0;
}

/** One selection step to replay in the shared compute pass. */
interface MeshLoDComputeStep {
    readonly pipeline: GPUComputePipeline;
    readonly bindGroup: GPUBindGroup;
    readonly workgroups?: number;
    readonly indirectBuffer?: GPUBuffer;
    readonly indirectOffset?: number;
}

interface MeshLoDBufferClear {
    readonly buffer: GPUBuffer;
    readonly offset: number;
    readonly size: number;
}

interface MeshLoDSelectionJob {
    readonly clears: MeshLoDBufferClear[];
    /** Selection pass (traverse→evaluate→select→demand→clamp). */
    readonly pass1Steps: MeshLoDComputeStep[];
    /** Expansion pass (expandClusters indirect → finalizeDraw). Separated from pass 1
     *  so `control` is never writable storage and indirect in one synchronization scope. */
    readonly pass2Steps: MeshLoDComputeStep[];
    /** Async page-demand + diagnostics readback of the control buffer, copied after the
     *  compute passes and mapped once the frame submits (architecture §12.3 step 8). */
    readonly readback?: MeshLoDReadbackJob;
}

function replaySteps(pass: GPUComputePassEncoder, steps: readonly MeshLoDComputeStep[]): void {
    let lastPipeline: GPUComputePipeline | null = null;
    for (const step of steps) {
        if (step.pipeline !== lastPipeline) {
            pass.setPipeline(step.pipeline);
            lastPipeline = step.pipeline;
        }
        pass.setBindGroup(0, step.bindGroup);
        if (step.indirectBuffer) {
            pass.dispatchWorkgroupsIndirect(step.indirectBuffer, step.indirectOffset ?? 0);
        } else {
            pass.dispatchWorkgroups(step.workgroups ?? 0);
        }
    }
}

/** @internal Feature-owned update batch: collects every MeshLoD batch's selection and
 *  expansion work and submits it as two compute passes (selection, then indirect
 *  expansion) flushed before the render pass (architecture §12.3). One per render-target
 *  signature. */
export interface MeshLoDUpdateBatch extends DrawUpdateBatch {
    queue(job: MeshLoDSelectionJob): void;
}

let _updateBatches: WeakMap<RenderTargetSignature, MeshLoDUpdateBatch> | null = null;

/** Return the task-local MeshLoD update batch for one render-target signature. */
export function getMeshLoDUpdateBatch(signature: RenderTargetSignature): MeshLoDUpdateBatch {
    _updateBatches ??= new WeakMap();
    const existing = _updateBatches.get(signature);
    if (existing) {
        return existing;
    }
    const jobs: MeshLoDSelectionJob[] = [];
    let count = 0;
    const batch: MeshLoDUpdateBatch = {
        reset(): void {
            count = 0;
        },
        flush(engine): void {
            if (count === 0) {
                return;
            }
            const encoder = engine._currentEncoder;
            for (let i = 0; i < count; i++) {
                for (const clear of jobs[i]!.clears) {
                    encoder.clearBuffer(clear.buffer, clear.offset, clear.size);
                }
            }
            // Pass 1: selection (writes control as storage). Pass 2: indirect expansion
            // (reads control as the dispatch source) — a separate synchronization scope.
            const selectionPass = encoder.beginComputePass();
            for (let i = 0; i < count; i++) {
                replaySteps(selectionPass, jobs[i]!.pass1Steps);
            }
            selectionPass.end();
            const expandPass = encoder.beginComputePass();
            for (let i = 0; i < count; i++) {
                replaySteps(expandPass, jobs[i]!.pass2Steps);
            }
            expandPass.end();
            // Copy each batch's control buffer (page demand + diagnostics) to its MAP_READ
            // staging slot AFTER the compute passes, then map it once the frame submits
            // (architecture §12.3 step 8). The async result drives GPU-mode streaming.
            for (let i = 0; i < count; i++) {
                const rb = jobs[i]!.readback;
                if (rb) {
                    encoder.copyBufferToBuffer(rb.control, 0, rb.slot.buffer, 0, rb.bytes);
                    void pumpMeshLoDReadback(rb);
                }
            }
        },
        destroy(): void {
            jobs.length = 0;
            count = 0;
            _updateBatches?.delete(signature);
        },
        queue(job): void {
            jobs[count++] = job;
        },
    };
    _updateBatches.set(signature, batch);
    return batch;
}

/** Result handed to the render binding after selection + expansion are queued: the
 *  buffers the indirect draw consumes. */
export interface MeshLoDGpuSelectionHandles {
    readonly controlBuffer: GPUBuffer;
    readonly selectedBuffer: GPUBuffer;
    readonly drawVertexBuffer: GPUBuffer;
    readonly drawArgsBuffer: GPUBuffer;
    readonly instanceBuffer: GPUBuffer;
    readonly selectedCapacity: number;
    readonly instanceCount: number;
}

/** Prepare and queue one batch's GPU selection + expansion into the shared compute
 *  pass: sync page state, version-gate instance uploads, size transient buffers, write
 *  params, reset transient counters, and append traverse→evaluate→select→demand then
 *  the indirect expandClusters + finalizeDraw. `drawVertexBound` is the per-instance
 *  expanded-vertex bound the draw-vertex buffer is sized from. Returns the buffers the
 *  indirect draw consumes, or `null` for an empty batch. */
export function queueMeshLoDGpuSelection(
    engine: EngineContext,
    updateBatch: MeshLoDUpdateBatch,
    runtime: MeshLoDAssetRuntime,
    instanceState: MeshLoDGpuInstanceState,
    batchState: MeshLoDGpuBatchState,
    instances: readonly MeshLoDGpuInstanceInput[],
    drawVertexBound: number,
    frame: MeshLoDGpuFrameParams
): MeshLoDGpuSelectionHandles | null {
    if (instances.length === 0) {
        return null;
    }
    const pipelines = getMeshLoDSelectionPipelines(engine);
    const assetBuffers = getMeshLoDGpuAssetBuffers(engine, runtime);
    const instanceCount = uploadMeshLoDInstances(engine, instanceState, instances);
    syncMeshLoDPageState(engine, assetBuffers, runtime);
    // Coarse per-instance bound, ratcheted up by the async readback as streamed refinement
    // selects more triangles, so the GPU draw stream grows past the coarse LOD.
    const effectiveDrawBound = Math.max(drawVertexBound, batchState.growthDrawVertexBound);
    ensureMeshLoDBatchBuffers(engine, batchState, instanceState.capacity, effectiveDrawBound, assetBuffers);
    ensureMeshLoDBindGroup(engine, batchState, pipelines, assetBuffers, instanceState, runtime.gpu.arena.buffer);
    writeSelectionParams(batchState, assetBuffers, instanceCount, instanceState.wordsPerInstance, frame);
    engine._device.queue.writeBuffer(batchState.paramsBuffer!, 0, batchState.paramsBytes, 0, PARAMS_BYTES);

    const bindGroup = batchState.bindGroup!;
    const expandBindGroup = batchState.expandBindGroup!;
    const groupInvocations = Math.ceil((batchState.groupCount * instanceCount) / SELECTION_WORKGROUP);
    const nodeInvocations = Math.ceil((batchState.nodeCount * instanceCount) / SELECTION_WORKGROUP);
    const clusterInvocations = Math.ceil((batchState.clusterCount * instanceCount) / SELECTION_WORKGROUP);

    // Reserve a staging slot and build the demand/diagnostics readback for this frame.
    // Skipped only when every ring slot still has a map in flight.
    const readbackBytes = batchState.controlWords * 4;
    const readbackSlot = acquireMeshLoDReadbackSlot(engine, batchState, readbackBytes);
    const generation = runtime.generation;
    const pageCount = assetBuffers.pageCount;
    const readback: MeshLoDReadbackJob | undefined = readbackSlot
        ? {
              control: batchState.controlBuffer!,
              slot: readbackSlot,
              bytes: readbackBytes,
              apply: (control) => applyMeshLoDGpuReadback(runtime, batchState, control, pageCount, generation),
          }
        : undefined;

    const job: MeshLoDSelectionJob = {
        clears: [
            { buffer: batchState.controlBuffer!, offset: CONTROL_COUNT_WORD * 4, size: 4 },
            { buffer: batchState.controlBuffer!, offset: CONTROL_DIAG_OFFSET * 4, size: (CONTROL_DIAG_WORDS + Math.max(batchState.pageCount, 1)) * 4 },
            { buffer: batchState.groupStateBuffer!, offset: 0, size: Math.max(batchState.groupCount * instanceCount, 1) * 4 },
            { buffer: batchState.drawArgsBuffer!, offset: 0, size: 4 }, // vertexCount = 0
            { buffer: batchState.drawArgsBuffer!, offset: 16, size: 4 }, // expansion overflow = 0
        ],
        pass1Steps: [
            { pipeline: pipelines.traverse, bindGroup, workgroups: nodeInvocations },
            { pipeline: pipelines.evaluate, bindGroup, workgroups: groupInvocations },
            { pipeline: pipelines.select, bindGroup, workgroups: clusterInvocations },
            { pipeline: pipelines.demand, bindGroup, workgroups: groupInvocations },
            // Clamp the selected count so the expansion pass's indirect dispatch stays within capacity.
            { pipeline: pipelines.clamp, bindGroup, workgroups: 1 },
        ],
        pass2Steps: [
            // One workgroup per selected cluster via the clamped count in control[0..2].
            { pipeline: pipelines.expand, bindGroup: expandBindGroup, indirectBuffer: batchState.controlBuffer!, indirectOffset: 0 },
            { pipeline: pipelines.finalize, bindGroup: expandBindGroup, workgroups: 1 },
        ],
        readback,
    };
    updateBatch.queue(job);

    return {
        controlBuffer: batchState.controlBuffer!,
        selectedBuffer: batchState.selectedBuffer!,
        drawVertexBuffer: batchState.drawVertexBuffer!,
        drawArgsBuffer: batchState.drawArgsBuffer!,
        instanceBuffer: instanceState.instanceBuffer!,
        selectedCapacity: batchState.selectedCapacity,
        instanceCount,
    };
}
