/** MeshLoD runtime — internal orchestration and runtime record types.
 *
 *  This module owns the mutable runtime state behind a {@link MeshLoDAsset} and the
 *  heavy orchestration entry points the public facade dynamically imports on first
 *  {@link loadMeshLoD} call. Keeping the orchestration here (never statically
 *  imported by the facade) is what lets non-MeshLoD bundles fetch zero MeshLoD
 *  runtime bytes.
 *
 *  The concrete loading/selection/streaming behavior is filled in across the
 *  Phase 3–7 tasks; this file grows with each. The type surface below is the
 *  stable internal contract those tasks target. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { MeshLoDAsset, MeshLoDDebugView, MeshLoDDiagnostics, MeshLoDInstance, MeshLoDRequestOptions, MeshLoDSelectionMode, MeshLoDSource } from "./mesh-lod.js";
import type { ParsedMeshLoDContainer } from "./mesh-lod-format.js";
import type { MeshLoDRangeSource } from "./mesh-lod-range-source.js";
import { parseMeshLoDContainer, readBootstrapExtent, toMeshLoDMetadata } from "./mesh-lod-format.js";
import { BOOTSTRAP_FIRST_END, concatBytes, createMeshLoDRangeSource, throwIfAborted } from "./mesh-lod-range-source.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDError } from "./mesh-lod-errors.js";
import type { MeshLoDArena, MeshLoDCpuPageCache, MeshLoDEvictionPolicy } from "./mesh-lod-cache.js";
import {
    allocateArenaRun,
    arenaUsedBytes,
    createMeshLoDArena,
    createMeshLoDCpuPageCache,
    clearMeshLoDCpuPageCache,
    cpuCacheUsedBytes,
    evictMeshLoDToBudget,
    floorToBlocks,
    getMeshLoDCpuPage,
    pinnedAllocationBytes,
    putMeshLoDCpuPage,
    reserveMeshLoDArenaRun,
    setMeshLoDCpuCacheBudget,
} from "./mesh-lod-cache.js";
import { decodeMeshLoDPage, getMeshLoDPageDecoder } from "./mesh-lod-page-decoder.js";
import type { DecodedMeshLoDPage } from "./mesh-lod-page-decoder.js";
import type { MeshoptDecoderModule } from "../loader-gltf/meshopt-decode.js";
import { addMeshLoDInstanceToScene, removeMeshLoDInstanceFromScene } from "./mesh-lod-scene.js";
import type { MeshLoDGpuAssetBuffers, MeshLoDGpuSelectedPair } from "./mesh-lod-selection-gpu.js";
import type { MeshLoDPageDemand, MeshLoDRequestScheduler, MeshLoDSchedulerTimers } from "./mesh-lod-scheduler.js";
import { createMeshLoDRequestScheduler, disposeMeshLoDRequestScheduler, schedulerQueuedCount, setMeshLoDSchedulerConcurrency, submitMeshLoDDemand } from "./mesh-lod-scheduler.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
/** Effective, fully-resolved runtime settings (defaults applied, values validated). */
export interface MeshLoDEffectiveSettings {
    screenSpaceError: number;
    lodHysteresis: number;
    residencyHoldFrames: number;
    obsoleteRequestGraceFrames: number;
    cacheBudgetBytes: number;
    cacheCapacityBytes: number;
    cpuPageCacheBytes: number;
    maxConcurrentRequests: number;
    retryCount: number;
    retryDelaysMs: readonly number[];
}

// ─── Parsed immutable `.mlod` records (see architecture section 8) ────

/** Parsed 256-byte container header. Offsets/sizes are absolute file bytes. */
export interface MeshLoDHeader {
    readonly formatMajor: number;
    readonly formatMinor: number;
    readonly minReaderMajor: number;
    readonly minReaderMinor: number;
    readonly containerFlags: number;
    readonly sectionCount: number;
    readonly directoryOffset: number;
    readonly directoryBytes: number;
    readonly bootstrapBytes: number;
    readonly totalFileBytes: number;
    /** Lowercase hex of the 32-byte source-bundle SHA-256. */
    readonly sourceSha256: string;
    /** Lowercase hex of the 32-byte build fingerprint. */
    readonly buildFingerprintSha256: string;
    /** Lowercase hex of the 16-byte deterministic hierarchy id. */
    readonly hierarchyId: string;
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly sourceTriangleCount: number;
    readonly hierarchyTriangleCount: number;
    readonly clusterCount: number;
    readonly groupCount: number;
    readonly hierarchyNodeCount: number;
    readonly pageCount: number;
    readonly pinnedPageCount: number;
    readonly levelCount: number;
    readonly attributeMask: number;
    readonly vertexStride: number;
    readonly boundsMin: readonly [number, number, number];
    readonly boundsMax: readonly [number, number, number];
    readonly maxNonterminalError: number;
}

/** Parsed 64-byte section-directory entry. */
export interface MeshLoDSectionEntry {
    readonly type: number;
    readonly flags: number;
    readonly required: boolean;
    readonly optional: boolean;
    readonly perItemCrc: boolean;
    readonly pageData: boolean;
    readonly offset: number;
    readonly storedBytes: number;
    readonly decodedBytes: number;
    readonly elementCount: number;
    readonly elementStride: number;
    readonly crc: number;
    readonly alignment: number;
}

