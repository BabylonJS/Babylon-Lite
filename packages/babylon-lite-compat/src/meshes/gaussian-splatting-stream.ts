import { unsupported } from "../error.js";
import type { Scene } from "../scene/scene.js";
import type { BaseTexture } from "../textures/textures.js";
import type { BoundingInfo } from "../culling/bounding.js";
import type { Vector3 } from "../math/vector.js";
import { Mesh } from "./meshes.js";
import { GaussianSplattingMesh } from "./gaussian-splatting.js";

interface ISOGLODEntry {
    file: number;
    offset: number;
    count: number;
}

interface ISOGLODNode {
    bound: { min: number[]; max: number[] };
    children?: ISOGLODNode[];
    lods?: Record<string, ISOGLODEntry>;
}

/** Babylon.js parsed PlayCanvas-style `lod-meta.json` shape. */
export interface ISOGLODMetadata {
    lodLevels: number;
    filenames: string[];
    environment?: string;
    tree: ISOGLODNode;
}

export type GaussianSplattingStreamDebugLodSource = "optimal" | "current";

export type GaussianSplattingStreamLod0SplatCount = Readonly<{ status: "pending" }> | Readonly<{ status: "available"; count: number }> | Readonly<{ status: "unavailable" }>;

export interface IGaussianSplattingStreamOptions {
    deflateURL?: string;
    fflate?: unknown;
    debugDisplay?: boolean;
    debugLodSource?: GaussianSplattingStreamDebugLodSource;
    lodBaseDistance?: number;
    lodMultiplier?: number;
    lodBehindPenalty?: number;
    lodRangeMin?: number;
    lodRangeMax?: number;
    maxDecodesPerFrame?: number;
    lodCooldownFrames?: number;
    lodUpdateInterval?: number;
    lodUpdateDistance?: number;
    maxDetailLod?: number;
    frustumCulling?: boolean;
    maxConcurrentDownloads?: number;
    maxDownloadRetries?: number;
    memoryBudgetMb?: number;
    maxResidentSplats?: number;
    evictionCooldownFrames?: number;
    splatBudget?: number | "auto";
    hostCompound?: GaussianSplattingMesh;
    decodeSh?: boolean;
    needsRotationScale?: boolean;
}

export interface IGaussianSplattingStreamingPart {
    readonly proxy: GaussianSplattingPartProxyMesh;
    readonly partIndex: number;
    readonly base: number;
    readonly capacity: number;
    readonly centersTexture: BaseTexture | null;
    readonly covariancesATexture: BaseTexture | null;
    readonly covariancesBTexture: BaseTexture | null;
    readonly colorsTexture: BaseTexture | null;
    readonly splatPositions: Float32Array | null;
    readonly mrtAtlas: unknown | null;
    readonly shMrtAtlas: unknown[] | null;
    readonly rotMrtAtlas: unknown | null;
    readonly atlasWidth: number;
    readonly isDepthSortSettled: boolean;
    setActiveRanges(localRanges: readonly { offset: number; count: number }[] | null): void;
    writeSplats(localOffset: number, count: number, splatsData: ArrayBuffer | ArrayBufferView): void;
    postPositionsRange(localOffset: number, count: number): void;
    expandBounds(min: Vector3, max: Vector3): void;
    notifyDataChanged(): void;
    onBeforeAtlasRebuild(callback: (oldAtlas: unknown) => void): () => void;
    onAfterAtlasRebuild(callback: (newAtlas: unknown) => void): () => void;
}

const STREAM_BLOCKER =
    "Lite's native streamer accepts only an HTTP(S) manifest URL and combines selection capacity with a mandatory render cap. Babylon.js constructs synchronously from parsed metadata, applies a distinct SOG coordinate transform, and independently controls render budget, residency, compound hosting, and cancellation. Bridging those lifecycle/policy differences requires a new Lite stream-construction contract.";

const COMPOUND_BLOCKER =
    "Lite streams one independently rendered scene node and has no compound-mesh atlas reservation/proxy lifecycle to adapt.";

export class GaussianSplattingPartProxyMesh extends Mesh {
    public readonly compoundSplatMesh: GaussianSplattingMesh;
    /** @internal */
    public readonly _vertexCount: number;
    /** @internal */
    public readonly _splatsDataOffset: number;
    /** @internal */
    public readonly _shDataOffset: number;
    private readonly _partIndex: number;
    private _visibility = 1;

    public constructor(
        name: string,
        _scene: Scene | null,
        compoundSplatMesh: GaussianSplattingMesh,
        partIndex: number,
        _boundingInfo: BoundingInfo,
        vertexCount: number,
        splatsDataOffset: number,
        shDataOffset = splatsDataOffset
    ) {
        super(name);
        this.compoundSplatMesh = compoundSplatMesh;
        this._partIndex = partIndex;
        this._vertexCount = vertexCount;
        this._splatsDataOffset = splatsDataOffset;
        this._shDataOffset = shDataOffset;
        unsupported("GaussianSplattingPartProxyMesh", COMPOUND_BLOCKER);
    }

    public get partIndex(): number {
        return this._partIndex;
    }

    public get proxiedMesh(): GaussianSplattingMesh {
        return this.compoundSplatMesh;
    }

    public override getClassName(): string {
        return "GaussianSplattingPartProxyMesh";
    }

    public override get isVisible(): boolean {
        return this._visibility > 0;
    }
    public override set isVisible(value: boolean) {
        this._visibility = value ? 1 : 0;
    }

    public get visibility(): number {
        return this._visibility;
    }
    public set visibility(value: number) {
        this._visibility = Math.max(0, Math.min(1, value));
    }

    public updateBoundingInfoFromPartData(): never {
        return unsupported("GaussianSplattingPartProxyMesh.updateBoundingInfoFromPartData", COMPOUND_BLOCKER);
    }

