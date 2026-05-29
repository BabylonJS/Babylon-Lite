import type { Mesh } from "../mesh/mesh.js";
import type { GaussianSplattingMesh } from "../mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { Ray } from "./ray.js";

/** Result of a GPU pick operation. */
export interface PickingInfo {
    hit: boolean;
    distance: number;
    pickedPoint: [number, number, number] | null;
    pickedNormal: [number, number, number] | null;
    pickedNormalWorld: [number, number, number] | null;
    pickedFaceNormal: [number, number, number] | null;
    pickedFaceNormalWorld: [number, number, number] | null;
    /** The picked mesh.  May be a regular Lite `Mesh` or a `GaussianSplattingMesh`
     *  (when GS picking via the gs-picking-pipeline ports the BJS
     *  `GaussianSplattingGpuPickingMaterialPlugin`). */
    pickedMesh: Mesh | GaussianSplattingMesh | null;
    faceId: number;
    bu: number;
    bv: number;
    subMeshId: number;
    thinInstanceIndex: number;
    ray: Ray | null;
}

/** Create an empty (miss) picking result. */
export function createEmptyPickingInfo(): PickingInfo {
    return {
        hit: false,
        distance: 0,
        pickedPoint: null,
        pickedNormal: null,
        pickedNormalWorld: null,
        pickedFaceNormal: null,
        pickedFaceNormalWorld: null,
        pickedMesh: null,
        faceId: -1,
        bu: 0,
        bv: 0,
        subMeshId: 0,
        thinInstanceIndex: -1,
        ray: null,
    };
}