/** Parsed hierarchy group (64-byte record). */
export interface MeshLoDGroup {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    /** Simplified screen-space error; non-finite (`FLT_MAX`) for terminal groups. */
    readonly simplifiedError: number;
    readonly depth: number;
    readonly firstCluster: number;
    readonly clusterCount: number;
    readonly firstPageRef: number;
    readonly pageRefCount: number;
    readonly terminal: boolean;
    readonly pinned: boolean;
    readonly sourceTriangleCount: number;
    readonly outputTriangleCount: number;
}

/** Parsed cluster/meshlet (64-byte record). */
export interface MeshLoDCluster {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    readonly error: number;
    readonly groupId: number;
    /** Finer group this cluster simplifies, or `-1` for original finest geometry. */
    readonly refinedGroupId: number;
    readonly pageId: number;
    /** First vertex within the decoded page. */
    readonly vertexOffset: number;
    /** First local index within the decoded page, in `u16` elements. */
    readonly indexOffset: number;
    readonly vertexCount: number;
    readonly triangleCount: number;
    readonly sourceTriangleCount: number;
    /** Local-space normal-cone axis xyz and conservative cutoff, or null when
     *  the meshlet cone spans too much of the sphere to cull safely. */
    readonly normalCone?: readonly [number, number, number, number] | null;
}

/** Parsed 8-wide hierarchy node (32-byte record). */
export interface MeshLoDHierarchyNode {
    readonly center: readonly [number, number, number];
    readonly radius: number;
    readonly error: number;
    /** Leaf group id, or `-1` for an internal node. */
    readonly groupId: number;
    readonly childOffset: number;
    readonly childCount: number;
}

/** Parsed page-table record (64-byte record). */
export interface MeshLoDPageRecord {
    readonly offset: number;
    readonly storedBytes: number;
    readonly meaningfulBytes: number;
    readonly decodedBytes: number;
    readonly crc: number;
    readonly vertexCount: number;
    readonly localIndexCount: number;
    readonly vertexByteOffset: number;
    readonly indexByteOffset: number;
    readonly firstCluster: number;
    readonly clusterCount: number;
    readonly pinned: boolean;
    readonly coarse: boolean;
    readonly minDepth: number;
    readonly maxDepth: number;
}

/** Runtime residency state of one page (architecture §11.3). Pinned pages reach
 *  gpu-resident at bootstrap; fine pages walk unrequested → queued → fetching →
 *  retry-wait → received → decoding → cpu-resident → uploading → gpu-resident, and a
 *  resident fine page may later evict back to unrequested. A terminal fine failure is
 *  page-local (terminal-failed); a pinned failure fails initialization. The scheduler
 *  owns the request-side states (queued/fetching/retry-wait); the runtime owns the
 *  residency-side states. */
export type MeshLoDPageState =
    "unrequested" | "queued" | "fetching" | "retry-wait" | "received" | "decoding" | "cpu-resident" | "uploading" | "gpu-resident" | "evicting" | "terminal-failed" | "disposed";

/** Per-page mutable runtime record. Pinned pages retain their decoded local
 *  indices so the CPU selection/expansion path can build the coarse draw stream
 *  without re-decoding; fine pages stay `unrequested` until streaming. */
export interface MeshLoDPageRuntime {
    readonly id: number;
    state: MeshLoDPageState;
    /** Byte offset within the geometry arena, or `-1` when not resident. */
    arenaOffset: number;
    /** Rounded 64 KiB-multiple arena allocation, or `0` when not resident. */
    arenaBytes: number;
    /** Byte offset of the page's vertex block within its decoded allocation. */
    readonly vertexByteOffset: number;
    /** Decoded `u16` local indices retained for CPU expansion (pinned + resident fine
     *  pages). */
    indices: Uint16Array | null;
    /** Frame index this page was last referenced by selection, driving LRU age and the
     *  120-frame residency hold. */
    lastUsedFrame: number;
    /** Latest demand priority, an eviction tie-break after LRU age. */
    priority: number;
    /** References by the current submitted frame's selection; a page with
     *  `frameRefCount > 0` is never evicted (REQ-CACHE-3). */
    frameRefCount: number;
    /** Terminal failure recorded for a pinned decode/upload error. */
    terminalError?: MeshLoDError;
}

/** GPU-side residency state for one asset: the immutable geometry arena plus the
 *  per-page runtime table. Created during load once pinned pages are resident. */
export interface MeshLoDGpuState {
    readonly arena: MeshLoDArena;
    /** One record per page, indexed by page id. */
    readonly pages: readonly MeshLoDPageRuntime[];
    residentPageCount: number;
}

/** Mutable runtime state referenced by `MeshLoDAsset._runtime`.
 *
 *  Only the fields required so far exist today; the page cache, scheduler, and GPU
 *  state fields defined in the architecture are added by the Phase 4–6
 *  loading/streaming/GPU tasks. */
