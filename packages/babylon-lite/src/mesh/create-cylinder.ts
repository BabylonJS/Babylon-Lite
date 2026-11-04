import { F32, U32 } from "../engine/typed-arrays.js";
/**
 * CreateCylinder — matches Babylon.js MeshBuilder.CreateCylinder default options.
 *
 * Supports cylinders, cones (diameterTop=0), truncated cones, and prisms
 * (low tessellation). Options are a subset of Babylon's MeshBuilder that
 * covers the typical procedural use-case. Advanced options — `arc`,
 * `enclose`, `hasRings`, `faceColors`, `faceUV`, `cap != CAP_ALL` — are
 * intentionally omitted to keep the API small; the default behavior (full
 * 360°, single ring, CAP_ALL) matches Babylon exactly.
 *
 * Index order and normal computation are ported verbatim from
 * `@babylonjs/core/Meshes/Builders/cylinderBuilder.js` to guarantee parity.
 */

export interface CylinderData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createCylinderData`. Subset of Babylon's CreateCylinder. */
export interface CylinderOptions {
    height?: number;
    diameter?: number;
    diameterTop?: number;
    diameterBottom?: number;
    tessellation?: number;
    subdivisions?: number;
}

/** Generate indexed vertex data for a cylinder, cone, truncated cone, or prism using Babylon-compatible defaults. The returned arrays contain positions, normals, UVs, and indices suitable for constructing a mesh. */
export function createCylinderData(options: CylinderOptions = {}): CylinderData {
    const height = options.height ?? 2;
    let diameterTop = options.diameterTop === 0 ? 0 : (options.diameterTop ?? options.diameter ?? 1);
    let diameterBottom = options.diameterBottom === 0 ? 0 : (options.diameterBottom ?? options.diameter ?? 1);
    // Prevent broken normals on degenerate rings.
    if (diameterTop === 0) {
        diameterTop = 0.00001;
    }
    if (diameterBottom === 0) {
        diameterBottom = 0.00001;
    }
    const tessellation = Math.max(3, (options.tessellation ?? 24) | 0);
    const subdivisions = Math.max(1, (options.subdivisions ?? 1) | 0);
    const arc = 1; // full circle only (see header comment)

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const angleStep = (Math.PI * 2 * arc) / tessellation;
    const tan = (diameterBottom - diameterTop) / 2 / height;

    // Side ring vertices
    for (let i = 0; i <= subdivisions; i++) {
        const h = i / subdivisions;
        const radius = (h * (diameterTop - diameterBottom) + diameterBottom) / 2;

        for (let j = 0; j <= tessellation; j++) {
            const angle = j * angleStep;
            const rvx = Math.cos(-angle) * radius;
            const rvy = -height / 2 + h * height;
            const rvz = Math.sin(-angle) * radius;

            let nx: number;
            let ny: number;
            let nz: number;
            if (options.diameterTop === 0 && i === subdivisions) {
                // Cone tip: reuse previous ring's normals (Babylon parity).
                const base = normals.length - (tessellation + 1) * 3;
                nx = normals[base]!;
                ny = normals[base + 1]!;
                nz = normals[base + 2]!;
            } else {
                nx = rvx;
                nz = rvz;
                ny = Math.sqrt(nx * nx + nz * nz) * tan;
                const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
                nx *= invLen;
                ny *= invLen;
                nz *= invLen;
            }

            positions.push(rvx, rvy, rvz);
            normals.push(nx, ny, nz);
            // Default faceUV for side is (0,0,1,1): u=j/tessellation, v=h
            uvs.push(j / tessellation, h);
        }
    }

    // Side indices (e = tessellation since arc === 1 && !enclose)
    const e = tessellation;
    for (let s = 0; s < subdivisions; s++) {
        for (let j = 0; j < tessellation; j++) {
            const i0 = s * (e + 1) + j;
            const i1 = (s + 1) * (e + 1) + j;
            const i2 = s * (e + 1) + (j + 1);
            const i3 = (s + 1) * (e + 1) + (j + 1);
            indices.push(i0, i1, i2);
            indices.push(i3, i2, i1);
        }
    }

    // Caps (CAP_ALL)
    const createCap = (isTop: boolean): void => {
        const radius = isTop ? diameterTop / 2 : diameterBottom / 2;
        if (radius === 0) {
            return;
        }

        const vbase = positions.length / 3;
        const offset = isTop ? height / 2 : -height / 2;

        // Center vertex
        positions.push(0, offset, 0);
        normals.push(0, isTop ? 1 : -1, 0);
        uvs.push(0.5, 0.5);

        for (let i = 0; i <= tessellation; i++) {
            const angle = (Math.PI * 2 * i * arc) / tessellation;
            const cos = Math.cos(-angle);
            const sin = Math.sin(-angle);
            positions.push(cos * radius, offset, sin * radius);
            normals.push(0, isTop ? 1 : -1, 0);
            uvs.push(cos * 0.5 + 0.5, sin * 0.5 + 0.5);
        }

        for (let i = 0; i < tessellation; i++) {
            if (!isTop) {
                indices.push(vbase, vbase + (i + 1), vbase + (i + 2));
            } else {
                indices.push(vbase, vbase + (i + 2), vbase + (i + 1));
            }
        }
    };
    createCap(false);
    createCap(true);

    return {
        positions: new F32(positions),
        normals: new F32(normals),
        uvs: new F32(uvs),
        indices: new U32(indices),
    };
}
