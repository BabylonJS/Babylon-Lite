import type { EngineContext } from "../engine/engine.js";
import type { DrawUpdateContext, Renderable } from "../render/renderable.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SplatSourceCache } from "./splat-stream-cache.js";
import type { SplatStreamGpuState, SplatStreamSourceGpu } from "./splat-stream-gpu.js";
import type { PreparedSplatSource, SplatStreamRequestDependencies, SplatStreamRequestManager } from "./splat-stream-requests.js";
import type { SplatStreamGpuLedger } from "./splat-stream-gpu-ledger.js";

export interface GaussianSplatStreamOptions {
    maxSplats?: number;
    maxGpuBytes?: number;
    maxCpuBytes?: number;
    maxConcurrentRequests?: number;
    maxConcurrentDecodes?: number;
    screenError?: number;
    lodHysteresis?: number;
    maxRetries?: number;
    signal?: AbortSignal;
    /** @internal Controlled runtime seams used by focused tests. */
    _runtime?: SplatStreamRuntimeDependencies;
}

export type GaussianSplatStreamPhase = "bootstrap" | "streaming" | "idle" | "budget-limited" | "error" | "disposed";

export interface GaussianSplatStreamStats {
    readonly phase: GaussianSplatStreamPhase;
    readonly visibleLeaves: number;
    readonly coveredLeaves: number;
    readonly targetLeaves: number;
    readonly selectedSplats: number;
    readonly residentFiles: number;
    readonly queuedFiles: number;
    readonly pendingRequests: number;
    readonly residentGpuBytes: number;
    readonly allocatedGpuBytes: number;
    readonly fetchedBytes: number;
    readonly firstFrameMs: number | null;
    readonly error: Error | null;
    /** @internal Mutable backing values for the public readonly snapshot. */
    readonly _values: GaussianSplatStreamStatsSnapshot;
}

/** @internal */
export interface GaussianSplatStreamStatsSnapshot {
    phase: GaussianSplatStreamPhase;
    visibleLeaves: number;
    coveredLeaves: number;
    targetLeaves: number;
    selectedSplats: number;
    residentFiles: number;
    queuedFiles: number;
    pendingRequests: number;
    residentGpuBytes: number;
    allocatedGpuBytes: number;
    fetchedBytes: number;
    firstFrameMs: number | null;
    error: Error | null;
}

/** @internal */
export interface StreamLeafRuntime {
    visible: boolean;
    target: StreamRepresentation;
    displayed: StreamRepresentation | null;
    pending: StreamRepresentation | null;
    lastVisibleFrame: number;
    selectionGeneration: number;
}

/** @internal */
export interface StreamSourceRuntime {
    readonly source: StreamSource;
    generation: number;
    demandCount: number;
    state: "unrequested" | "queued" | "resident" | "blocked" | "failed" | "disposed";
    gpu: SplatStreamSourceGpu | null;
    request: Promise<void> | null;
    error: Error | null;
    blockedRequiredBytes: number;
    blockedAllocatedBytes: number;
    blockedHeldBytes: number;
    blockedAdmissionVersion: number;
}

/** @internal */
export interface SplatStreamRuntimeDependencies {
    readonly fetch?: typeof globalThis.fetch;
    readonly decode?: SplatStreamRequestDependencies["decode"];
    readonly delay?: SplatStreamRequestDependencies["delay"];
    readonly now?: () => number;
    readonly queueDone?: (engine: EngineContext) => Promise<unknown>;
    readonly createGpuState?: (engine: EngineContext, capacity: number, maxGpuBytes: number, ledger?: SplatStreamGpuLedger) => SplatStreamGpuState;
    readonly buildRenderable?: (
        state: SplatStreamGpuState,
        worldMatrix: () => ArrayLike<number>,
        update: (context: DrawUpdateContext) => void,
        draw: (nonemptySignal: Promise<boolean> | null) => void
    ) => Renderable;
    readonly requestManager?: SplatStreamRequestManager;
    readonly prepareSource?: (source: StreamSource, generation: number, priority: number, intervals: readonly SogInterval[]) => Promise<PreparedSplatSource>;
}

export interface GaussianSplatStream extends SceneNode {
    readonly stats: GaussianSplatStreamStats;
    readonly firstFrameReady: Promise<void>;
    readonly boundMin: readonly [number, number, number];
    readonly boundMax: readonly [number, number, number];
    maxSplats: number;
    screenError: number;
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _options: NormalizedSplatStreamOptions;
    /** @internal */
    readonly _manifest: StreamManifest;
    /** @internal */
    readonly _leafStates: StreamLeafRuntime[];
    /** @internal */
    readonly _sourceStates: StreamSourceRuntime[];
    /** @internal */
    readonly _requests: SplatStreamRequestManager;
    /** @internal */
    readonly _cache: SplatSourceCache;
    /** @internal */
    _gpu: SplatStreamGpuState;
    /** @internal */
    _renderable: Renderable | null;
    /** @internal */
    _generation: number;
    /** @internal */
    _contentGeneration: number;
    /** @internal */
    _frame: number;
    /** @internal */
    _refinementEnabled: boolean;
    /** @internal */
    _coarseSubmitted: boolean;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    readonly _bootstrapSourceId: number;
    /** @internal */
    readonly _startedAt: number;
    /** @internal */
    readonly _manifestBytes: number;
    /** @internal */
    readonly _runtime: SplatStreamRuntimeDependencies;
    /** @internal */
    _firstFrameSettled: boolean;
}

