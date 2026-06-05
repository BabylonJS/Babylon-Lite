/**
 * Procedural geometry for a chamfered unit cube — the same volume as a regular
 * box but with all 12 edges and 8 corners replaced by 45° bevels.
 *
 * Why: a perfect 90° cube reads as "developer primitive" because real plastic
 * blocks always have slightly rounded or chamfered edges. The bevels catch a
 * tiny specular highlight along every silhouette line, which is what your eye
 * uses to recognise "manufactured object" vs "math abstraction".
 *
 * Layout (size = 1):
 *   6 inner face quads at ±0.5 on each axis, each (1 − 2·bevel) on a side.
 *   12 edge bevels, one per cube edge, each a single 45° quad with a unique
 *      normal pointing out of the edge.
 *   8 corner triangles, one per cube vertex, with a normal pointing out of
 *      the corner.
 *
 * Returns: 96 vertices, 132 indices (36 face + 72 edge + 24 corner). Each
 * "patch" gets its own vertices so face normals are flat — no smoothing
 * groups, no shared verts. Cheap enough for thin-instancing across the entire
 * board (≤ 204 instances) without any visible perf cost.
 */

export interface ChamferedBoxData {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs: Float32Array;
}

export function createChamferedBoxData(size = 1, bevel = 0.08): ChamferedBoxData {
    const h = size * 0.5;
    const inn = h - bevel; // inner-face half-extent
    const inv2 = 1 / Math.sqrt(2);
    const inv3 = 1 / Math.sqrt(3);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    function quad(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
        dx: number, dy: number, dz: number,
        nx: number, ny: number, nz: number,
    ): void {
        const base = positions.length / 3;
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
        for (let i = 0; i < 4; i++) normals.push(nx, ny, nz);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    function tri(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
        nx: number, ny: number, nz: number,
    ): void {
        const base = positions.length / 3;
        positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        for (let i = 0; i < 3; i++) normals.push(nx, ny, nz);
        uvs.push(0, 0, 1, 0, 0.5, 1);
        indices.push(base, base + 1, base + 2);
    }

    // ── 6 inner face quads ──────────────────────────────────────────────
    // +X
    quad(h, -inn, -inn, h, inn, -inn, h, inn, inn, h, -inn, inn, 1, 0, 0);
    // -X
    quad(-h, -inn, inn, -h, inn, inn, -h, inn, -inn, -h, -inn, -inn, -1, 0, 0);
    // +Y
    quad(-inn, h, -inn, -inn, h, inn, inn, h, inn, inn, h, -inn, 0, 1, 0);
    // -Y
    quad(-inn, -h, inn, -inn, -h, -inn, inn, -h, -inn, inn, -h, inn, 0, -1, 0);
    // +Z
    quad(-inn, -inn, h, inn, -inn, h, inn, inn, h, -inn, inn, h, 0, 0, 1);
    // -Z
    quad(inn, -inn, -h, -inn, -inn, -h, -inn, inn, -h, inn, inn, -h, 0, 0, -1);

    // ── 12 edge bevels (each a quad connecting two inner face edges) ────
    // Edges parallel to Z axis (4 of them)
    // +X+Y edge: connects +X-face right edge to +Y-face top edge
    quad(h, inn, -inn, h, inn, inn, inn, h, inn, inn, h, -inn, inv2, inv2, 0);
    // +X-Y edge
    quad(inn, -h, -inn, inn, -h, inn, h, -inn, inn, h, -inn, -inn, inv2, -inv2, 0);
    // -X+Y edge
    quad(-inn, h, -inn, -inn, h, inn, -h, inn, inn, -h, inn, -inn, -inv2, inv2, 0);
    // -X-Y edge
    quad(-h, -inn, -inn, -h, -inn, inn, -inn, -h, inn, -inn, -h, -inn, -inv2, -inv2, 0);

    // Edges parallel to X axis (4)
    // +Y+Z edge
    quad(-inn, h, inn, inn, h, inn, inn, inn, h, -inn, inn, h, 0, inv2, inv2);
    // +Y-Z edge
    quad(-inn, inn, -h, inn, inn, -h, inn, h, -inn, -inn, h, -inn, 0, inv2, -inv2);
    // -Y+Z edge
    quad(-inn, -inn, h, inn, -inn, h, inn, -h, inn, -inn, -h, inn, 0, -inv2, inv2);
    // -Y-Z edge
    quad(-inn, -h, -inn, inn, -h, -inn, inn, -inn, -h, -inn, -inn, -h, 0, -inv2, -inv2);

    // Edges parallel to Y axis (4)
    // +X+Z edge
    quad(inn, -inn, h, inn, inn, h, h, inn, inn, h, -inn, inn, inv2, 0, inv2);
    // +X-Z edge
    quad(h, -inn, -inn, h, inn, -inn, inn, inn, -h, inn, -inn, -h, inv2, 0, -inv2);
    // -X+Z edge
    quad(-h, -inn, inn, -h, inn, inn, -inn, inn, h, -inn, -inn, h, -inv2, 0, inv2);
    // -X-Z edge
    quad(-inn, -inn, -h, -inn, inn, -h, -h, inn, -inn, -h, -inn, -inn, -inv2, 0, -inv2);

    // ── 8 corner triangles ──────────────────────────────────────────────
    // +X+Y+Z
    tri(h, inn, inn, inn, h, inn, inn, inn, h, inv3, inv3, inv3);
    // +X+Y-Z
    tri(inn, inn, -h, inn, h, -inn, h, inn, -inn, inv3, inv3, -inv3);
    // +X-Y+Z
    tri(inn, -inn, h, inn, -h, inn, h, -inn, inn, inv3, -inv3, inv3);
    // +X-Y-Z
    tri(h, -inn, -inn, inn, -h, -inn, inn, -inn, -h, inv3, -inv3, -inv3);
    // -X+Y+Z
    tri(-inn, h, inn, -h, inn, inn, -inn, inn, h, -inv3, inv3, inv3);
    // -X+Y-Z
    tri(-h, inn, -inn, -inn, h, -inn, -inn, inn, -h, -inv3, inv3, -inv3);
    // -X-Y+Z
    tri(-h, -inn, inn, -inn, -h, inn, -inn, -inn, h, -inv3, -inv3, inv3);
    // -X-Y-Z
    tri(-inn, -inn, -h, -inn, -h, -inn, -h, -inn, -inn, -inv3, -inv3, -inv3);

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
        uvs: new Float32Array(uvs),
    };
}
