/** MeshLoD — public, tree-shakable opt-in feature facade.
 *
 *  MeshLoD preprocesses large static meshes into meshlets and a clustered
 *  level-of-detail hierarchy, selects meshlets from camera screen-space error, and
 *  renders them efficiently through material-owned indirect WebGPU draws.
 *
 *  Everything here is plain state plus standalone functions (Babylon Lite's
 *  one-way-ownership, pure-state style): assets and instances never hold a scene
 *  reference and never expose raw WebGPU handles. Importing this module has no
 *  side effects and pulls in no runtime, decoder, or material code — those chunks
 *  are dynamically imported only when {@link loadMeshLoD} is first called, so a
 *  scene that never uses MeshLoD fetches zero MeshLoD bytes. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { MeshLoDAssetRuntime, MeshLoDEffectiveSettings } from "./mesh-lod-runtime.js";
import type { MeshLoDError } from "./mesh-lod-errors.js";
import { createSceneNode } from "../scene/scene-node.js";
import { createMeshLoDError } from "./mesh-lod-errors.js";

export { isMeshLoDError } from "./mesh-lod-errors.js";
export type { MeshLoDError, MeshLoDErrorCode } from "./mesh-lod-errors.js";

// ─── Public types ────────────────────────────────────────────────────

/** A loadable MeshLoD source: a URL/path, or the full container bytes. */
export type MeshLoDSource = string | ArrayBuffer | Blob;

export type MeshLoDAssetState = "loading" | "ready" | "recovering" | "failed" | "disposed";

export type MeshLoDSelectionMode = "cpu" | "gpu";

export type MeshLoDDebugView = "none" | "meshlet-id" | "lod-depth" | "selected-group" | "page-residency" | "requested-pages" | "meshlet-cone";

/** Per-request fetch overrides applied to every range request for one asset. */
export interface MeshLoDRequestOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
}

/** Options for {@link loadMeshLoD}. All numeric limits are validated before any
 *  network work begins; invalid values throw `MLOD_INVALID_OPTION`. */
export interface MeshLoDLoadOptions {
    readonly screenSpaceError?: number;
    readonly lodHysteresis?: number;
    readonly residencyHoldFrames?: number;
    readonly obsoleteRequestGraceFrames?: number;
    readonly cacheBudgetBytes?: number;
    readonly cacheCapacityBytes?: number;
    readonly cpuPageCacheBytes?: number;
    readonly maxConcurrentRequests?: number;
    readonly retryCount?: number;
    readonly retryDelaysMs?: readonly number[];
    readonly selectionMode?: MeshLoDSelectionMode;
    readonly request?: MeshLoDRequestOptions;
    readonly signal?: AbortSignal;
}

/** Immutable provenance and hierarchy summary parsed from the `.mlod` header. */
export interface MeshLoDMetadata {
    readonly formatMajor: number;
    readonly formatMinor: number;
    readonly toolVersion: string;
    readonly meshoptimizerRevision: string;
    readonly cgltfRevision: string;
    readonly sourceSha256: string;
    readonly buildFingerprintSha256: string;
    readonly meshIndex: number;
    readonly primitiveIndex: number;
    readonly sourceTriangleCount: number;
    readonly hierarchyTriangleCount: number;
    readonly clusterCount: number;
    readonly groupCount: number;
    readonly hierarchyNodeCount: number;
    readonly hierarchyDepth: number;
    readonly pageCount: number;
    readonly pinnedPageCount: number;
    readonly boundsMin: readonly [number, number, number];
    readonly boundsMax: readonly [number, number, number];
}

/** Live, read-only diagnostics snapshot for one asset (updated each frame). */
export interface MeshLoDDiagnostics {
    readonly frameIndex: number;
    readonly sourceTriangleCount: number;
    readonly renderedTriangleCount: number;
    readonly selectedMeshletCount: number;
    readonly visibleGroupCount: number;
    readonly fallbackGroupCount: number;
    readonly maximumSelectedErrorPixels: number;
    readonly maximumUnmetErrorPixels: number;
    readonly requestedPageCount: number;
    readonly queuedPageCount: number;
    readonly inFlightPageCount: number;
    readonly residentPageCount: number;
    readonly pinnedPageCount: number;
    readonly terminalFailedPageCount: number;
    readonly downloadedBytes: number;
    readonly gpuCacheUsedBytes: number;
    readonly gpuCacheBudgetBytes: number;
    readonly gpuCacheCapacityBytes: number;
    readonly cpuPageCacheUsedBytes: number;
    readonly maxConcurrentRequests: number;
    readonly streamingPaused: boolean;
    readonly selectionMode: MeshLoDSelectionMode;
}

