import type { EngineContext } from "../engine/engine.js";
import { getCameraPosition, getEffectiveAspectRatio, getProjectionMatrix, getViewProjectionMatrix } from "../camera/camera.js";
import type { DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addDeferredSceneRenderables } from "../scene/scene-core.js";
import { initSceneNodeTransform } from "../scene/scene-node.js";
import {
    admitSplatSource,
    canReserveSplatSourceGpuBytes,
    createSplatSourceCache,
    createSplatSourceRetirement,
    disposeSplatSourceCache,
    reserveSplatSourceGpuBytes,
    setSplatSourceProtection,
} from "./splat-stream-cache.js";
import { createSplatStreamGpuState, retireSplatStreamGpuState, setSplatStreamGpuIntervals, type SplatStreamGpuInterval, type SplatStreamGpuState } from "./splat-stream-gpu.js";
import { createSplatStreamGpuLedger } from "./splat-stream-gpu-ledger.js";
import { buildSplatStreamGpuRenderable } from "./splat-stream-material.js";
import { parseSplatStreamManifest } from "./splat-stream-meta.js";
import {
    createSplatStreamRequestManager,
    SplatGpuBudgetPressureError,
    SplatRequestPriority,
    type PreparedSplatSource,
    type SplatStreamRequestManager,
} from "./splat-stream-requests.js";
import { planStreamSelection, selectBootstrapSource } from "./splat-stream-selection.js";
import type {
    GaussianSplatStream,
    GaussianSplatStreamOptions,
    GaussianSplatStreamStats,
    GaussianSplatStreamStatsSnapshot,
    StreamLeafRuntime,
    StreamRepresentation,
    StreamSourceRuntime,
} from "./splat-stream-types.js";
import { normalizeSplatStreamOptions } from "./splat-stream-types.js";

const PREFIX = "[GaussianSplatStream]";

interface StreamAttachment {
    readonly scene: SceneContext;
    readonly beforeRender: (deltaMs: number) => void;
    renderable: Renderable | null;
    disposed: boolean;
}

interface FirstFrameDeferred {
    resolve(): void;
    reject(error: Error): void;
}

let _attachments: WeakMap<GaussianSplatStream, StreamAttachment> | null = null;
let _firstFrames: WeakMap<GaussianSplatStream, FirstFrameDeferred> | null = null;

function error(reason: unknown, context: string): Error {
    if (reason instanceof Error && reason.message.startsWith(PREFIX)) {
        return reason;
    }
    return new Error(`${PREFIX} ${context}${reason instanceof Error ? `: ${reason.message}` : ""}`, { cause: reason });
}

function abortError(context: string): Error {
    return new DOMException(`${PREFIX} ${context}`, "AbortError");
}

function createStats(): GaussianSplatStreamStats {
    const values: GaussianSplatStreamStatsSnapshot = {
        phase: "bootstrap",
        visibleLeaves: 0,
        coveredLeaves: 0,
        targetLeaves: 0,
        selectedSplats: 0,
        residentFiles: 0,
        queuedFiles: 0,
        pendingRequests: 0,
        residentGpuBytes: 0,
        allocatedGpuBytes: 0,
        fetchedBytes: 0,
        firstFrameMs: null,
        error: null,
    };
    return {
        _values: values,
        get phase() {
            return values.phase;
        },
        get visibleLeaves() {
            return values.visibleLeaves;
        },
        get coveredLeaves() {
            return values.coveredLeaves;
        },
        get targetLeaves() {
            return values.targetLeaves;
        },
        get selectedSplats() {
            return values.selectedSplats;
        },
        get residentFiles() {
            return values.residentFiles;
        },
        get queuedFiles() {
            return values.queuedFiles;
        },
        get pendingRequests() {
            return values.pendingRequests;
        },
        get residentGpuBytes() {
            return values.residentGpuBytes;
        },
        get allocatedGpuBytes() {
            return values.allocatedGpuBytes;
        },
        get fetchedBytes() {
            return values.fetchedBytes;
        },
        get firstFrameMs() {
            return values.firstFrameMs;
        },
        get error() {
            return values.error;
        },
    };
}

