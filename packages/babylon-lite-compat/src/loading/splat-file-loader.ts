import { loadSOG, loadSPZ, loadSplat } from "babylon-lite";
import type { GaussianSplattingMesh as LiteGaussianSplattingMesh, GsShaderFragment, SceneContext } from "babylon-lite";

import { unsupported } from "../error.js";
import { GaussianSplattingMesh } from "../meshes/gaussian-splatting.js";
import type { Scene } from "../scene/scene.js";
import type { AssetContainer, ISceneLoaderProgressEvent } from "./scene-loader.js";

export type SPLATLoadingOptions = {
    keepInRam?: boolean;
    flipY?: boolean;
    deflateURL?: string;
    fflate?: unknown;
    disableAutoCameraLimits?: boolean;
    gaussianSplattingMesh?: GaussianSplattingMesh;
    needsRotationScaleTextures?: boolean;
    useSogTextures?: boolean;
    spzLibraryUrl?: string;
};

interface SPLATImportResult {
    meshes: GaussianSplattingMesh[];
    particleSystems: unknown[];
    skeletons: unknown[];
    animationGroups: unknown[];
    transformNodes: unknown[];
    geometries: unknown[];
    lights: unknown[];
    spriteManagers: unknown[];
}

type LiteSplatLoader = (scene: SceneContext, url: string, fragments?: readonly GsShaderFragment[]) => Promise<LiteGaussianSplattingMesh>;

const SPLAT_ASSET_CONTAINER_UNSUPPORTED =
    "Lite's splat loaders attach the GPU-backed cloud directly to a scene. They do not expose a detached Gaussian-Splatting asset-container lifecycle that can preserve the BJS mesh type.";
const SPLAT_STREAMING_UNSUPPORTED =
    "PlayCanvas lod-meta.json requires Babylon.js's Gaussian-Splatting streaming residency, download scheduling, and GPU work-buffer subsystem, which Babylon Lite does not define.";
const SPLAT_DIRECTORY_UNSUPPORTED =
    "Directory SOG JSON requires a loader contract for resolving and decoding external texture resources relative to rootUrl; Lite's SOG loader accepts only self-contained archives.";
const SPLAT_RELOAD_UNSUPPORTED =
    "Lite does not expose an atomic Gaussian-Splatting replacement lifecycle that detaches the old renderable and picker while retiring its worker and GPU resources.";
const SPLAT_CONCURRENT_TARGET_UNSUPPORTED = "An unloaded GaussianSplattingMesh target can only be populated by one in-flight load.";

let loadingTargets: WeakSet<GaussianSplattingMesh> | undefined;

function bytesOf(data: unknown): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return unsupported("SPLATFileLoader", "Binary .splat, .ply, .sog, and .spz inputs must be supplied as an ArrayBuffer or ArrayBufferView.");
}

function loaderFor(data: unknown): LiteSplatLoader {
    if (typeof data === "string") {
        return unsupported("SPLATFileLoader", data.includes('"lods"') ? SPLAT_STREAMING_UNSUPPORTED : SPLAT_DIRECTORY_UNSUPPORTED);
    }
    const bytes = bytesOf(data);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        return loadSOG;
    }
    if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || (bytes[0] === 0x4e && bytes[1] === 0x47 && bytes[2] === 0x53 && bytes[3] === 0x50)) {
        return loadSPZ;
    }
    return loadSplat;
}

