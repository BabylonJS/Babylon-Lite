import type { MeshGPU } from "./mesh.js";

/** @internal Populate the WebGPU indexed-indirect ABI, including the signed baseVertex word. */
export function writeMeshIndexedIndirectArgs(args: Uint32Array, gpu: MeshGPU, instanceCount: number): void {
    args[0] = gpu.indexCount;
    args[1] = instanceCount;
    args[2] = 0;
    args[3] = gpu._baseVertex ?? 0;
    args[4] = 0;
}