function updateStats(stream: GaussianSplatStream): void {
    const values = stream.stats._values;
    values.coveredLeaves = stream._leafStates.reduce((count, state) => count + (state.displayed ? 1 : 0), 0);
    values.targetLeaves = stream._leafStates.reduce((count, state) => count + (state.visible ? 1 : 0), 0);
    values.residentFiles = stream._cache.entries.size;
    values.queuedFiles = stream._requests.queuedFiles;
    values.pendingRequests = stream._requests.pendingRequests;
    values.residentGpuBytes = stream._gpu.ledger.residentBytes;
    values.allocatedGpuBytes = stream._gpu.ledger.allocatedBytes;
    values.fetchedBytes = stream._manifestBytes + stream._requests.fetchedBytes;
    if (values.phase !== "bootstrap" && values.phase !== "disposed" && values.phase !== "error") {
        values.phase = stream._sourceStates.some((state) => state.state === "blocked" && state.demandCount > 0)
            ? "budget-limited"
            : values.queuedFiles || values.pendingRequests || stream._sourceStates.some((state) => state.request)
              ? "streaming"
              : "idle";
    }
}

function sameRepresentation(left: StreamRepresentation | null, right: StreamRepresentation): boolean {
    return !!left && left.fileId === right.fileId && left.offset === right.offset && left.count === right.count;
}

function sourceIntervals(stream: GaussianSplatStream, sourceId: number): { offset: number; count: number }[] {
    const intervals: { offset: number; count: number }[] = [];
    for (const representation of stream._sourceStates[sourceId]!.source.consumers) {
        if (!intervals.some((value) => value.offset === representation.offset && value.count === representation.count)) {
            intervals.push({ offset: representation.offset, count: representation.count });
        }
    }
    return intervals;
}

function makeGpuSource(prepared: PreparedSplatSource) {
    const textures = prepared.textures as [GPUTexture, GPUTexture, GPUTexture, GPUTexture, GPUTexture];
    if (textures.length !== 5) {
        throw new Error(`${PREFIX} source ${prepared.url}: expected five textures`);
    }
    return {
        textures,
        views: textures.map((texture) => texture.createView()) as [GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView, GPUTextureView],
        codebooks: prepared.metadataBuffer,
        width: prepared.width,
        height: prepared.height,
        count: prepared.count,
        meansMin: prepared.meansMin,
        meansMax: prepared.meansMax,
        _destroyed: false,
    };
}

function refreshProtections(stream: GaussianSplatStream): void {
    for (const sourceState of stream._sourceStates) {
        let displayedRefs = 0;
        let pendingRefs = 0;
        for (const leaf of stream._leafStates) {
            const active = stream._frame === 0 || leaf.visible;
            displayedRefs += active && leaf.displayed?.fileId === sourceState.source.id ? 1 : 0;
            pendingRefs += leaf.visible && leaf.pending?.fileId === sourceState.source.id ? 1 : 0;
        }
        const activeRefs = sourceState.gpu ? stream._gpu.intervals.reduce((count, interval) => count + (interval.source === sourceState.gpu ? 1 : 0), 0) : 0;
        const refs: Parameters<typeof setSplatSourceProtection>[2] = {
            pinCount: sourceState.source.id === stream._bootstrapSourceId ? 1 : 0,
            displayedRefs,
            pendingRefs,
            activeRefs,
        };
        if (activeRefs > 0) {
            refs.lastUsedFrame = stream._frame;
        }
        setSplatSourceProtection(stream._cache, sourceState.source.url, refs);
    }
}

/** @internal Clears every runtime reference to a source as soon as cache eviction starts. */
export function forgetEvictedSplatStreamSource(stream: GaussianSplatStream, url: string): void {
    const state = stream._sourceStates.find((candidate) => candidate.source.url === url);
    if (!state) {
        return;
    }
    for (const leaf of stream._leafStates) {
        if (leaf.displayed?.fileId === state.source.id) {
            leaf.displayed = null;
        }
        if (leaf.pending?.fileId === state.source.id) {
            leaf.pending = null;
        }
    }
    state.gpu = null;
    state.state = "unrequested";
    state.error = null;
    state.blockedRequiredBytes = 0;
    state.blockedAllocatedBytes = -1;
    state.blockedHeldBytes = -1;
    state.blockedAdmissionVersion = -1;
}