/** A loaded MeshLoD asset: immutable metadata plus mutable runtime state. It
 *  holds no scene reference; scenes own registered instances. */
export interface MeshLoDAsset {
    readonly metadata: MeshLoDMetadata;
    readonly diagnostics: MeshLoDDiagnostics;
    state: MeshLoDAssetState;
    error?: MeshLoDError;
    /** @internal */ _runtime: MeshLoDAssetRuntime;
}

/** Options for {@link createMeshLoDInstance}. */
export interface MeshLoDInstanceOptions {
    readonly name?: string;
    readonly visible?: boolean;
    readonly screenSpaceError?: number;
}

/** A placed instance of an asset: plain `SceneNode` state carrying its immutable
 *  asset and material. Multiple instances can share one asset. */
export interface MeshLoDInstance extends SceneNode {
    readonly asset: MeshLoDAsset;
    readonly material: PbrMaterialProps;
    visible: boolean;
    screenSpaceError?: number;
    /** @internal */ _asset: MeshLoDAsset;
    /** @internal */ _material: PbrMaterialProps;
    /** @internal */ _instanceId: number;
}

// ─── Defaults ────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
const DEFAULT_SCREEN_SPACE_ERROR = 2.0;
const DEFAULT_LOD_HYSTERESIS = 0.15;
const DEFAULT_RESIDENCY_HOLD_FRAMES = 120;
const DEFAULT_OBSOLETE_REQUEST_GRACE_FRAMES = 2;
const DEFAULT_CACHE_BUDGET_BYTES = 128 * MIB;
const DEFAULT_CACHE_CAPACITY_BYTES = 128 * MIB;
const DEFAULT_CPU_PAGE_CACHE_BYTES = 64 * MIB;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_SELECTION_MODE: MeshLoDSelectionMode = "gpu";

// ─── Option validation ───────────────────────────────────────────────

function invalidOption(name: string, requirement: string, actual: number | string): MeshLoDError {
    return createMeshLoDError("MLOD_INVALID_OPTION", `${name} must be ${requirement}`, { expected: requirement, actual });
}

function resolveFinitePositive(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isFinite(value) || value <= 0) {
        throw invalidOption(name, "a finite number > 0", value);
    }
    return value;
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isInteger(value) || value < 0) {
        throw invalidOption(name, "a non-negative integer", value);
    }
    return value;
}

function resolveSelectionMode(mode: MeshLoDSelectionMode | undefined): MeshLoDSelectionMode {
    const value = mode ?? DEFAULT_SELECTION_MODE;
    if (value !== "cpu" && value !== "gpu") {
        throw invalidOption("selectionMode", '"cpu" or "gpu"', String(value));
    }
    return value;
}

/** @internal Validate load options and apply defaults. Exposed for unit tests;
 *  the `@internal` tag strips it from the trimmed public declarations. Runs fully
 *  before any network work, so invalid options reject without loading the runtime. */