export interface MeshLoDAssetRuntime {
    readonly engine: EngineContext;
    readonly source: MeshLoDRangeSource;
    /** Bytes covering `[0, bootstrapBytes)`: header, directory, metadata, and the
     *  pinned coarse pages. The complete file for in-memory/200 sources. */
    readonly coarseBytes: Uint8Array;
    readonly header: MeshLoDHeader;
    readonly sections: readonly MeshLoDSectionEntry[];
    readonly groups: readonly MeshLoDGroup[];
    readonly clusters: readonly MeshLoDCluster[];
    readonly hierarchyNodes: readonly MeshLoDHierarchyNode[];
    readonly pageRecords: readonly MeshLoDPageRecord[];
    readonly groupPageRefs: Uint32Array;
    /** Immutable geometry arena and per-page residency (pinned coarse pages GPU-resident at resolve).
     *  Replaced wholesale on device recovery (a fresh arena on the recovered device). */
    gpu: MeshLoDGpuState;
    /** The device the current {@link gpu} buffers belong to; used to make device recovery
     *  idempotent across a shared asset's scenes. */
    gpuDevice: GPUDevice;
    /** Shared per-asset GPU selection buffers (immutable hierarchy + mutable page state).
     *  Built lazily on the first GPU selection; `null` until then and after device change. */
    gpuSelection: MeshLoDGpuAssetBuffers | null;
    /** Bounded fine-page request scheduler. Created by the streaming wiring on the
     *  first frame that demands a fine page; `null` until then and after disposal. */
    scheduler: MeshLoDRequestScheduler | null;
    /** @internal Injected scheduler timers for deterministic streaming fixtures. When
     *  `null` the scheduler uses wall-clock `setTimeout` for retry delays. */
    _schedulerTimers: MeshLoDSchedulerTimers | null;
    /** The shared meshopt decoder resolved at load; reused to decode streamed fine
     *  pages synchronously from the scheduler completion callback. */
    readonly decoderModule: MeshoptDecoderModule;
    /** Retained encoded-page cache (pinned always retained; unpinned LRU-bounded to
     *  `cpuPageCacheBytes`). Seeded with the pinned coarse pages at load. */
    readonly cpuPageCache: MeshLoDCpuPageCache;
    readonly settings: MeshLoDEffectiveSettings;
    /** Live diagnostics object also referenced by `MeshLoDAsset.diagnostics`. */
    readonly diagnostics: MeshLoDDiagnostics;
    readonly abortController: AbortController;
    /** Bumped on disposal and device recovery to invalidate stale completions. */
    generation: number;
    /** Monotonic frame counter used by selection/streaming hysteresis. */
    frameIndex: number;
    streamingPaused: boolean;
    debugView: MeshLoDDebugView;
    selectionMode: MeshLoDSelectionMode;
    /** Next id handed to `createMeshLoDInstance`. */
    nextInstanceId: number;
    disposed: boolean;
}

/** Writable diagnostics view used while updating the live snapshot. */
type MeshLoDMutableDiagnostics = { -readonly [K in keyof MeshLoDDiagnostics]: MeshLoDDiagnostics[K] };

function createDiagnostics(
    parsed: ParsedMeshLoDContainer,
    settings: MeshLoDEffectiveSettings,
    selectionMode: MeshLoDSelectionMode,
    downloadedBytes: number
): MeshLoDMutableDiagnostics {
    return {
        frameIndex: 0,
        sourceTriangleCount: parsed.header.sourceTriangleCount,
        renderedTriangleCount: 0,
        selectedMeshletCount: 0,
        visibleGroupCount: 0,
        fallbackGroupCount: 0,
        maximumSelectedErrorPixels: 0,
        maximumUnmetErrorPixels: 0,
        requestedPageCount: 0,
        queuedPageCount: 0,
        inFlightPageCount: 0,
        residentPageCount: 0,
        pinnedPageCount: parsed.header.pinnedPageCount,
        terminalFailedPageCount: 0,
        downloadedBytes,
        gpuCacheUsedBytes: 0,
        gpuCacheBudgetBytes: settings.cacheBudgetBytes,
        gpuCacheCapacityBytes: settings.cacheCapacityBytes,
        cpuPageCacheUsedBytes: 0,
        maxConcurrentRequests: settings.maxConcurrentRequests,
        streamingPaused: false,
        selectionMode,
    };
}

/** Decode, upload, and mark GPU-resident every pinned coarse page, and allocate the
 *  immutable geometry arena. Runs after metadata validation and before the asset is
 *  registerable. Fine pages are left `unrequested`. Throws before any GPU allocation
 *  when the configured budget/capacity cannot hold the pinned pages
 *  (`MLOD_BUDGET_TOO_SMALL`), and surfaces pinned decode/upload failures as terminal
 *  load failures. */