function synchronizeEvictedSources(stream: GaussianSplatStream): void {
    for (const candidate of stream._sourceStates) {
        if (!candidate.gpu || stream._cache.entries.has(candidate.source.url)) {
            continue;
        }
        forgetEvictedSplatStreamSource(stream, candidate.source.url);
    }
}

function commitDisplayed(stream: GaussianSplatStream, force = false): void {
    if (stream._disposed) {
        return;
    }
    let changed = false;
    for (const state of stream._leafStates) {
        if (state.pending) {
            state.displayed = state.pending;
            state.pending = null;
            changed = true;
        }
    }
    if (!changed && !force) {
        refreshProtections(stream);
        updateStats(stream);
        return;
    }
    const intervals: SplatStreamGpuInterval[] = [];
    let destinationOffset = 0;
    for (const state of stream._leafStates) {
        const representation = stream._frame === 0 || state.visible ? state.displayed : null;
        const source = representation ? stream._sourceStates[representation.fileId]!.gpu : null;
        if (!representation || !source) {
            continue;
        }
        if (destinationOffset + representation.count > stream._gpu.capacity) {
            stream.stats._values.error = new Error(`${PREFIX} active display exceeds admitted GPU capacity`);
            stream.stats._values.phase = "error";
            break;
        }
        intervals.push({ source, sourceOffset: representation.offset, count: representation.count, destinationOffset });
        destinationOffset += representation.count;
    }
    const environment = stream._sourceStates[stream._manifest.sources.length];
    if (environment?.gpu && destinationOffset + environment.gpu.count <= stream._gpu.capacity) {
        intervals.push({ source: environment.gpu, sourceOffset: 0, count: environment.gpu.count, destinationOffset });
        destinationOffset += environment.gpu.count;
    }
    stream._contentGeneration++;
    setSplatStreamGpuIntervals(stream._gpu, intervals, stream._contentGeneration);
    refreshProtections(stream);
    updateStats(stream);
}

function settleBootstrapFailure(stream: GaussianSplatStream, reason: unknown): void {
    if (stream._disposed) {
        return;
    }
    const failure = error(reason, "bootstrap failed");
    stream.stats._values.error = failure;
    stream.stats._values.phase = "error";
    if (!stream._firstFrameSettled) {
        stream._firstFrameSettled = true;
        _firstFrames?.get(stream)?.reject(failure);
    }
}

