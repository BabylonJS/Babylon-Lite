import { F32, U32 } from "../engine/typed-arrays.js";
/**
 * CreatePlane — matches Babylon.js MeshBuilder.CreatePlane defaults.
 *
 * Unit quad in the XY plane with a -Z facing normal (Babylon convention).
 * 4 vertices, 2 triangles, UVs span [0,1].
 */

export interface PlaneData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createPlaneData`. Subset of Babylon's CreatePlane. */
export interface PlaneOptions {
    size?: number;
    width?: number;
    height?: number;
}

export function createPlaneData(options: PlaneOptions = {}): PlaneData {
    const size = options.size ?? 1;
    const width = options.width ?? size;
    const height = options.height ?? size;
    const hw = width / 2;
    const hh = height / 2;

    // prettier-ignore
    const positions = new F32([
        -hw, -hh, 0,
         hw, -hh, 0,
         hw,  hh, 0,
        -hw,  hh, 0,
    ]);
    // prettier-ignore
    const normals = new F32([
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
        0, 0, -1,
    ]);
    // prettier-ignore
    const uvs = new F32([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
    ]);
    const indices = new U32([0, 1, 2, 0, 2, 3]);

    return { positions, normals, uvs, indices };
}