    public updateBoundingInfoFromProxiedMesh(): never {
        return unsupported("GaussianSplattingPartProxyMesh.updateBoundingInfoFromProxiedMesh", COMPOUND_BLOCKER);
    }

    public updatePartIndex(_newPartIndex: number): never {
        return unsupported("GaussianSplattingPartProxyMesh.updatePartIndex", COMPOUND_BLOCKER);
    }

    public updatePartMetadata(_vertexCount: number, _splatsDataOffset: number, _shDataOffset = _splatsDataOffset): never {
        return unsupported("GaussianSplattingPartProxyMesh.updatePartMetadata", COMPOUND_BLOCKER);
    }
}

/** Babylon.js `GaussianSplattingStream` exact-shape stub pending a compatible Lite construction contract. */
export class GaussianSplattingStream extends GaussianSplattingMesh {
    public static IsLODMetadata(data: unknown): data is ISOGLODMetadata {
        if (!data || typeof data !== "object") {
            return false;
        }
        const metadata = data as Partial<ISOGLODMetadata>;
        return typeof metadata.lodLevels === "number" && Array.isArray(metadata.filenames) && !!metadata.tree && typeof metadata.tree === "object";
    }

    public constructor(name: string, _metadata: ISOGLODMetadata, _rootUrl: string, scene: Scene, _options: IGaussianSplattingStreamOptions = {}) {
        super(name, null, scene, false);
        unsupported("GaussianSplattingStream", STREAM_BLOCKER);
    }

    public override getClassName(): string {
        return "GaussianSplattingStream";
    }

    public isReady(_completeCheck = false): never {
        return unsupported("GaussianSplattingStream.isReady", STREAM_BLOCKER);
    }

    public get streamingPartProxy(): never {
        return unsupported("GaussianSplattingStream.streamingPartProxy", COMPOUND_BLOCKER);
    }

    public whenPartReadyAsync(): Promise<never> {
        return unsupported("GaussianSplattingStream.whenPartReadyAsync", COMPOUND_BLOCKER);
    }

    public whenSettledAsync(_stableFrames = 3): Promise<never> {
        return unsupported("GaussianSplattingStream.whenSettledAsync", STREAM_BLOCKER);
    }

    public get maxDetailLod(): never {
        return unsupported("GaussianSplattingStream.maxDetailLod", STREAM_BLOCKER);
    }
    public set maxDetailLod(_value: number) {
        unsupported("GaussianSplattingStream.maxDetailLod", STREAM_BLOCKER);
    }

    public get splatBudget(): never {
        return unsupported("GaussianSplattingStream.splatBudget", STREAM_BLOCKER);
    }
    public set splatBudget(_value: number) {
        unsupported("GaussianSplattingStream.splatBudget", STREAM_BLOCKER);
    }

    public get effectiveSplatBudget(): never {
        return unsupported("GaussianSplattingStream.effectiveSplatBudget", STREAM_BLOCKER);
    }

    public get residentSplatBudget(): never {
        return unsupported("GaussianSplattingStream.residentSplatBudget", STREAM_BLOCKER);
    }

    public get minimumResidentSplats(): never {
        return unsupported("GaussianSplattingStream.minimumResidentSplats", STREAM_BLOCKER);
    }

    public get lod0SplatCount(): never {
        return unsupported("GaussianSplattingStream.lod0SplatCount", STREAM_BLOCKER);
    }

    public getBudgetDemand(): never {
        return unsupported("GaussianSplattingStream.getBudgetDemand", COMPOUND_BLOCKER);
    }

    public setBudgetAllocation(_splats: number | null): never {
        return unsupported("GaussianSplattingStream.setBudgetAllocation", COMPOUND_BLOCKER);
    }

    public get maxLodLevel(): never {
        return unsupported("GaussianSplattingStream.maxLodLevel", STREAM_BLOCKER);
    }

    public get frustumCulling(): never {
        return unsupported("GaussianSplattingStream.frustumCulling", STREAM_BLOCKER);
    }
    public set frustumCulling(_value: boolean) {
        unsupported("GaussianSplattingStream.frustumCulling", STREAM_BLOCKER);
    }

    public get debugDisplay(): never {
        return unsupported("GaussianSplattingStream.debugDisplay", STREAM_BLOCKER);
    }
    public set debugDisplay(_value: boolean) {
        unsupported("GaussianSplattingStream.debugDisplay", STREAM_BLOCKER);
    }

    public get debugLodSource(): never {
        return unsupported("GaussianSplattingStream.debugLodSource", STREAM_BLOCKER);
    }
    public set debugLodSource(_value: GaussianSplattingStreamDebugLodSource) {
        unsupported("GaussianSplattingStream.debugLodSource", STREAM_BLOCKER);
    }

    public evaluateOptimalLods(_camera: unknown = null): never {
        return unsupported("GaussianSplattingStream.evaluateOptimalLods", STREAM_BLOCKER);
    }
}

export function AddGaussianSplattingStreamPart(
    _compound: GaussianSplattingMesh,
    _name: string,
    _metadata: ISOGLODMetadata,
    _rootUrl: string,
    _options: IGaussianSplattingStreamOptions = {}
): never {
    return unsupported("AddGaussianSplattingStreamPart", COMPOUND_BLOCKER);
}

export async function AddGaussianSplattingStreamPartAsync(
    _compound: GaussianSplattingMesh,
    _name: string,
    _metadata: ISOGLODMetadata,
    _rootUrl: string,
    _options: IGaussianSplattingStreamOptions = {}
): Promise<GaussianSplattingPartProxyMesh> {
    unsupported("AddGaussianSplattingStreamPartAsync", COMPOUND_BLOCKER);
}
