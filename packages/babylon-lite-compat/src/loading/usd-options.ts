import type { LoadUsdOptions, UsdDiagnostics, UsdProgress } from "babylon-lite";

import { unsupported } from "../error.js";

export type USDBinaryInput = ArrayBuffer | ArrayBufferView;
export type USDVirtualFiles = Readonly<Record<string, USDBinaryInput>>;
export type USDLoadProgress = Omit<UsdProgress, "phase"> & {
    phase: Exclude<UsdProgress["phase"], "fetching">;
};
export type USDImportTimings = UsdDiagnostics["timings"];
export type USDImportStatistics = UsdDiagnostics["statistics"];
export type USDImportDiagnostics = UsdDiagnostics;

export interface USDFileLoaderOptions {
    rootFileName?: string;
    files?: USDVirtualFiles;
    resolveByFileName?: boolean;
    workerUrl?: string | URL;
    glueUrl?: string;
    wasmUrl?: string;
    dataUrl?: string;
    onProgress?: (progress: USDLoadProgress) => void;
    onLog?: (level: "info" | "warning" | "error", message: string) => void;
    onComplete?: (diagnostics: USDImportDiagnostics) => void;
}

export const USD_RUNTIME_BASE_URL = "https://cdn.babylonjs.com/babylonUsdImporter/5/";
export const USD_RUNTIME_NAMES = {
    workerUrl: "babylon-usd-importer.worker.js",
    glueUrl: "babylon-usd-importer.js",
    wasmUrl: "babylon-usd-importer.wasm",
    dataUrl: "babylon-usd-importer.data",
} as const;

export type USDDefaultConfiguration = Required<Pick<USDFileLoaderOptions, "workerUrl" | "glueUrl" | "wasmUrl" | "dataUrl">>;

let defaultConfiguration: USDDefaultConfiguration | undefined;

export function getUsdDefaultConfiguration(): USDDefaultConfiguration {
    return (defaultConfiguration ??= {
        glueUrl: `${USD_RUNTIME_BASE_URL}${USD_RUNTIME_NAMES.glueUrl}`,
        wasmUrl: `${USD_RUNTIME_BASE_URL}${USD_RUNTIME_NAMES.wasmUrl}`,
        dataUrl: `${USD_RUNTIME_BASE_URL}${USD_RUNTIME_NAMES.dataUrl}`,
        workerUrl: `${USD_RUNTIME_BASE_URL}${USD_RUNTIME_NAMES.workerUrl}`,
    });
}

export function setUsdDefaultConfiguration(configuration: USDDefaultConfiguration): void {
    defaultConfiguration = configuration;
}

interface SceneLoaderProgressEvent {
    lengthComputable: boolean;
    loaded: number;
    total: number;
}

export function resolveUsdOptions(options: Partial<USDFileLoaderOptions>): USDFileLoaderOptions {
    const runtimeKeys = Object.keys(USD_RUNTIME_NAMES) as Array<keyof typeof USD_RUNTIME_NAMES>;
    const configured = runtimeKeys.filter((key) => options[key] !== undefined);
    if (configured.length !== 0 && configured.length !== 4) {
        unsupported(
            "USDFileLoaderOptions runtime URLs",
            "Babylon Lite loads the OpenUSD worker, glue, WASM, and data files from one runtime directory. Babylon.js runtime URL overrides can be adapted only when all four standard files are configured together."
        );
    }
    const defaults = getUsdDefaultConfiguration();
    return {
        ...defaults,
        ...options,
        workerUrl: options.workerUrl ?? defaults.workerUrl,
        glueUrl: options.glueUrl ?? defaults.glueUrl,
        wasmUrl: options.wasmUrl ?? defaults.wasmUrl,
        dataUrl: options.dataUrl ?? defaults.dataUrl,
    };
}

export function toLiteUsdOptions(options: Partial<USDFileLoaderOptions>, signal?: AbortSignal, onProgress?: (event: SceneLoaderProgressEvent) => void): LoadUsdOptions {
    const configured = (Object.keys(USD_RUNTIME_NAMES) as Array<keyof typeof USD_RUNTIME_NAMES>).filter((key) => options[key] !== undefined);

    let runtimeBaseUrl: string | undefined;
    for (const key of configured) {
        const url = new URL(String(options[key]), globalThis.location?.href ?? "http://localhost/");
        if (url.search || url.hash) {
            unsupported(
                `USDFileLoaderOptions.${key}`,
                "Babylon Lite reconstructs OpenUSD runtime file URLs from one directory and cannot preserve per-file query strings or hash fragments."
            );
        }
        if (!url.pathname.endsWith(`/${USD_RUNTIME_NAMES[key]}`)) {
            unsupported(
                `USDFileLoaderOptions.${key}`,
                `Babylon Lite loads the four OpenUSD runtime files from one directory using their standard names; '${USD_RUNTIME_NAMES[key]}' is required.`
            );
        }
        const candidate = new URL(".", url).href;
        if (runtimeBaseUrl !== undefined && candidate !== runtimeBaseUrl) {
            unsupported(
                "USDFileLoaderOptions runtime URLs",
                "Babylon Lite loads the OpenUSD worker, glue, WASM, and data files from one runtime directory; independently located runtime files cannot be adapted."
            );
        }
        runtimeBaseUrl = candidate;
    }

    return {
        rootFileName: options.rootFileName,
        files: options.files,
        resolveByFileName: options.resolveByFileName ?? true,
        runtimeBaseUrl,
        signal,
        onProgress: (progress) => {
            if (progress.phase !== "fetching") {
                options.onProgress?.({ phase: progress.phase, message: progress.message });
            }
            const loaded = progress.phase === "fetching" ? 0 : progress.phase === "initializing" ? 1 : progress.phase === "staging" ? 2 : progress.phase === "extracting" ? 3 : 4;
            onProgress?.({ lengthComputable: false, loaded, total: 4 });
        },
        onLog: options.onLog,
    };
}
