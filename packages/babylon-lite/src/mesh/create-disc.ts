/**
 * CreateDisc — matches Babylon.js MeshBuilder.CreateDisc defaults.
 *
 * A flat regular polygon / disc in the XY plane, centered at the origin,
 * facing -Z. With `arc < 1` the disc becomes a pie slice. Normals are
 * computed from the triangle winding (all +Z because winding is CW from -Z).
 *
 * Babylon's formula:
 *   step = arc === 1 ? 2π/tess : 2π·arc/(tess - 1)
 *   vertex 0 = (0, 0, 0)           ← center
 *   vertex t = (cos(a)·r, sin(a)·r, 0)   for t = 0..tess-1
 *   if arc === 1 → duplicate vertex 1 to close the circle
 *   triangles fan from the center: (0, i, i+1)
 */

export interface DiscData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

/** Options for `createDiscData`. Subset of Babylon's CreateDisc. */
export interface DiscOptions {
    radius?: number;
    tessellation?: number;
    /** Fraction of circumference (`0 < arc ≤ 1`). Default 1 (full disc). */
    arc?: number;
}

export function createDiscData(options: DiscOptions = {}): DiscData {
    const radius = options.radius ?? 0.5;
    const tessellation = options.tessellation ?? 64;
    const arc = options.arc && (options.arc <= 0 || options.arc > 1) ? 1 : (options.arc ?? 1);

    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Center
    positions.push(0, 0, 0);
    uvs.push(0.5, 0.5);

    const theta = Math.PI * 2 * arc;
    const step = arc === 1 ? theta / tessellation : theta / (tessellation - 1);

    let a = 0;
    for (let t = 0; t < tessellation; t++) {
        const x = Math.cos(a);
        const y = Math.sin(a);
        positions.push(radius * x, radius * y, 0);
        uvs.push((x + 1) / 2, (1 - y) / 2);
        a += step;
    }
    if (arc === 1) {
        positions.push(positions[3]!, positions[4]!, positions[5]!);
        uvs.push(uvs[2]!, uvs[3]!);
    }

    const vertexNb = positions.length / 3;
    for (let i = 1; i < vertexNb - 1; i++) {
        indices.push(i + 1, 0, i);
    }

    // Normals: Babylon's ComputeNormals on this triangle ordering yields -Z
    // for every vertex (see cross-product derivation in tests).
    const normals = new Float32Array(vertexNb * 3);
    for (let i = 0; i < vertexNb; i++) {
        normals[i * 3 + 2] = -1;
    }

    return {
        positions: new Float32Array(positions),
        normals,
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
    };
}
