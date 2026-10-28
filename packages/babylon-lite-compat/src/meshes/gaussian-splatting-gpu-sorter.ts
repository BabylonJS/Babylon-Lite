import type { AbstractEngine } from "../engine/engine.js";
import type { Matrix } from "../math/matrix.js";
import type { BaseTexture } from "../textures/textures.js";
import { unsupported } from "../error.js";
import {
    clampGaussianSplattingGpuSortKeyBits,
    getGaussianSplattingGpuSortPassCount,
    getGaussianSplattingGpuSortPaddedCount,
    packGaussianSplattingGpuSortIntervals,
    computeGaussianSplattingGpuSortDepthCoefficients,
    computeGaussianSplattingGpuSortDepthRange,
    computeGaussianSplattingGpuSortKeyScale,
    decodeGaussianSplattingGpuSortSogMean,
    getGaussianSplattingGpuSorterMaxSplatCount,
} from "babylon-lite";

const GPU_SORT_UNSUPPORTED =
    "Babylon Lite exposes no public GPU splat-sort source/output lifecycle. Its ordinary splat sorter is worker-owned and its streaming radix sorter is internal to the streaming subsystem, so adapting this API requires a Lite-owned resource and scheduling design.";

export type GaussianSplattingGpuSortMatrix = Pick<Matrix, "m">;

export interface IGaussianSplattingGpuSortSource {
    vertexCount: number;
    textureWidth: number;
    centersTexture: BaseTexture;
    sog?: {
        meansHighTexture: BaseTexture;
        meansMin: ArrayLike<number>;
        meansMax: ArrayLike<number>;
    };
    partIndicesTexture?: BaseTexture;
    boundsMin?: ArrayLike<number>;
    boundsMax?: ArrayLike<number>;
}

export interface IGaussianSplattingGpuSortOptions {
    rightHanded?: boolean;
    cameraPosition?: ArrayLike<number>;
    depthRange?: { min: number; max: number };
}

export function _ClampGpuSortKeyBits(keyBits: number): number {
    return clampGaussianSplattingGpuSortKeyBits(keyBits);
}

export function _GetGpuSortPassCount(keyBits: number): number {
    return getGaussianSplattingGpuSortPassCount(keyBits);
}

export function _GetGpuSortPaddedCount(activeCount: number): number {
    return getGaussianSplattingGpuSortPaddedCount(activeCount);
}

export function _PackGpuSortIntervals(intervals: ArrayLike<number>, vertexCount: number): { data: Uint32Array; count: number; total: number } {
    return packGaussianSplattingGpuSortIntervals(intervals, vertexCount);
}

export function _ComputeGpuSortDepthCoefficients(
    _world: ArrayLike<number>,
    _view: ArrayLike<number>,
    _depthSign: number,
    _cameraPosition: ArrayLike<number> | null,
    _out: Float32Array,
    _offset: number,
    _worldOffset = 0
): void {
    computeGaussianSplattingGpuSortDepthCoefficients(_world, _view, _depthSign, _cameraPosition, _out, _offset, _worldOffset);
}

export function _ComputeGpuSortDepthRange(
    _coefficients: ArrayLike<number>,
    _setCount: number,
    _boundsMin: ArrayLike<number>,
    _boundsMax: ArrayLike<number>,
    _result: { min: number; max: number } = { min: 0, max: 0 }
): { min: number; max: number } {
    return computeGaussianSplattingGpuSortDepthRange(_coefficients, _setCount, _boundsMin, _boundsMax, _result);
}

export function _ComputeGpuSortKeyScale(depthMin: number, depthMax: number, keyBits: number): number {
    return computeGaussianSplattingGpuSortKeyScale(depthMin, depthMax, keyBits);
}

export function _DecodeGpuSortSogMean(value: number): number {
    return decodeGaussianSplattingGpuSortSogMean(value);
}

export function GetGaussianSplattingGpuSorterMaxSplatCount(engine: AbstractEngine): number {
    const limits = (engine as unknown as { _lite?: { _device?: { limits?: { maxStorageBufferBindingSize?: number; maxBufferSize?: number } } } })._lite?._device?.limits;
    return getGaussianSplattingGpuSorterMaxSplatCount(limits?.maxStorageBufferBindingSize, limits?.maxBufferSize);
}

export class GaussianSplattingGpuSortOutput {
    public constructor(_engine?: AbstractEngine, _label?: string) {
        unsupported("GaussianSplattingGpuSortOutput", GPU_SORT_UNSUPPORTED);
    }

    public get buffer(): null {
        return null;
    }

    public get vertexBuffers(): readonly never[] {
        return [];
    }

    public get paddedCount(): number {
        return 0;
    }

    public get instanceCount(): number {
        return 0;
    }

    public get buffersVersion(): number {
        return 0;
    }

    public dispose(): void {}
}

export class GaussianSplattingGpuSorter {
    public static IsSupported(_engine: AbstractEngine): boolean {
        return false;
    }

    public static GetMaxSupportedSplatCount(_engine: AbstractEngine): number {
        return GetGaussianSplattingGpuSorterMaxSplatCount(_engine);
    }

    public static async LoadDependenciesAsync(): Promise<void> {
        return unsupported("GaussianSplattingGpuSorter.LoadDependenciesAsync", GPU_SORT_UNSUPPORTED);
    }

    public constructor(_engine: AbstractEngine, _name = "GaussianSplattingGpuSorter", _keyBits = 16) {
        unsupported("GaussianSplattingGpuSorter", GPU_SORT_UNSUPPORTED);
    }

    public get activeCount(): number {
        return 0;
    }

    public get paddedCount(): number {
        return 0;
    }

    public get keyBits(): number {
        return 16;
    }

    public setSource(_source: IGaussianSplattingGpuSortSource): never {
        return unsupported("GaussianSplattingGpuSorter.setSource", GPU_SORT_UNSUPPORTED);
    }

    public setPartMatrices(_matrices: ReadonlyArray<GaussianSplattingGpuSortMatrix> | ArrayLike<number> | null): never {
        return unsupported("GaussianSplattingGpuSorter.setPartMatrices", GPU_SORT_UNSUPPORTED);
    }

    public setIntervals(_intervals: ArrayLike<number> | null): never {
        return unsupported("GaussianSplattingGpuSorter.setIntervals", GPU_SORT_UNSUPPORTED);
    }

    public createOutput(): never {
        return unsupported("GaussianSplattingGpuSorter.createOutput", GPU_SORT_UNSUPPORTED);
    }

    public sort(
        _output: GaussianSplattingGpuSortOutput,
        _worldMatrix: GaussianSplattingGpuSortMatrix,
        _viewMatrix: GaussianSplattingGpuSortMatrix,
        _options?: IGaussianSplattingGpuSortOptions
    ): never {
        return unsupported("GaussianSplattingGpuSorter.sort", GPU_SORT_UNSUPPORTED);
    }

    public dispose(): void {}
}