function requestSource(stream: GaussianSplatStream, sourceId: number, priority: SplatRequestPriority): void {
    const state = stream._sourceStates[sourceId]!;
    if (stream._disposed || state.state === "resident" || state.state === "failed" || state.request) {
        return;
    }
    const generation = ++state.generation;
    state.state = "queued";
    state.blockedRequiredBytes = 0;
    state.blockedAllocatedBytes = -1;
    state.blockedHeldBytes = -1;
    state.blockedAdmissionVersion = -1;
    const intervals = sourceIntervals(stream, sourceId);
    const preparation =
        stream._runtime.prepareSource?.(state.source, generation, priority, intervals) ??
        stream._requests.request({
            url: state.source.url,
            fileId: sourceId,
            generation,
            priority,
            intervals,
            signal: stream._options.signal,
        });
    state.request = preparation
        .then((prepared) => {
            if (stream._disposed || generation !== state.generation) {
                prepared.textures.forEach((texture) => texture.destroy());
                prepared.metadataBuffer.destroy();
                if (prepared._gpuReserved) {
                    stream._gpu.ledger.release(prepared.gpuBytes);
                }
                return;
            }
            const gpu = makeGpuSource(prepared);
            const admitted = admitSplatSource(stream._cache, {
                url: state.source.url,
                generation,
                width: prepared.width,
                height: prepared.height,
                count: prepared.count,
                gpuBytes: prepared.gpuBytes,
                cpuBytes: prepared.cpuBytes,
                resources: { textures: prepared.textures, metadataBuffer: prepared.metadataBuffer },
                gpuReserved: prepared._gpuReserved,
                pinCount: sourceId === stream._bootstrapSourceId ? 1 : 0,
                displayedRefs: 0,
                pendingRefs: 0,
                activeRefs: 0,
                lastUsedFrame: stream._frame,
            });
            if (!admitted) {
                throw new Error(`${PREFIX} source ${state.source.url}: GPU/CPU cache budget admission failed`);
            }
            synchronizeEvictedSources(stream);
            state.gpu = gpu;
            state.state = "resident";
            state.error = null;
            state.blockedRequiredBytes = 0;
            state.blockedAllocatedBytes = -1;
            state.blockedHeldBytes = -1;
            state.blockedAdmissionVersion = -1;
            for (const leafState of stream._leafStates) {
                const coarse = stream._manifest.leaves[leafState.target.leafId]?.alternatives[0] ?? null;
                const target =
                    sourceId === stream._bootstrapSourceId && !stream._refinementEnabled
                        ? coarse?.fileId === sourceId
                            ? coarse
                            : null
                        : leafState.visible
                          ? leafState.target
                          : null;
                if (target?.fileId === sourceId && target.offset + target.count <= prepared.count) {
                    leafState.pending = target;
                }
            }
            commitDisplayed(stream, sourceId >= stream._manifest.sources.length);
        })
        .catch((reason: unknown) => {
            if (stream._disposed || generation !== state.generation) {
                return;
            }
            if (reason instanceof DOMException && reason.name === "AbortError") {
                if (sourceId === stream._bootstrapSourceId && stream._options.signal?.aborted) {
                    settleBootstrapFailure(stream, reason);
                }
                return;
            }
            if (reason instanceof SplatGpuBudgetPressureError && sourceId !== stream._bootstrapSourceId) {
                state.state = "blocked";
                state.error = null;
                state.blockedRequiredBytes = reason.requiredBytes;
                state.blockedAllocatedBytes = stream._gpu.ledger.allocatedBytes;
                state.blockedHeldBytes = stream._gpu.ledger.heldBytes;
                state.blockedAdmissionVersion = stream._cache.admissionVersion;
                return;
            }
            const failure = error(reason, `source ${state.source.url} failed`);
            state.state = "failed";
            state.error = failure;
            stream.stats._values.error = failure;
            if (sourceId === stream._bootstrapSourceId) {
                settleBootstrapFailure(stream, failure);
            } else {
                stream.stats._values.phase = "error";
            }
        })
        .finally(() => {
            if (generation === state.generation) {
                state.request = null;
            }
            updateStats(stream);
        });
    updateStats(stream);
}

function scheduleTargets(stream: GaussianSplatStream): void {
    if (!stream._refinementEnabled || stream._disposed) {
        return;
    }
    const demand = new Uint32Array(stream._sourceStates.length);
    for (const leafState of stream._leafStates) {
        if (!leafState.visible || sameRepresentation(leafState.displayed, leafState.target)) {
            continue;
        }
        demand[leafState.target.fileId] = demand[leafState.target.fileId]! + 1;
    }
    for (const state of stream._sourceStates) {
        const environmentDemand = state.source.url === stream._manifest.environmentUrl ? 1 : 0;
        const leafDemand = demand[state.source.id]!;
        state.demandCount = leafDemand + environmentDemand;
        if (state.demandCount > 0) {
            const admissionChanged =
                stream._gpu.ledger.allocatedBytes < state.blockedAllocatedBytes ||
                stream._gpu.ledger.heldBytes < state.blockedHeldBytes ||
                stream._cache.admissionVersion !== state.blockedAdmissionVersion;
            if (state.state !== "blocked" || (admissionChanged && canReserveSplatSourceGpuBytes(stream._cache, state.blockedRequiredBytes))) {
                requestSource(
                    stream,
                    state.source.id,
                    environmentDemand && leafDemand === 0
                        ? SplatRequestPriority.Environment
                        : state.gpu
                          ? SplatRequestPriority.Upgrade
                          : leafUncovered(stream, state.source.id)
                            ? SplatRequestPriority.Uncovered
                            : SplatRequestPriority.Upgrade
                );
            }
        } else if (state.request && state.source.id !== stream._bootstrapSourceId) {
            state.generation++;
            state.request = null;
            state.state = "unrequested";
            stream._requests.cancel(state.source.url);
        } else if (state.state === "blocked") {
            state.state = "unrequested";
            state.blockedRequiredBytes = 0;
            state.blockedAllocatedBytes = -1;
            state.blockedHeldBytes = -1;
            state.blockedAdmissionVersion = -1;
        }
    }
}