export function _resolveMeshLoDLoadOptions(options?: MeshLoDLoadOptions): MeshLoDEffectiveSettings {
    const screenSpaceError = resolveFinitePositive(options?.screenSpaceError, DEFAULT_SCREEN_SPACE_ERROR, "screenSpaceError");

    let lodHysteresis = DEFAULT_LOD_HYSTERESIS;
    if (options?.lodHysteresis !== undefined) {
        if (!Number.isFinite(options.lodHysteresis) || options.lodHysteresis < 0 || options.lodHysteresis >= 1) {
            throw invalidOption("lodHysteresis", "a fraction in [0, 1)", options.lodHysteresis);
        }
        lodHysteresis = options.lodHysteresis;
    }

    const residencyHoldFrames = resolveNonNegativeInteger(options?.residencyHoldFrames, DEFAULT_RESIDENCY_HOLD_FRAMES, "residencyHoldFrames");
    const obsoleteRequestGraceFrames = resolveNonNegativeInteger(options?.obsoleteRequestGraceFrames, DEFAULT_OBSOLETE_REQUEST_GRACE_FRAMES, "obsoleteRequestGraceFrames");

    const cacheCapacityBytes = resolveFinitePositive(options?.cacheCapacityBytes, DEFAULT_CACHE_CAPACITY_BYTES, "cacheCapacityBytes");
    const cacheBudgetBytes = resolveFinitePositive(options?.cacheBudgetBytes, Math.min(DEFAULT_CACHE_BUDGET_BYTES, cacheCapacityBytes), "cacheBudgetBytes");
    if (cacheBudgetBytes > cacheCapacityBytes) {
        throw invalidOption("cacheBudgetBytes", "<= cacheCapacityBytes", cacheBudgetBytes);
    }

    const cpuPageCacheBytes = resolveFinitePositive(options?.cpuPageCacheBytes, DEFAULT_CPU_PAGE_CACHE_BYTES, "cpuPageCacheBytes");

    let maxConcurrentRequests = DEFAULT_MAX_CONCURRENT_REQUESTS;
    if (options?.maxConcurrentRequests !== undefined) {
        if (!Number.isInteger(options.maxConcurrentRequests) || options.maxConcurrentRequests < 1) {
            throw invalidOption("maxConcurrentRequests", "an integer >= 1", options.maxConcurrentRequests);
        }
        maxConcurrentRequests = options.maxConcurrentRequests;
    }

    const retryCount = resolveNonNegativeInteger(options?.retryCount, DEFAULT_RETRY_COUNT, "retryCount");

    let retryDelaysMs: readonly number[] = [250, 1000];
    if (options?.retryDelaysMs !== undefined) {
        if (!Array.isArray(options.retryDelaysMs) || options.retryDelaysMs.some((d) => !Number.isFinite(d) || d < 0)) {
            throw invalidOption("retryDelaysMs", "an array of non-negative finite numbers", String(options.retryDelaysMs));
        }
        retryDelaysMs = options.retryDelaysMs.slice();
    }

    return {
        screenSpaceError,
        lodHysteresis,
        residencyHoldFrames,
        obsoleteRequestGraceFrames,
        cacheBudgetBytes,
        cacheCapacityBytes,
        cpuPageCacheBytes,
        maxConcurrentRequests,
        retryCount,
        retryDelaysMs,
    };
}

// ─── Lazy runtime plumbing ───────────────────────────────────────────

type MeshLoDRuntimeModule = typeof import("./mesh-lod-runtime.js");

/** Cached runtime module, populated on the first {@link loadMeshLoD}. Nullable
 *  lazy cache only — no module-level collection or eager import. */
let _runtimeModule: MeshLoDRuntimeModule | null = null;

function requireRuntime(): MeshLoDRuntimeModule {
    const runtime = _runtimeModule;
    if (!runtime) {
        // Unreachable in correct usage: a live asset/instance implies loadMeshLoD
        // already resolved and populated the cache.
        throw createMeshLoDError("MLOD_DISPOSED", "MeshLoD runtime is not loaded; call loadMeshLoD before registering instances");
    }
    return runtime;
}

// ─── Public functions ────────────────────────────────────────────────

/** Load, validate, and prepare a MeshLoD asset. Resolves only after the header,
 *  directory, required metadata, hierarchy validation, and pinned coarse pages
 *  are validated, decoded, and uploaded; fine pages stream afterwards. Invalid
 *  options reject with `MLOD_INVALID_OPTION` before any network work. */
export async function loadMeshLoD(engine: EngineContext, source: MeshLoDSource, options?: MeshLoDLoadOptions): Promise<MeshLoDAsset> {
    const settings = _resolveMeshLoDLoadOptions(options);
    const selectionMode = resolveSelectionMode(options?.selectionMode);
    const runtime = (_runtimeModule ??= await import("./mesh-lod-runtime.js"));
    return runtime._loadMeshLoD(engine, source, settings, selectionMode, options?.request, options?.signal);
}

/** Create a placed instance of an asset using a supported opaque PBR material.
 *  Unsupported material state throws `MLOD_UNSUPPORTED_MATERIAL`. */
