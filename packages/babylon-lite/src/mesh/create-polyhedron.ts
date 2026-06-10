/**
 * CreatePolyhedron — matches Babylon.js MeshBuilder.CreatePolyhedron defaults.
 *
 * The 15 preset polyhedra are stored in `polyhedron-data.ts` (tables copied
 * verbatim from BJS). Two rendering modes:
 *   flat=true  (default) — each face is duplicated per-vertex with a uniform
 *               UV layout; faces appear as distinct polygons.
 *   flat=false — shared vertex positions, smoothed normals, empty UVs.
 *
 * Options omitted vs. BJS: `custom`, `faceUV`, `faceColors`, `sideOrientation`,
 * `frontUVs`, `backUVs`. Defaults match exactly.
 */

import { F32, U32 } from "../engine/typed-arrays.js";
import { POLYHEDRA } from "./polyhedron-data.js";
import { computeNormals } from "./compute-normals.js";

export interface PolyhedronData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createPolyhedronData`. Subset of Babylon's CreatePolyhedron. */
export interface PolyhedronOptions {
    /** Preset index 0-14. 0=Tetrahedron, 1=Octahedron, 2=Dodecahedron,
     *  3=Icosahedron, 4=Rhombicuboctahedron, 5=TriangularPrism, 6=PentagonalPrism,
     *  7=HexagonalPrism, 8=SquarePyramid(J1), 9=PentagonalPyramid(J2),
     *  10=TriangularDipyramid(J12), 11=PentagonalDipyramid(J13),
     *  12=ElongatedSquareDipyramid(J15), 13=ElongatedPentagonalDipyramid(J16),
     *  14=ElongatedPentagonalCupola(J20). Default 0. */
    type?: number;
    size?: number;
    sizeX?: number;
    sizeY?: number;
    sizeZ?: number;
    flat?: boolean;
}

export function createPolyhedronData(options: PolyhedronOptions = {}): PolyhedronData {
    const type = options.type !== undefined && (options.type < 0 || options.type >= POLYHEDRA.length) ? 0 : (options.type ?? 0);
    const size = options.size;
    const sizeX = options.sizeX ?? size ?? 1;
    const sizeY = options.sizeY ?? size ?? 1;
    const sizeZ = options.sizeZ ?? size ?? 1;
    const flat = options.flat ?? true;
    const data = POLYHEDRA[type]!;
    const nbfaces = data.face.length;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    if (!flat) {
        for (let i = 0; i < data.vertex.length; i++) {
            const v = data.vertex[i]!;
            positions.push(v[0]! * sizeX, v[1]! * sizeY, v[2]! * sizeZ);
            uvs.push(0, 0);
        }
        for (let f = 0; f < nbfaces; f++) {
            const face = data.face[f]!;
            for (let i = 0; i < face.length - 2; i++) {
                indices.push(face[0]!, face[i + 2]!, face[i + 1]!);
            }
        }
    } else {
        let index = 0;
        let faceIdx = 0;
        const indexes: number[] = [];
        for (let f = 0; f < nbfaces; f++) {
            const face = data.face[f]!;
            const fl = face.length;
            const ang = (2 * Math.PI) / fl;
            let x = 0.5 * Math.tan(ang / 2);
            let y = 0.5;
            for (let i = 0; i < fl; i++) {
                const v = data.vertex[face[i]!]!;
                positions.push(v[0]! * sizeX, v[1]! * sizeY, v[2]! * sizeZ);
                indexes.push(index);
                index++;
                // Default faceUV (0,0,1,1)
                uvs.push(0.5 + x, y - 0.5 + 0.5);
                const tmp = x * Math.cos(ang) - y * Math.sin(ang);
                y = x * Math.sin(ang) + y * Math.cos(ang);
                x = tmp;
            }
            for (let i = 0; i < fl - 2; i++) {
                indices.push(indexes[0 + faceIdx]!, indexes[i + 2 + faceIdx]!, indexes[i + 1 + faceIdx]!);
            }
            faceIdx += fl;
        }
    }

    const normals = computeNormals(positions, indices);

    return {
        positions: new F32(positions),
        normals: new F32(normals),
        uvs: new F32(uvs),
        indices: new U32(indices),
    };
}