function leafUncovered(stream: GaussianSplatStream, sourceId: number): boolean {
    return stream._leafStates.some((state) => state.visible && !state.displayed && state.target.fileId === sourceId);
}

function updateSelection(stream: GaussianSplatStream, context: DrawUpdateContext): void {
    if (stream._disposed) {
        return;
    }
    stream._frame++;
    commitDisplayed(stream);
    const camera = context._camera;
    if (!camera || context.targetWidth <= 0 || context.targetHeight <= 0) {
        return;
    }
    try {
        const aspect = getEffectiveAspectRatio(camera, context.targetWidth, context.targetHeight);
        const projection = getProjectionMatrix(camera, aspect);
        const cameraPosition = getCameraPosition(camera);
        const previousTargets = new Map<number, StreamRepresentation>();
        for (const state of stream._leafStates) {
            if (state.visible) {
                previousTargets.set(state.target.leafId, state.target);
            }
            state.visible = false;
        }
        const plan = planStreamSelection({
            root: stream._manifest.root,
            worldMatrix: stream.worldMatrix,
            viewProjectionMatrix: getViewProjectionMatrix(camera, aspect),
            projectionP11: projection[5]!,
            cameraPosition: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
            targetHeight: context.targetHeight * (camera.viewport?.height ?? 1),
            near: camera.nearPlane,
            maxSplats: stream.maxSplats,
            screenError: stream.screenError,
            lodHysteresis: stream._options.lodHysteresis,
            previousTargets,
            perspective: !camera.ortho,
        });
        stream.stats._values.visibleLeaves = plan.visibleLeaves;
        stream.stats._values.selectedSplats = plan.selectedSplats;
        for (const selection of plan.selections) {
            const state = stream._leafStates[selection.leaf.id]!;
            state.visible = true;
            state.lastVisibleFrame = stream._frame;
            if (!sameRepresentation(state.target, selection.target)) {
                state.target = selection.target;
                state.selectionGeneration++;
                state.pending = null;
            }
            const source = stream._sourceStates[state.target.fileId]!;
            if (!sameRepresentation(state.displayed, state.target) && source.state === "resident") {
                state.pending = state.target;
            } else if (!state.displayed) {
                const alternatives = stream._manifest.leaves[state.target.leafId]!.alternatives;
                const targetIndex = alternatives.indexOf(state.target);
                for (let index = targetIndex - 1; index >= 0; index--) {
                    const fallback = alternatives[index]!;
                    const fallbackSource = stream._sourceStates[fallback.fileId]!;
                    if (fallbackSource.state === "resident" && fallbackSource.gpu && fallback.offset + fallback.count <= fallbackSource.gpu.count) {
                        state.pending = fallback;
                        break;
                    }
                }
            }
        }
        commitDisplayed(stream, true);
        scheduleTargets(stream);
    } catch (reason) {
        stream.stats._values.error = error(reason, "selection failed");
        stream.stats._values.phase = "error";
    }
    updateStats(stream);
}

function coarseDrawn(stream: GaussianSplatStream, nonemptySignal: Promise<boolean> | null): void {
    if (stream._disposed || stream._coarseSubmitted || !nonemptySignal) {
        return;
    }
    stream._coarseSubmitted = true;
    void nonemptySignal.then(
        (nonempty) => {
            if (!nonempty) {
                settleBootstrapFailure(stream, new Error(`${PREFIX} bootstrap projection produced no drawable splats`));
                return;
            }
            if (stream._disposed) {
                return;
            }
            stream._refinementEnabled = true;
            stream.stats._values.phase = "streaming";
            scheduleTargets(stream);
            const wait = stream._runtime.queueDone?.(stream._engine) ?? stream._engine._device.queue.onSubmittedWorkDone();
            void wait.then(
                () => {
                    if (stream._disposed || stream._firstFrameSettled) {
                        return;
                    }
                    stream._firstFrameSettled = true;
                    stream.stats._values.firstFrameMs = (stream._runtime.now?.() ?? performance.now()) - stream._startedAt;
                    _firstFrames?.get(stream)?.resolve();
                    updateStats(stream);
                },
                (reason: unknown) => settleBootstrapFailure(stream, reason)
            );
        },
        (reason: unknown) => settleBootstrapFailure(stream, reason)
    );
}