async function prepareCoarseResidency(
    engine: EngineContext,
    parsed: ParsedMeshLoDContainer,
    coarseBytes: Uint8Array,
    settings: MeshLoDEffectiveSettings,
    signal: AbortSignal | undefined
): Promise<MeshLoDGpuState> {
    const pinnedBytes = pinnedAllocationBytes(parsed.pageRecords);
    // Pinned pages count toward both configured budgets (architecture 11.4).
    if (floorToBlocks(settings.cacheCapacityBytes) < pinnedBytes) {
        throw createMeshLoDError("MLOD_BUDGET_TOO_SMALL", "cacheCapacityBytes cannot hold the pinned coarse pages", { expected: pinnedBytes, actual: settings.cacheCapacityBytes });
    }
    if (settings.cacheBudgetBytes < pinnedBytes) {
        throw createMeshLoDError("MLOD_BUDGET_TOO_SMALL", "cacheBudgetBytes cannot hold the pinned coarse pages", { expected: pinnedBytes, actual: settings.cacheBudgetBytes });
    }

    const arena = createMeshLoDArena(engine, settings.cacheCapacityBytes, pinnedBytes);
    const pages: MeshLoDPageRuntime[] = parsed.pageRecords.map((record, id) => ({
        id,
        state: "unrequested" as MeshLoDPageState,
        arenaOffset: -1,
        arenaBytes: 0,
        vertexByteOffset: record.vertexByteOffset,
        indices: null,
        lastUsedFrame: 0,
        priority: 0,
        frameRefCount: 0,
    }));

    const decoder = await getMeshLoDPageDecoder();
    throwIfAborted(signal);

    let residentPageCount = 0;
    for (let id = 0; id < parsed.pageRecords.length; id++) {
        const record = parsed.pageRecords[id]!;
        const page = pages[id]!;
        if (!record.pinned) {
            continue; // Fine pages stay unrequested until streaming.
        }
        const stored = coarseBytes.subarray(record.offset, record.offset + record.storedBytes);
        let decoded;
        try {
            decoded = decodeMeshLoDPage(stored, record, decoder);
        } catch (cause) {
            const error = cause as MeshLoDError;
            page.state = "terminal-failed";
            page.terminalError = error;
            throw error; // A pinned failure fails initialization (architecture 11.3).
        }
        const arenaOffset = allocateArenaRun(arena, record.decodedBytes, true);
        if (arenaOffset === null) {
            throw createMeshLoDError("MLOD_BUDGET_TOO_SMALL", "pinned pages do not fit the geometry arena", { pageId: id, expected: pinnedBytes });
        }
        engine._device.queue.writeBuffer(arena.buffer, arenaOffset, decoded.decoded.buffer as ArrayBuffer, decoded.decoded.byteOffset, decoded.decoded.byteLength);
        page.arenaOffset = arenaOffset;
        page.arenaBytes = record.decodedBytes;
        page.indices = new Uint16Array(decoded.decoded.buffer, decoded.decoded.byteOffset + record.indexByteOffset, record.localIndexCount).slice();
        page.state = "gpu-resident";
        residentPageCount++;
    }

    return { arena, pages, residentPageCount };
}

/** Load and validate a MeshLoD asset from a resolved settings object.
 *
 *  Runs the coarse-first bootstrap: for a complete-file source it validates the
 *  whole container; for a URL it reads the header (bytes `0-65535`), then reads at
 *  most one continuation through `bootstrapBytes`, and validates the metadata plus
 *  pinned pages while deferring fine pages to streaming. Pinned pages are then
 *  decoded and uploaded into the immutable geometry arena; the promise resolves only
 *  once the complete coarse geometry is GPU-resident. */