function loaderForUrl(url: string): LiteSplatLoader {
    const path = url.split(/[?#]/)[0]!.toLowerCase();
    if (path.endsWith(".json")) {
        return unsupported("SPLATFileLoader", SPLAT_STREAMING_UNSUPPORTED);
    }
    if (path.endsWith(".sog")) {
        return loadSOG;
    }
    if (path.endsWith(".spz")) {
        return loadSPZ;
    }
    return loadSplat;
}

function binaryData(data: unknown): BlobPart {
    return new Uint8Array(bytesOf(data)).buffer;
}

function validateOptions(options: Readonly<SPLATLoadingOptions>): void {
    if (options.flipY === true) {
        unsupported("SPLATLoadingOptions.flipY", "Lite's native splat parsers own their format-specific orientation conversion and do not expose a parser-level flipY override.");
    }
    if (options.deflateURL !== undefined || options.fflate !== undefined) {
        unsupported("SPLATLoadingOptions.fflate", "Lite owns its SOG decompressor and does not expose Babylon.js's replaceable fflate loading policy.");
    }
    if (options.needsRotationScaleTextures) {
        unsupported(
            "SPLATLoadingOptions.needsRotationScaleTextures",
            "Voxel IBL-shadow rotation/scale textures require Babylon.js's Gaussian-Splatting IBL shadow subsystem, which Babylon Lite does not define."
        );
    }
    if (options.useSogTextures) {
        unsupported(
            "SPLATLoadingOptions.useSogTextures",
            "Lite's SOG loader uses its native CPU decode path and does not expose Babylon.js's raw-texture dequantization pipeline."
        );
    }
    if (options.spzLibraryUrl !== undefined) {
        unsupported("SPLATLoadingOptions.spzLibraryUrl", "Lite owns its SPZ decoder and does not expose a replaceable WASM-library URL policy.");
    }
}

export class SPLATFileLoader {
    public readonly name = "splat";
    public readonly extensions = {
        ".splat": { isBinary: true },
        ".ply": { isBinary: true },
        ".spz": { isBinary: true },
        ".json": { isBinary: false },
        ".sog": { isBinary: true },
    } as const;

    private readonly _loadingOptions: Readonly<SPLATLoadingOptions>;

    public constructor(loadingOptions: Partial<Readonly<SPLATLoadingOptions>> = {}) {
        this._loadingOptions = { ...loadingOptions };
        validateOptions(this._loadingOptions);
    }

    public createPlugin(options: { splat?: Partial<Readonly<SPLATLoadingOptions>> }): SPLATFileLoader {
        return new SPLATFileLoader(options.splat);
    }

    public async importMeshAsync(
        _meshesNames: unknown,
        scene: Scene,
        data: unknown,
        _rootUrl: string,
        _onProgress?: (event: ISceneLoaderProgressEvent) => void,
        _fileName?: string
    ): Promise<SPLATImportResult> {
        const mesh = await this._load(scene, data);
        return {
            meshes: [mesh],
            particleSystems: [],
            skeletons: [],
            animationGroups: [],
            transformNodes: [],
            geometries: [],
            lights: [],
            spriteManagers: [],
        };
    }

    public async loadAsync(scene: Scene, data: unknown, rootUrl: string, onProgress?: (event: ISceneLoaderProgressEvent) => void, fileName?: string): Promise<void> {
        await this.importMeshAsync(null, scene, data, rootUrl, onProgress, fileName);
    }

    public loadAssetContainerAsync(_scene: Scene, _data: string, _rootUrl: string): Promise<AssetContainer> {
        return unsupported("SPLATFileLoader.loadAssetContainerAsync", SPLAT_ASSET_CONTAINER_UNSUPPORTED);
    }

    /** @internal Load a URL through Lite while preserving this plugin's Babylon.js options. */
    public async _loadUrlAsync(scene: Scene, url: string): Promise<GaussianSplattingMesh> {
        return this._loadReserved(scene, () => loaderForUrl(url)(scene._lite, url));
    }

    private async _load(scene: Scene, data: unknown): Promise<GaussianSplattingMesh> {
        return this._loadReserved(scene, async () => {
            const loader = loaderFor(data);
            const url = URL.createObjectURL(new Blob([binaryData(data)]));
            try {
                return await loader(scene._lite, url);
            } finally {
                URL.revokeObjectURL(url);
            }
        });
    }

    private async _loadReserved(scene: Scene, load: () => Promise<LiteGaussianSplattingMesh>): Promise<GaussianSplattingMesh> {
        const target = this._loadingOptions.gaussianSplattingMesh;
        if (target?._pickLiteNode) {
            unsupported("SPLATLoadingOptions.gaussianSplattingMesh", SPLAT_RELOAD_UNSUPPORTED);
        }
        if (target) {
            loadingTargets ??= new WeakSet();
            if (loadingTargets.has(target)) {
                unsupported("SPLATLoadingOptions.gaussianSplattingMesh", SPLAT_CONCURRENT_TARGET_UNSUPPORTED);
            }
            loadingTargets.add(target);
        }
        try {
            return this._adoptLoaded(scene, await load());
        } finally {
            if (target) {
                loadingTargets?.delete(target);
            }
        }
    }

    private _adoptLoaded(scene: Scene, lite: LiteGaussianSplattingMesh): GaussianSplattingMesh {
        const target = this._loadingOptions.gaussianSplattingMesh;
        if (target) {
            target._adopt(lite);
            return target;
        }
        lite.name = "GaussianSplatting";
        return GaussianSplattingMesh._fromLite(lite, scene);
    }
}

export function RegisterSPLATFileLoader(): void {}
