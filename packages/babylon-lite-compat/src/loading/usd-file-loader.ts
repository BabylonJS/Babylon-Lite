import { addToScene, disposeUsd, loadUsd } from "babylon-lite";
import type { AnimationGroup, UsdBinaryInput } from "babylon-lite";

import type { Mesh } from "../meshes/meshes.js";
import type { Scene } from "../scene/scene.js";
import type { Skeleton } from "../bones/skeleton.js";
import { AssetContainer, type ISceneLoaderProgressEvent } from "./scene-loader.js";
import { getUsdDefaultConfiguration, resolveUsdOptions, setUsdDefaultConfiguration, toLiteUsdOptions } from "./usd-options.js";
import type { USDFileLoaderOptions } from "./usd-options.js";
export type { USDBinaryInput, USDVirtualFiles, USDLoadProgress, USDImportTimings, USDImportStatistics, USDImportDiagnostics, USDFileLoaderOptions } from "./usd-options.js";

function requireBinary(data: unknown): UsdBinaryInput {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        throw new Error("USDFileLoader expects binary USD data.");
    }
    return data;
}

interface USDImportResult {
    meshes: Mesh[];
    particleSystems: unknown[];
    skeletons: Skeleton[];
    animationGroups: AnimationGroup[];
    transformNodes: unknown[];
    lights: unknown[];
}

export class USDFileLoader {
    public static get DefaultConfiguration(): Required<Pick<USDFileLoaderOptions, "workerUrl" | "glueUrl" | "wasmUrl" | "dataUrl">> {
        return getUsdDefaultConfiguration();
    }

    public static set DefaultConfiguration(configuration: Required<Pick<USDFileLoaderOptions, "workerUrl" | "glueUrl" | "wasmUrl" | "dataUrl">>) {
        setUsdDefaultConfiguration(configuration);
    }

    public readonly name = "usd";
    public readonly extensions = {
        ".usd": { isBinary: true },
        ".usda": { isBinary: true },
        ".usdc": { isBinary: true },
        ".usdz": { isBinary: true },
    } as const;

    private readonly _options: USDFileLoaderOptions;
    private readonly _activeLoads = new Set<AbortController>();

    public constructor(options: Partial<USDFileLoaderOptions> = {}) {
        this._options = { ...getUsdDefaultConfiguration(), ...options };
    }

    public createPlugin(options: { usd?: Partial<USDFileLoaderOptions> }): USDFileLoader {
        return new USDFileLoader(options.usd);
    }

    public async importMeshAsync(
        _meshNames: string | readonly string[] | null | undefined,
        scene: Scene,
        data: unknown,
        _rootUrl: string,
        onProgress?: (event: ISceneLoaderProgressEvent) => void,
        fileName?: string
    ): Promise<USDImportResult> {
        const container = await this._load(scene, data, onProgress, fileName, true);
        return {
            meshes: container.meshes,
            particleSystems: [],
            skeletons: container.skeletons,
            animationGroups: container.animationGroups,
            transformNodes: [],
            lights: [],
        };
    }

    public async loadAsync(scene: Scene, data: unknown, _rootUrl: string, onProgress?: (event: ISceneLoaderProgressEvent) => void, fileName?: string): Promise<void> {
        await this._load(scene, data, onProgress, fileName, true);
    }

    public async loadAssetContainerAsync(
        scene: Scene,
        data: unknown,
        _rootUrl: string,
        onProgress?: (event: ISceneLoaderProgressEvent) => void,
        fileName?: string
    ): Promise<AssetContainer> {
        return this._load(scene, data, onProgress, fileName, false);
    }

    public dispose(): void {
        const error = new Error("USDFileLoader was disposed.");
        for (const controller of this._activeLoads) {
            controller.abort(error);
        }
        this._activeLoads.clear();
    }

    private async _load(
        scene: Scene,
        data: unknown,
        onProgress: ((event: ISceneLoaderProgressEvent) => void) | undefined,
        fileName: string | undefined,
        add: boolean
    ): Promise<AssetContainer> {
        const controller = new AbortController();
        this._activeLoads.add(controller);
        try {
            const lite = await loadUsd(
                scene.getEngine()._lite,
                requireBinary(data),
                toLiteUsdOptions(resolveUsdOptions({ ...this._options, rootFileName: this._options.rootFileName ?? fileName }), controller.signal, onProgress)
            );
            const container = new AssetContainer(lite, () => disposeUsd(lite));
            try {
                controller.signal.throwIfAborted();
                if (add) {
                    addToScene(scene._lite, lite);
                    container._adoptScene(scene);
                }
                this._options.onComplete?.(lite.diagnostics);
                controller.signal.throwIfAborted();
                return container;
            } catch (error) {
                container.dispose();
                throw error;
            }
        } finally {
            this._activeLoads.delete(controller);
        }
    }
}

export function RegisterUSDFileLoader(): void {}