async function fetchManifest(metadataUrl: string, options: GaussianSplatStreamOptions): Promise<{ value: unknown; url: string; bytes: number }> {
    let url: string;
    try {
        url = new URL(metadataUrl).href;
    } catch (reason) {
        throw error(reason, `metadata ${metadataUrl}: invalid URL`);
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error(`${PREFIX} metadata ${url}: only http and https URLs are supported`);
    }
    const fetchImpl = options._runtime?.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new Error(`${PREFIX} metadata: Fetch is required`);
    }
    const delay =
        options._runtime?.delay ??
        ((milliseconds: number, signal: AbortSignal) =>
            new Promise<void>((resolve, reject) => {
                if (signal.aborted) {
                    reject(signal.reason instanceof Error ? signal.reason : abortError("manifest retry aborted"));
                    return;
                }
                const timer = setTimeout(resolve, milliseconds);
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        reject(signal.reason instanceof Error ? signal.reason : abortError("manifest retry aborted"));
                    },
                    { once: true }
                );
            }));
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let response!: Response;
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                response = await fetchImpl(url, { signal: controller.signal });
                if (response.ok) {
                    break;
                }
                if (response.body) {
                    await response.body.cancel();
                }
                if (!(response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) || attempt >= (options.maxRetries ?? 2)) {
                    throw new Error(`${PREFIX} metadata ${url}: HTTP ${response.status}`);
                }
            } catch (reason) {
                if (controller.signal.aborted) {
                    throw controller.signal.reason ?? abortError("manifest request aborted");
                }
                if (reason instanceof Error && reason.message.startsWith(PREFIX)) {
                    throw reason;
                }
                if (attempt >= (options.maxRetries ?? 2)) {
                    throw error(reason, `metadata ${url}: request failed`);
                }
            }
            await delay(Math.min(2000, 125 * 2 ** attempt) + (((attempt + 1) * 37) & 63), controller.signal);
        }
    } catch (reason) {
        options.signal?.removeEventListener("abort", abort);
        throw reason;
    }
    try {
        const maxCpuBytes = options.maxCpuBytes ?? 64 * 1024 * 1024;
        const declaredText = response.headers.get("content-length");
        if (declaredText !== null && (!/^(0|[1-9]\d*)$/.test(declaredText) || Number(declaredText) * 2 > maxCpuBytes)) {
            throw new Error(`${PREFIX} metadata ${url}: Content-Length exceeds maxCpuBytes admission`);
        }
        if (!response.body) {
            throw new Error(`${PREFIX} metadata ${url}: response has no body`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        let bytes = 0;
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) {
                    break;
                }
                bytes += part.value.byteLength;
                if (bytes * 2 > maxCpuBytes) {
                    throw new Error(`${PREFIX} metadata ${url}: streamed body exceeds maxCpuBytes admission`);
                }
                text += decoder.decode(part.value, { stream: true });
            }
            text += decoder.decode();
        } finally {
            reader.releaseLock();
        }
        return { value: JSON.parse(text) as unknown, url: response.url || url, bytes };
    } catch (reason) {
        throw error(reason, `metadata ${url}: invalid JSON`);
    } finally {
        options.signal?.removeEventListener("abort", abort);
    }
}