export async function _loadMeshLoD(
    engine: EngineContext,
    source: MeshLoDSource,
    settings: MeshLoDEffectiveSettings,
    selectionMode: MeshLoDSelectionMode,
    request: MeshLoDRequestOptions | undefined,
    signal: AbortSignal | undefined
): Promise<MeshLoDAsset> {
    throwIfAborted(signal);
    const src = await createMeshLoDRangeSource(source, request);

    let parsed: ParsedMeshLoDContainer;
    let coarseBytes: Uint8Array;
    if (src.completeBytes) {
        coarseBytes = src.completeBytes;
        parsed = parseMeshLoDContainer(coarseBytes);
    } else {
        const head = await src.read(0, BOOTSTRAP_FIRST_END, signal);
        if (src.completeBytes) {
            // The first response was a full-body 200; use the retained file.
            coarseBytes = src.completeBytes;
            parsed = parseMeshLoDContainer(coarseBytes);
        } else {
            const extent = readBootstrapExtent(head);
            if (src.totalBytes !== null && src.totalBytes !== extent.totalFileBytes) {
                throw createMeshLoDError("MLOD_INVALID_LAYOUT", "transport total disagrees with the header", { expected: extent.totalFileBytes, actual: src.totalBytes });
            }
            coarseBytes =
                head.length >= extent.bootstrapBytes ? head.subarray(0, extent.bootstrapBytes) : concatBytes(head, await src.read(head.length, extent.bootstrapBytes - 1, signal));
            parsed = parseMeshLoDContainer(coarseBytes);
        }
    }

    if (src.totalBytes !== null && src.totalBytes !== parsed.header.totalFileBytes) {
        throw createMeshLoDError("MLOD_TRUNCATED", "transport total disagrees with the declared file size", { expected: parsed.header.totalFileBytes, actual: src.totalBytes });
    }

    const diagnostics = createDiagnostics(parsed, settings, selectionMode, src.downloadedBytes);
    const gpu = await prepareCoarseResidency(engine, parsed, coarseBytes, settings, signal);
    diagnostics.residentPageCount = gpu.residentPageCount;
    diagnostics.gpuCacheUsedBytes = arenaUsedBytes(gpu.arena);
    diagnostics.gpuCacheCapacityBytes = gpu.arena.capacityBytes;
    diagnostics.downloadedBytes = src.downloadedBytes;

    // Retain the pinned coarse pages' encoded bytes so device recovery can re-decode
    // without re-fetching; they always count toward the CPU-cache budget (§11.5).
    const cpuPageCache = createMeshLoDCpuPageCache(settings.cpuPageCacheBytes);
    for (let id = 0; id < parsed.pageRecords.length; id++) {
        const record = parsed.pageRecords[id]!;
        if (record.pinned) {
            putMeshLoDCpuPage(cpuPageCache, id, coarseBytes.subarray(record.offset, record.offset + record.storedBytes).slice(), true, 0);
        }
    }
    diagnostics.cpuPageCacheUsedBytes = cpuCacheUsedBytes(cpuPageCache);

    // The coarse decoder is already resolved (prepareCoarseResidency awaited it and it
    // is a cached singleton); retain it to decode streamed fine pages synchronously.
    const decoderModule = await getMeshLoDPageDecoder();

    const runtime: MeshLoDAssetRuntime = {
        engine,
        source: src,
        coarseBytes,
        header: parsed.header,
        sections: parsed.sections,
        groups: parsed.groups,
        clusters: parsed.clusters,
        hierarchyNodes: parsed.hierarchyNodes,
        pageRecords: parsed.pageRecords,
        groupPageRefs: parsed.groupPageRefs,
        gpu,
        gpuDevice: engine._device,
        gpuSelection: null,
        scheduler: null,
        _schedulerTimers: null,
        decoderModule,
        cpuPageCache,
        settings,
        diagnostics,
        abortController: new AbortController(),
        generation: 0,
        frameIndex: 0,
        streamingPaused: false,
        debugView: "none",
        selectionMode,
        nextInstanceId: 0,
        disposed: false,
    };

    return {
        metadata: toMeshLoDMetadata(parsed),
        diagnostics,
        state: "ready",
        _runtime: runtime,
    };
}

/** Register an instance into its scene-owned MeshLoD batch (delegates to the scene
 *  registry module). */
export function _addMeshLoDToScene(scene: SceneContext, instance: MeshLoDInstance): void {
    addMeshLoDInstanceToScene(scene, instance);
}

/** @internal Normalize a raw GPU/model selected `(cluster, instance)` list to
 *  per-instance ascending unique cluster IDs — the canonical form CPU/GPU equivalence
 *  fixtures and real-device readbacks compare against the CPU oracle's
 *  `selectedClusterIds`. A testing-only hook kept off the trimmed public declaration
 *  surface (never re-exported from `index.ts`). Pass `instanceId` to filter one
 *  instance out of a multi-instance batch readback. */
export function _normalizeMeshLoDSelectedClusterIds(pairs: readonly MeshLoDGpuSelectedPair[], instanceId?: number): Uint32Array {
    const ids = new Set<number>();
    for (const pair of pairs) {
        if (instanceId === undefined || pair.instanceId === instanceId) {
            ids.add(pair.clusterId);
        }
    }
    return Uint32Array.from([...ids].sort((a, b) => a - b));
}

/** Remove an instance from its scene-owned MeshLoD batch (delegates to the scene
 *  registry module). */
export function _removeMeshLoDFromScene(scene: SceneContext, instance: MeshLoDInstance): void {
    removeMeshLoDInstanceFromScene(scene, instance);
}

// ─── Streaming residency engine (architecture §11) ───────────────────

/** Per-frame selection diagnostics published by the scene into the live snapshot.
 *  (Rendered-triangle and selected-meshlet counts stay owned by the material renderable,
 *  which knows the post-capacity-clamp totals.) */
export interface MeshLoDStreamSelectionStats {
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly maximumSelectedErrorPixels: number;
    readonly maximumUnmetErrorPixels: number;
}

/** Inclusive end byte of a page's stored range within the container. */
function pageByteEnd(record: MeshLoDPageRecord): number {
    return record.offset + record.storedBytes - 1;
}

/** Fetch one fine page's encoded bytes. A retained encoded copy (CPU cache) short-
 *  circuits the network for an evicted-then-re-demanded page (§11.5); otherwise the
 *  range source reads exactly its stored bytes. */
function fetchStreamedPage(runtime: MeshLoDAssetRuntime, pageId: number, signal: AbortSignal): Promise<Uint8Array> {
    const cached = getMeshLoDCpuPage(runtime.cpuPageCache, pageId, runtime.frameIndex);
    if (cached) {
        return Promise.resolve(cached);
    }
    const record = runtime.pageRecords[pageId]!;
    return runtime.source.read(record.offset, pageByteEnd(record), signal);
}

