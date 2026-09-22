import type { AssetContainer } from "../asset-container.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Texture2D } from "../texture/texture-2d.js";

/** Binary USD root or supporting-file input. */
export type UsdBinaryInput = ArrayBuffer | ArrayBufferView | Blob;

/** Progress of a USD import. OpenUSD extraction runs in a worker. */
export interface UsdProgress {
    phase: "fetching" | "initializing" | "staging" | "extracting" | "materializing";
    message: string;
}

/** Configuration for {@link loadUsd}. Paths in `files` share a virtual filesystem with `rootFileName`. */
export interface LoadUsdOptions {
    /** Relative virtual path of the root layer. Inferred from the URL or File when omitted. */
    rootFileName?: string;
    /** Referenced layers, payloads and textures. Preserve their authored relative paths and case. */
    files?: Readonly<Record<string, UsdBinaryInput>>;
    /** Allow conservative filename fallback for unresolved references. Default true. */
    resolveByFileName?: boolean;
    /** Directory containing the shared protocol-v5 worker, glue, WASM and data files. Defaults to the Babylon.js CDN. */
    runtimeBaseUrl?: string;
    /** Cancels fetching, extraction and materialization, releasing partial resources. */
    signal?: AbortSignal;
    /** Reports loading phases. Exceptions thrown by this callback reject the import. */
    onProgress?: (progress: UsdProgress) => void;
    /** Receives native OpenUSD diagnostics. */
    onLog?: (level: "info" | "warning" | "error", message: string) => void;
}

/** Native extraction durations, in milliseconds. */
export interface UsdTimings {
    totalMs: number;
    stageOpenMs: number;
    stageReadMs: number;
    preparationMs: number;
    packingMs: number;
    heapCopyMs: number;
}

/** Native source counts; material subsets can produce additional Lite meshes. */
export interface UsdStatistics {
    nodes: number;
    meshes: number;
    analyticPrimitives: number;
    instances: number;
    materials: number;
    vertices: number;
    triangles: number;
    commandBytes: number;
    dataBytes: number;
}

/** Import diagnostics. Missing external assets are reported by the OpenUSD resolver. */
export interface UsdDiagnostics {
    timings: UsdTimings & { materializeMs: number };
    statistics: UsdStatistics;
    missingAssets: readonly string[];
}

/** Scene-independent USD result. Pass to `addToScene`; remove before calling {@link disposeUsd}. */
export interface UsdAssetContainer extends AssetContainer {
    diagnostics: UsdDiagnostics;
    /** @internal Mesh claims owned by this import. */
    _usdMeshes: Mesh[];
    /** @internal Texture claims owned by this import. */
    _usdTextures: Texture2D[];
    /** @internal Guards repeated disposal and late asynchronous completions. */
    _usdDisposed?: boolean;
}

/** @internal Transferable result of the shared C++ extractor. */
export interface UsdExtraction {
    commands: ArrayBuffer;
    data: ArrayBuffer;
    timings: UsdTimings;
    statistics: UsdStatistics;
    missingAssets: string[];
}