/** Loads and validates a streamed Gaussian hierarchy, then starts its coarse bootstrap. */
export async function loadGaussianSplatStream(engine: EngineContext, metadataUrl: string, options: GaussianSplatStreamOptions = {}): Promise<GaussianSplatStream> {
    const normalized = normalizeSplatStreamOptions(options);
    const runtime = options._runtime ?? {};
    const startedAt = runtime.now?.() ?? performance.now();
    if (normalized.signal?.aborted) {
        throw abortError("load aborted");
    }
    const loaded = await fetchManifest(metadataUrl, options);
    const manifest = parseSplatStreamManifest(loaded.value, loaded.url);
    const bootstrap = selectBootstrapSource(manifest.leaves, manifest.sources);
    const coarse = manifest.leaves.filter((leaf) => leaf.alternatives[0]!.fileId === bootstrap.id).reduce((sum, leaf) => sum + leaf.alternatives[0]!.count, 0);
    if (coarse > normalized.maxSplats) {
        throw new Error(`${PREFIX} bootstrap coarse representation (${coarse} splats) exceeds maxSplats (${normalized.maxSplats})`);
    }
    const retirement = createSplatSourceRetirement(engine);
    const ledger = createSplatStreamGpuLedger(normalized.maxGpuBytes, retirement);
    const gpu = (runtime.createGpuState ?? createSplatStreamGpuState)(engine, normalized.maxSplats, normalized.maxGpuBytes, ledger);
    const testableGpu = gpu as SplatStreamGpuState & { ledger?: typeof ledger; gpuBytes?: number };
    testableGpu.ledger ??= ledger;
    testableGpu.gpuBytes ??= 0;
    let streamRef: GaussianSplatStream | null = null;
    const requests: SplatStreamRequestManager =
        runtime.requestManager ??
        createSplatStreamRequestManager(normalized.maxConcurrentRequests, normalized.maxConcurrentDecodes, normalized.maxCpuBytes, normalized.maxRetries, {
            device: engine._device,
            fetch: runtime.fetch,
            decode: runtime.decode,
            delay: runtime.delay,
            isGenerationCurrent: (url, generation) => {
                const state = streamRef?._sourceStates.find((candidate) => candidate.source.url === url);
                return !!streamRef && !streamRef._disposed && state?.generation === generation;
            },
            gpuLedger: ledger,
            reserveGpuBytes: (_url, bytes) => {
                if (!streamRef || streamRef._disposed) {
                    return false;
                }
                refreshProtections(streamRef);
                return reserveSplatSourceGpuBytes(streamRef._cache, bytes, (entry) => forgetEvictedSplatStreamSource(streamRef!, entry.url));
            },
        });
    const stats = createStats();
    let resolveFirst!: () => void;
    let rejectFirst!: (reason: Error) => void;
    const firstFrameReady = new Promise<void>((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
    });
    const sourceStates: StreamSourceRuntime[] = manifest.sources.map((source) => ({
        source,
        generation: 0,
        demandCount: 0,
        state: "unrequested",
        gpu: null,
        request: null,
        error: null,
        blockedRequiredBytes: 0,
        blockedAllocatedBytes: -1,
        blockedHeldBytes: -1,
        blockedAdmissionVersion: -1,
    }));
    if (manifest.environmentUrl && !sourceStates.some((state) => state.source.url === manifest.environmentUrl)) {
        const id = sourceStates.length;
        sourceStates.push({
            source: { id, url: manifest.environmentUrl, consumers: [] },
            generation: 0,
            demandCount: 0,
            state: "unrequested",
            gpu: null,
            request: null,
            error: null,
            blockedRequiredBytes: 0,
            blockedAllocatedBytes: -1,
            blockedHeldBytes: -1,
            blockedAdmissionVersion: -1,
        });
    }
    const stream = initSceneNodeTransform<GaussianSplatStream>({
        name: "GaussianSplatStream",
        children: [],
        stats,
        firstFrameReady,
        boundMin: Array.from(manifest.root.boundMin) as [number, number, number],
        boundMax: Array.from(manifest.root.boundMax) as [number, number, number],
        maxSplats: normalized.maxSplats,
        screenError: normalized.screenError,
        _engine: engine,
        _options: normalized,
        _manifest: manifest,
        _leafStates: manifest.leaves.map((leaf): StreamLeafRuntime => ({
            visible: false,
            target: leaf.alternatives[0]!,
            displayed: null,
            pending: null,
            lastVisibleFrame: -1,
            selectionGeneration: 0,
        })),
        _sourceStates: sourceStates,
        _requests: requests,
        _cache: createSplatSourceCache(normalized.maxGpuBytes, normalized.maxCpuBytes, retirement, gpu.ledger),
        _gpu: gpu,
        _renderable: null,
        _generation: 1,
        _contentGeneration: 0,
        _frame: 0,
        _refinementEnabled: false,
        _coarseSubmitted: false,
        _disposed: false,
        _bootstrapSourceId: bootstrap.id,
        _startedAt: startedAt,
        _manifestBytes: loaded.bytes,
        _runtime: runtime,
        _firstFrameSettled: false,
    });
    streamRef = stream;
    (_firstFrames ??= new WeakMap()).set(stream, { resolve: resolveFirst, reject: rejectFirst });
    requestSource(stream, bootstrap.id, SplatRequestPriority.Bootstrap);
    return stream;
}