/** Lazily create the fine-page scheduler bound to this asset's runtime. Decode, cache,
 *  reservation, upload, and residency commit stay runtime-owned via the callbacks. */
function ensureMeshLoDScheduler(runtime: MeshLoDAssetRuntime): MeshLoDRequestScheduler {
    if (runtime.scheduler) {
        return runtime.scheduler;
    }
    const scheduler = createMeshLoDRequestScheduler({
        maxConcurrentRequests: runtime.settings.maxConcurrentRequests,
        retryCount: runtime.settings.retryCount,
        retryDelaysMs: runtime.settings.retryDelaysMs,
        obsoleteRequestGraceFrames: runtime.settings.obsoleteRequestGraceFrames,
        callbacks: {
            fetchPage: (pageId, signal) => fetchStreamedPage(runtime, pageId, signal),
            onPageReceived: (pageId, bytes) => commitStreamedPage(runtime, pageId, bytes),
            onPageFailed: (pageId, error) => failStreamedPage(runtime, pageId, error),
            currentGeneration: () => runtime.generation,
            isPaused: () => runtime.streamingPaused,
        },
        timers: runtime._schedulerTimers ?? undefined,
    });
    runtime.scheduler = scheduler;
    return scheduler;
}

/** Commit a fresh, non-stale fetched fine page: validate + decode, retain its encoded
 *  bytes, reserve a decoded arena run (evicting eligible victims), upload, and mark it
 *  GPU-resident. A decode/integrity failure is page-local (terminal-failed). If no run
 *  fits without evicting protected pages the page stays unrequested for a later frame,
 *  its encoded bytes retained. */
function commitStreamedPage(runtime: MeshLoDAssetRuntime, pageId: number, bytes: Uint8Array): void {
    if (runtime.disposed) {
        // A completion racing disposal must never allocate arena or mark a page resident.
        return;
    }
    const record = runtime.pageRecords[pageId]!;
    const page = runtime.gpu.pages[pageId]!;
    // Retain the encoded bytes (unpinned, LRU-bounded) so device recovery / re-demand
    // can decode without re-fetching (§11.5).
    putMeshLoDCpuPage(runtime.cpuPageCache, pageId, bytes.slice(), record.pinned, runtime.frameIndex);

    page.state = "decoding";
    let decoded: DecodedMeshLoDPage;
    try {
        decoded = decodeMeshLoDPage(bytes, record, runtime.decoderModule);
    } catch (cause) {
        failStreamedPage(runtime, pageId, cause as MeshLoDError);
        return;
    }
    page.state = "cpu-resident";

    const policy: MeshLoDEvictionPolicy = {
        budgetBytes: floorToBlocks(runtime.settings.cacheBudgetBytes),
        currentFrame: runtime.frameIndex,
        residencyHoldFrames: runtime.settings.residencyHoldFrames,
    };
    const evicted: number[] = [];
    const offset = reserveMeshLoDArenaRun(runtime.gpu.arena, runtime.gpu.pages, runtime.pageRecords, record.decodedBytes, policy, evicted);
    applyStreamedEvictions(runtime, evicted);
    if (offset === null) {
        // No run fits without evicting protected pages; re-demand on a later frame.
        page.state = "unrequested";
        refreshMeshLoDStreamingDiagnostics(runtime);
        return;
    }

    page.state = "uploading";
    const arena = runtime.gpu.arena;
    runtime.engine._device.queue.writeBuffer(arena.buffer, offset, decoded.decoded.buffer as ArrayBuffer, decoded.decoded.byteOffset, decoded.decoded.byteLength);
    page.arenaOffset = offset;
    page.arenaBytes = record.decodedBytes;
    // Retain only the decoded local indices for CPU expansion; the decoded vertex bytes
    // are released after upload (§11.5).
    page.indices = new Uint16Array(decoded.decoded.buffer, decoded.decoded.byteOffset + record.indexByteOffset, record.localIndexCount).slice();
    page.lastUsedFrame = runtime.frameIndex;
    page.state = "gpu-resident";
    runtime.gpu.residentPageCount++;
    refreshMeshLoDStreamingDiagnostics(runtime);
}

/** Record a page-local terminal fine failure (never fails the coarse asset). A page
 *  that already reached residency ignores a late failure. */
function failStreamedPage(runtime: MeshLoDAssetRuntime, pageId: number, error: MeshLoDError): void {
    const page = runtime.gpu.pages[pageId]!;
    if (runtime.disposed || page.state === "gpu-resident") {
        return;
    }
    page.state = "terminal-failed";
    page.terminalError = error;
    refreshMeshLoDStreamingDiagnostics(runtime);
}

/** Account evicted pages: each was reset to `unrequested` by the cache; drop the
 *  resident count. Encoded bytes stay retained in the CPU cache for re-demand. */
function applyStreamedEvictions(runtime: MeshLoDAssetRuntime, evicted: readonly number[]): void {
    for (let i = 0; i < evicted.length; i++) {
        if (runtime.gpu.residentPageCount > 0) {
            runtime.gpu.residentPageCount--;
        }
    }
}

function countTerminalFailedPages(runtime: MeshLoDAssetRuntime): number {
    let count = 0;
    for (const page of runtime.gpu.pages) {
        if (page.state === "terminal-failed") {
            count++;
        }
    }
    return count;
}