export function createMeshLoDInstance(asset: MeshLoDAsset, material: PbrMaterialProps, options?: MeshLoDInstanceOptions): MeshLoDInstance {
    if (material.alphaBlend === true) {
        throw createMeshLoDError("MLOD_UNSUPPORTED_MATERIAL", "MeshLoD requires an opaque PBR material; alpha blending is not supported", {
            expected: "opaque",
            actual: "alphaBlend",
        });
    }

    type MeshLoDInstanceMutable = { -readonly [K in keyof MeshLoDInstance]: MeshLoDInstance[K] };
    const instance = createSceneNode(options?.name ?? "meshLoD") as unknown as MeshLoDInstanceMutable;
    instance.asset = asset;
    instance._asset = asset;
    instance.material = material;
    instance._material = material;
    instance.visible = options?.visible ?? true;
    instance.screenSpaceError = options?.screenSpaceError;
    instance._instanceId = asset._runtime.nextInstanceId;
    asset._runtime.nextInstanceId += 1;
    return instance as MeshLoDInstance;
}

/** Register an instance into a scene. Idempotent for the same scene/instance;
 *  does not write a scene reference into the instance. */
export function addMeshLoDToScene(scene: SceneContext, instance: MeshLoDInstance): void {
    requireRuntime()._addMeshLoDToScene(scene, instance);
}

/** Remove an instance from a scene. Idempotent; the instance stops being
 *  selected or submitted immediately. */
export function removeMeshLoDFromScene(scene: SceneContext, instance: MeshLoDInstance): void {
    requireRuntime()._removeMeshLoDFromScene(scene, instance);
}

/** Set the target screen-space error (pixels) for an asset. */
export function setMeshLoDScreenSpaceError(asset: MeshLoDAsset, pixels: number): void {
    if (!Number.isFinite(pixels) || pixels <= 0) {
        throw invalidOption("screenSpaceError", "a finite number > 0", pixels);
    }
    asset._runtime.settings.screenSpaceError = pixels;
}

/** Set the effective GPU residency budget (bytes). Must not exceed the immutable
 *  arena capacity chosen at load. Takes effect on the next streaming step, which trims
 *  resident fine pages down to the new budget and gates further uploads. */
export function setMeshLoDCacheBudget(asset: MeshLoDAsset, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw invalidOption("cacheBudgetBytes", "a finite number > 0", bytes);
    }
    if (bytes > asset._runtime.settings.cacheCapacityBytes) {
        throw invalidOption("cacheBudgetBytes", "<= cacheCapacityBytes", bytes);
    }
    asset._runtime.settings.cacheBudgetBytes = bytes;
    (asset.diagnostics as { gpuCacheBudgetBytes: number }).gpuCacheBudgetBytes = bytes;
}

/** Pause or resume fine-page streaming. Coarse rendering, resident geometry, and the
 *  coarse fallback are unaffected; pausing only suppresses new fine requests and
 *  retries. Resuming pumps queued work on the next streaming step. */
export function setMeshLoDStreamingPaused(asset: MeshLoDAsset, paused: boolean): void {
    asset._runtime.streamingPaused = paused;
    (asset.diagnostics as { streamingPaused: boolean }).streamingPaused = paused;
}

/** Select a diagnostic debug view (or `"none"`). */
export function setMeshLoDDebugView(asset: MeshLoDAsset, view: MeshLoDDebugView): void {
    asset._runtime.debugView = view;
}

/** Choose CPU (reference/diagnostic) or GPU (production) selection. */
export function setMeshLoDSelectionMode(asset: MeshLoDAsset, mode: MeshLoDSelectionMode): void {
    asset._runtime.selectionMode = resolveSelectionMode(mode);
}

/** Return the asset's live, read-only diagnostics object. */
export function getMeshLoDDiagnostics(asset: MeshLoDAsset): MeshLoDDiagnostics {
    return asset.diagnostics;
}

/** Dispose an asset: abort outstanding work, invalidate completions, mark scene batches
 *  non-drawable, retire the GPU arena/selection buffers after frame safety, release
 *  retained CPU bytes, and mark it disposed. Idempotent. Does not dispose an asset still
 *  used by another scene — that is scene disposal's concern. */
export function disposeMeshLoDAsset(asset: MeshLoDAsset): void {
    const runtime = asset._runtime;
    if (runtime.disposed) {
        return;
    }
    runtime.disposed = true;
    runtime.generation += 1;
    runtime.abortController.abort();
    const mod = _runtimeModule;
    mod?._disposeMeshLoDScheduler(runtime);
    mod?._disposeMeshLoDResources(runtime);
    asset.state = "disposed";
}