/** Attaches one stream to one scene. Repeating the same attachment is a no-op. */
export function attachGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void {
    if (stream._disposed) {
        throw new Error(`${PREFIX} attach: stream is disposed`);
    }
    if (scene.surface.engine !== stream._engine) {
        throw new Error(`${PREFIX} attach: scene and stream use different engines`);
    }
    const attachments = (_attachments ??= new WeakMap());
    const existing = attachments.get(stream);
    if (existing) {
        if (existing.scene !== scene) {
            throw new Error(`${PREFIX} attach: stream is already attached to another scene`);
        }
        return;
    }
    if (scene._built) {
        throw new Error(`${PREFIX} attach: attach before or during scene registration`);
    }
    const attachment: StreamAttachment = { scene, beforeRender: () => updateStats(stream), renderable: null, disposed: false };
    attachments.set(stream, attachment);
    scene._beforeRender.push(attachment.beforeRender);
    addDeferredSceneRenderables(scene, (_engine, owner) => {
        if (stream._disposed || attachment.disposed || owner !== scene) {
            return { renderables: [] };
        }
        const build = stream._runtime.buildRenderable ?? buildSplatStreamGpuRenderable;
        const renderable = build(
            stream._gpu,
            () => stream.worldMatrix,
            (context) => updateSelection(stream, context),
            (nonemptySignal) => coarseDrawn(stream, nonemptySignal)
        );
        attachment.renderable = renderable;
        stream._renderable = renderable;
        return {
            renderables: [renderable],
            dispose: () => disposeAttachedStream(scene, stream, attachment),
        };
    });
}

function disposeAttachedStream(scene: SceneContext, stream: GaussianSplatStream, attachment: StreamAttachment): void {
    if (attachment.disposed) {
        return;
    }
    attachment.disposed = true;
    const beforeIndex = scene._beforeRender.indexOf(attachment.beforeRender);
    if (beforeIndex >= 0) {
        scene._beforeRender.splice(beforeIndex, 1);
    }
    if (attachment.renderable) {
        const renderableIndex = scene._renderables.indexOf(attachment.renderable);
        if (renderableIndex >= 0) {
            scene._renderables.splice(renderableIndex, 1);
            scene._renderableVersion++;
        }
    }
    disposeStream(stream);
    _attachments?.delete(stream);
}

function disposeStream(stream: GaussianSplatStream): void {
    if (stream._disposed) {
        return;
    }
    stream._disposed = true;
    stream._generation++;
    stream.stats._values.phase = "disposed";
    for (const source of stream._sourceStates) {
        source.generation++;
        source.state = "disposed";
        source.request = null;
    }
    stream._requests.dispose();
    disposeSplatSourceCache(stream._cache);
    retireSplatStreamGpuState(stream._gpu);
    if (!stream._firstFrameSettled) {
        stream._firstFrameSettled = true;
        _firstFrames?.get(stream)?.reject(abortError("disposed before first frame"));
    }
    _firstFrames?.delete(stream);
}

/** Detaches and idempotently disposes a stream and its pending/resident resources. */
export function disposeGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void {
    const attachment = _attachments?.get(stream);
    if (attachment) {
        if (attachment.scene !== scene) {
            return;
        }
        disposeAttachedStream(scene, stream, attachment);
        return;
    }
    disposeStream(stream);
}