/** Refresh the live diagnostics counters that streaming and residency own. */
function refreshMeshLoDStreamingDiagnostics(runtime: MeshLoDAssetRuntime): void {
    const d = runtime.diagnostics as MeshLoDMutableDiagnostics;
    const scheduler = runtime.scheduler;
    d.requestedPageCount = scheduler ? scheduler.requests.size : 0;
    d.queuedPageCount = scheduler ? schedulerQueuedCount(scheduler) : 0;
    d.inFlightPageCount = scheduler ? scheduler.inFlightCount : 0;
    d.residentPageCount = runtime.gpu.residentPageCount;
    d.terminalFailedPageCount = countTerminalFailedPages(runtime);
    d.downloadedBytes = runtime.source.downloadedBytes;
    d.gpuCacheUsedBytes = arenaUsedBytes(runtime.gpu.arena);
    d.gpuCacheBudgetBytes = runtime.settings.cacheBudgetBytes;
    d.cpuPageCacheUsedBytes = cpuCacheUsedBytes(runtime.cpuPageCache);
    d.maxConcurrentRequests = scheduler ? scheduler.maxConcurrentRequests : runtime.settings.maxConcurrentRequests;
    d.streamingPaused = runtime.streamingPaused;
    d.selectionMode = runtime.selectionMode;
}

/** @internal Drive one frame of fine-page streaming for an asset. Advances the frame
 *  counter, applies pending control changes (concurrency, CPU-cache budget), holds a
 *  frame reference on every page a rendered cluster used (released after the frame is
 *  submitted, per §14.1), feeds generation-stamped demand to the scheduler, trims
 *  residency to the effective GPU budget, and refreshes diagnostics. Called by the
 *  scene each frame with the aggregated per-instance page demand and referenced pages. */
export function stepMeshLoDStreaming(
    runtime: MeshLoDAssetRuntime,
    demand: readonly MeshLoDPageDemand[],
    referencedPages: readonly number[],
    selectionStats?: MeshLoDStreamSelectionStats
): void {
    if (runtime.disposed) {
        return;
    }
    const frame = ++runtime.frameIndex;

    // Apply control changes that may have arrived via the public setters since the
    // previous frame.
    setMeshLoDCpuCacheBudget(runtime.cpuPageCache, runtime.settings.cpuPageCacheBytes);
    if (runtime.scheduler) {
        setMeshLoDSchedulerConcurrency(runtime.scheduler, runtime.settings.maxConcurrentRequests);
    }

    // Frame references: a page that contributed a rendered cluster is protected from
    // eviction until this frame's command buffer has been submitted (§14.1).
    if (referencedPages.length > 0) {
        const held: number[] = [];
        for (const id of referencedPages) {
            const page = runtime.gpu.pages[id];
            if (!page) {
                continue;
            }
            page.frameRefCount++;
            page.lastUsedFrame = frame;
            held.push(id);
        }
        if (held.length > 0) {
            retireGpuResources(runtime.engine, () => {
                for (const id of held) {
                    const page = runtime.gpu.pages[id];
                    if (page && page.frameRefCount > 0) {
                        page.frameRefCount--;
                    }
                }
            });
        }
    }

    // Record demand priority for the eviction tie-break, then feed the scheduler.
    for (const item of demand) {
        const page = runtime.gpu.pages[item.pageId];
        if (page) {
            page.priority = item.priority;
        }
    }
    if (demand.length > 0 || runtime.scheduler) {
        submitMeshLoDDemand(ensureMeshLoDScheduler(runtime), demand, frame);
    }

    // Trim resident fine pages down to a possibly-lowered effective GPU budget.
    const policy: MeshLoDEvictionPolicy = {
        budgetBytes: floorToBlocks(runtime.settings.cacheBudgetBytes),
        currentFrame: frame,
        residencyHoldFrames: runtime.settings.residencyHoldFrames,
    };
    const evicted: number[] = [];
    evictMeshLoDToBudget(runtime.gpu.arena, runtime.gpu.pages, runtime.pageRecords, policy, evicted);
    applyStreamedEvictions(runtime, evicted);

    if (selectionStats) {
        const d = runtime.diagnostics as MeshLoDMutableDiagnostics;
        d.frameIndex = frame;
        d.visibleGroupCount = selectionStats.visibleGroupCount;
        d.fallbackGroupCount = selectionStats.fallbackGroupCount;
        d.maximumSelectedErrorPixels = selectionStats.maximumSelectedErrorPixels;
        d.maximumUnmetErrorPixels = selectionStats.maximumUnmetErrorPixels;
    } else {
        (runtime.diagnostics as MeshLoDMutableDiagnostics).frameIndex = frame;
    }
    refreshMeshLoDStreamingDiagnostics(runtime);
}

/** @internal Cancel every outstanding fine-page request and drop the scheduler. Called
 *  from disposal and device recovery; late completions are already stale by generation. */
export function _disposeMeshLoDScheduler(runtime: MeshLoDAssetRuntime): void {
    if (runtime.scheduler) {
        disposeMeshLoDRequestScheduler(runtime.scheduler);
        runtime.scheduler = null;
    }
}

