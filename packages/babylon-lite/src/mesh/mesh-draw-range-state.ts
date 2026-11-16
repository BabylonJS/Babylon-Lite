import type { MeshGPU } from "./mesh.js";

/** Install the readonly count facade only when exact ranges are enabled. */
export function setMeshDrawRangeSource(gpu: MeshGPU, source: NonNullable<MeshGPU["_drawRangeSource"]>): void {
    const capacity = gpu.indexCount;
    gpu._drawRangeSource = source;
    Object.defineProperty(gpu, "indexCount", {
        enumerable: true,
        configurable: true,
        get: () => gpu._drawRangeSource?.indexCount ?? capacity,
    });
}