/** @internal */
export interface NormalizedSplatStreamOptions {
    readonly maxSplats: number;
    readonly maxGpuBytes: number;
    readonly maxCpuBytes: number;
    readonly maxConcurrentRequests: number;
    readonly maxConcurrentDecodes: number;
    readonly screenError: number;
    readonly lodHysteresis: number;
    readonly maxRetries: number;
    readonly signal: AbortSignal | undefined;
}

/** @internal */
export interface StreamRepresentation {
    readonly leafId: number;
    readonly lod: number;
    readonly fileId: number;
    readonly offset: number;
    readonly count: number;
    readonly error: number;
}

/** @internal */
export interface StreamBound {
    readonly boundMin: Float32Array;
    readonly boundMax: Float32Array;
    readonly center: Float32Array;
    readonly radius: number;
}

/** @internal */
export interface StreamLeaf extends StreamBound {
    readonly kind: "leaf";
    readonly id: number;
    readonly alternatives: readonly StreamRepresentation[];
}

/** @internal */
export interface StreamBranch extends StreamBound {
    readonly kind: "branch";
    readonly children: readonly StreamTreeNode[];
}

/** @internal */
export type StreamTreeNode = StreamBranch | StreamLeaf;

/** @internal */
export interface StreamSource {
    readonly id: number;
    readonly url: string;
    readonly consumers: readonly StreamRepresentation[];
}

/** @internal */
export interface StreamManifest {
    readonly lodLevels: number;
    readonly root: StreamTreeNode;
    readonly leaves: readonly StreamLeaf[];
    readonly sources: readonly StreamSource[];
    readonly environmentUrl: string | null;
}

/** @internal */
export interface SogV2SourceMetadata {
    readonly count: number;
    readonly meansMin: Float32Array;
    readonly meansMax: Float32Array;
    readonly scaleCodebook: Float32Array;
    readonly sh0Codebook: Float32Array;
    readonly imageUrls: readonly [string, string, string, string, string];
}

/** @internal */
export interface SogImageInfo {
    readonly width: number;
    readonly height: number;
    readonly mimeType?: string;
    readonly url?: string;
}

/** @internal */
export interface SogInterval {
    readonly offset: number;
    readonly count: number;
}

/** @internal */
export interface FrustumPlane {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
}

/** @internal */
export interface StreamSelectionInput {
    readonly root: StreamTreeNode;
    readonly worldMatrix: ArrayLike<number>;
    readonly viewProjectionMatrix: ArrayLike<number>;
    readonly projectionP11: number;
    readonly cameraPosition: ArrayLike<number>;
    readonly targetHeight: number;
    readonly near: number;
    readonly maxSplats: number;
    readonly screenError: number;
    readonly lodHysteresis: number;
    readonly previousTargets?: ReadonlyMap<number, StreamRepresentation>;
    readonly hardBudgetPressure?: boolean;
    readonly perspective?: boolean;
}

/** @internal */
export interface StreamSelection {
    readonly leaf: StreamLeaf;
    readonly target: StreamRepresentation;
    readonly projectedError: number;
}

/** @internal */
export interface StreamSelectionPlan {
    readonly selections: readonly StreamSelection[];
    readonly visibleLeaves: number;
    readonly selectedSplats: number;
}

function positiveSafeInteger(value: number | undefined, fallback: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
        throw new RangeError(`[GaussianSplatStream] ${name} must be a positive safe integer${max < Number.MAX_SAFE_INTEGER ? ` no greater than ${max}` : ""}`);
    }
    return resolved;
}

/** @internal Validates options before metadata-sized allocations are made. */
export function normalizeSplatStreamOptions(options: GaussianSplatStreamOptions = {}): NormalizedSplatStreamOptions {
    const screenError = options.screenError ?? 2;
    if (!Number.isFinite(screenError) || screenError <= 0) {
        throw new RangeError("[GaussianSplatStream] screenError must be finite and greater than zero");
    }
    const lodHysteresis = options.lodHysteresis ?? 0.15;
    if (!Number.isFinite(lodHysteresis) || lodHysteresis < 0 || lodHysteresis > 1) {
        throw new RangeError("[GaussianSplatStream] lodHysteresis must be finite and in 0..1");
    }
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
        throw new RangeError("[GaussianSplatStream] maxRetries must be a safe integer in 0..8");
    }
    return {
        maxSplats: positiveSafeInteger(options.maxSplats, 1_000_000, "maxSplats"),
        maxGpuBytes: positiveSafeInteger(options.maxGpuBytes, 256 * 1024 * 1024, "maxGpuBytes"),
        maxCpuBytes: positiveSafeInteger(options.maxCpuBytes, 64 * 1024 * 1024, "maxCpuBytes"),
        maxConcurrentRequests: positiveSafeInteger(options.maxConcurrentRequests, 6, "maxConcurrentRequests", 32),
        maxConcurrentDecodes: positiveSafeInteger(options.maxConcurrentDecodes, 2, "maxConcurrentDecodes", 8),
        screenError,
        lodHysteresis,
        maxRetries,
        signal: options.signal,
    };
}
