/**
 * Torus-knot mesh generator — matches Babylon.js `CreateTorusKnotVertexData` exactly.
 *
 * The knot centre-line is the (p, q) torus knot curve:
 *
 *   getPos(angle):
 *     cu = cos(angle), su = sin(angle), s = (q/p) * angle
 *     x = radius * (2 + cos(s)) * 0.5 * cu
 *     y = radius * (2 + cos(s)) * 0.5 * su
 *     z = radius * sin(s) * 0.5
 *
 * A Frenet-like frame (tangent / normal / bitangent built from cross products of
 * the curve point and a nearby sample) sweeps a circle of `tube` radius around
 * the curve. Normals are computed with the area-weighted-per-face-then-normalize
 * scheme of Babylon's `VertexData.ComputeNormals` (see {@link computeNormals}),
 * NOT analytically, so the knot shades pixel-identically to Babylon.js.
 *
 * Loop bounds mirror Babylon precisely: the vertex loop runs `i <= radialSegments`
 * (with `i % radialSegments` wrap) while the index loop runs `i < radialSegments`
 * and `j < tubularSegments` (with `(j + 1) % tubularSegments` wrap).
 */

import { computeNormals } from "./compute-normals.js";

/** CPU geometry for a torus knot: tightly-packed typed arrays ready for GPU upload. */
export interface TorusKnotData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for {@link createTorusKnotData}. Subset of Babylon's CreateTorusKnot. */
export interface TorusKnotOptions {
    /** Global radius of the torus knot. Default 2. */
    radius?: number;
    /** Thickness of the tube. Default 0.5. */
    tube?: number;
    /** Number of sides on each tube segment. Default 32. */
    radialSegments?: number;
    /** Number of tubes the knot is decomposed into. Default 32. */
    tubularSegments?: number;
    /** Number of windings around the z axis. Default 2. */
    p?: number;
    /** Number of windings around the x axis. Default 3. */
    q?: number;
}

/**
 * Builds the CPU vertex data for a torus knot, matching Babylon.js byte-for-byte
 * (same curve math, same Frenet frame, same ComputeNormals, same index winding).
 *
 * @param opts - Optional radius / tube / segmentation / winding parameters.
 * @returns Tightly-packed `positions`, `normals`, `uvs` and `indices` typed arrays.
 */
export function createTorusKnotData(opts: TorusKnotOptions = {}): TorusKnotData {
    const radius = opts.radius ?? 2;
    const tube = opts.tube ?? 0.5;
    const radialSegments = opts.radialSegments ?? 32;
    const tubularSegments = opts.tubularSegments ?? 32;
    const p = opts.p ?? 2;
    const q = opts.q ?? 3;

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Curve point at parameter `angle` (doubles, matching Babylon's Vector3 math).
    const getPos = (angle: number): [number, number, number] => {
        const cu = Math.cos(angle);
        const su = Math.sin(angle);
        const quOverP = (q / p) * angle;
        const cs = Math.cos(quOverP);

        const tx = radius * (2 + cs) * 0.5 * cu;
        const ty = radius * (2 + cs) * su * 0.5;
        const tz = radius * Math.sin(quOverP) * 0.5;
        return [tx, ty, tz];
    };

    for (let i = 0; i <= radialSegments; i++) {
        const modI = i % radialSegments;
        const u = (modI / radialSegments) * 2 * p * Math.PI;
        const p1 = getPos(u);
        const p2 = getPos(u + 0.01);

        // tang = p2 - p1
        const tangX = p2[0] - p1[0];
        const tangY = p2[1] - p1[1];
        const tangZ = p2[2] - p1[2];

        // n = p2 + p1
        let nX = p2[0] + p1[0];
        let nY = p2[1] + p1[1];
        let nZ = p2[2] + p1[2];

        // bitan = cross(tang, n)
        let bitanX = tangY * nZ - tangZ * nY;
        let bitanY = tangZ * nX - tangX * nZ;
        let bitanZ = tangX * nY - tangY * nX;

        // n = cross(bitan, tang)
        nX = bitanY * tangZ - bitanZ * tangY;
        nY = bitanZ * tangX - bitanX * tangZ;
        nZ = bitanX * tangY - bitanY * tangX;

        // normalize bitan
        let bitanLen = Math.sqrt(bitanX * bitanX + bitanY * bitanY + bitanZ * bitanZ);
        if (bitanLen === 0) {
            bitanLen = 1;
        }
        bitanX /= bitanLen;
        bitanY /= bitanLen;
        bitanZ /= bitanLen;

        // normalize n
        let nLen = Math.sqrt(nX * nX + nY * nY + nZ * nZ);
        if (nLen === 0) {
            nLen = 1;
        }
        nX /= nLen;
        nY /= nLen;
        nZ /= nLen;

        for (let j = 0; j < tubularSegments; j++) {
            const modJ = j % tubularSegments;
            const v = (modJ / tubularSegments) * 2 * Math.PI;
            const cx = -tube * Math.cos(v);
            const cy = tube * Math.sin(v);

            positions.push(p1[0] + cx * nX + cy * bitanX);
            positions.push(p1[1] + cx * nY + cy * bitanY);
            positions.push(p1[2] + cx * nZ + cy * bitanZ);

            uvs.push(i / radialSegments);
            uvs.push(j / tubularSegments);
        }
    }

    for (let i = 0; i < radialSegments; i++) {
        for (let j = 0; j < tubularSegments; j++) {
            const jNext = (j + 1) % tubularSegments;
            const a = i * tubularSegments + j;
            const b = (i + 1) * tubularSegments + j;
            const c = (i + 1) * tubularSegments + jNext;
            const d = i * tubularSegments + jNext;

            indices.push(d);
            indices.push(b);
            indices.push(a);
            indices.push(d);
            indices.push(c);
            indices.push(b);
        }
    }

    const normals = computeNormals(positions, indices);

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
    };
}