/** @internal Free an asset's GPU + CPU residency on disposal (§14.2). The geometry
 *  arena and the shared per-asset selection buffers retire only after the next
 *  submitted frame that could reference them drains (make-before-break / frame safety,
 *  REQ-RENDER-4); the batch draw path stops immediately (disposed batches are
 *  non-drawable), so retained CPU page bytes and decoded indices are released now.
 *  Idempotent-safe: repeated disposal is guarded by the caller. */
export function _disposeMeshLoDResources(runtime: MeshLoDAssetRuntime): void {
    const engine = runtime.engine;
    const arenaBuffer = runtime.gpu?.arena.buffer;
    const selection = runtime.gpuSelection;
    runtime.gpuSelection = null;
    retireGpuResources(engine, () => {
        arenaBuffer?.destroy?.();
        selection?.metaBuffer.destroy?.();
        selection?.pageStateBuffer.destroy?.();
    });
    if (runtime.gpu) {
        for (const page of runtime.gpu.pages) {
            page.indices = null;
            page.state = "disposed";
            page.arenaOffset = -1;
            page.arenaBytes = 0;
            page.frameRefCount = 0;
        }
        runtime.gpu.residentPageCount = 0;
    }
    clearMeshLoDCpuPageCache(runtime.cpuPageCache);
}

/** @internal Rebuild an asset's GPU residency on the recovered device (architecture §14.3).
 *  Recreates the geometry arena, re-decodes and re-uploads the retained pinned coarse pages,
 *  resets fine pages to `unrequested` (restored opportunistically by streaming), and drops
 *  the shared selection buffers so they rebuild against the new device. Idempotent per
 *  device (a shared asset recovers once). A pinned re-decode/upload failure is terminal —
 *  it throws `MLOD_DEVICE_RECOVERY` and leaves no partial coarse residency, so recovery
 *  cannot claim success. Old resources on a truly lost device need no queue retirement. */
export function _recoverMeshLoDAsset(engine: EngineContext, runtime: MeshLoDAssetRuntime): void {
    if (runtime.disposed || runtime.gpuDevice === engine._device) {
        return;
    }
    // Invalidate any in-flight completion from the lost device, then drop the stale scheduler.
    runtime.generation += 1;
    _disposeMeshLoDScheduler(runtime);

    const pinnedBytes = pinnedAllocationBytes(runtime.pageRecords);
    const arena = createMeshLoDArena(engine, runtime.settings.cacheCapacityBytes, pinnedBytes);
    const pages: MeshLoDPageRuntime[] = runtime.pageRecords.map((record, id) => ({
        id,
        state: "unrequested" as MeshLoDPageState,
        arenaOffset: -1,
        arenaBytes: 0,
        vertexByteOffset: record.vertexByteOffset,
        indices: null,
        lastUsedFrame: 0,
        priority: 0,
        frameRefCount: 0,
    }));

    let residentPageCount = 0;
    for (let id = 0; id < runtime.pageRecords.length; id++) {
        const record = runtime.pageRecords[id]!;
        if (!record.pinned) {
            continue; // Fine pages restore opportunistically through streaming.
        }
        const encoded = getMeshLoDCpuPage(runtime.cpuPageCache, id, runtime.frameIndex);
        if (!encoded) {
            throw createMeshLoDError("MLOD_DEVICE_RECOVERY", "retained pinned coarse bytes are unavailable for device recovery", { pageId: id });
        }
        let decoded: DecodedMeshLoDPage;
        try {
            decoded = decodeMeshLoDPage(encoded, record, runtime.decoderModule);
        } catch (cause) {
            throw createMeshLoDError("MLOD_DEVICE_RECOVERY", "failed to re-decode a pinned coarse page during device recovery", {
                pageId: id,
                actual: (cause as MeshLoDError)?.message,
            });
        }
        const offset = allocateArenaRun(arena, record.decodedBytes, true);
        if (offset === null) {
            throw createMeshLoDError("MLOD_DEVICE_RECOVERY", "recovered geometry arena cannot hold the pinned coarse pages", { pageId: id });
        }
        engine._device.queue.writeBuffer(arena.buffer, offset, decoded.decoded.buffer as ArrayBuffer, decoded.decoded.byteOffset, decoded.decoded.byteLength);
        pages[id]!.arenaOffset = offset;
        pages[id]!.arenaBytes = record.decodedBytes;
        pages[id]!.indices = new Uint16Array(decoded.decoded.buffer, decoded.decoded.byteOffset + record.indexByteOffset, record.localIndexCount).slice();
        pages[id]!.state = "gpu-resident";
        residentPageCount++;
    }

    runtime.gpu = { arena, pages, residentPageCount };
    runtime.gpuSelection = null; // rebuilt against the new device on the next selection
    runtime.gpuDevice = engine._device;
    const d = runtime.diagnostics as MeshLoDMutableDiagnostics;
    d.gpuCacheCapacityBytes = arena.capacityBytes;
    refreshMeshLoDStreamingDiagnostics(runtime);
}
