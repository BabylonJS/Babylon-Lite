/**
 * Procedural geometry for a rounded unit cube — the same volume as a regular
 * box but with all 12 edges replaced by quarter-cylinder fillets and all 8
 * corners by spherical octants, giving smoothly rounded, "beveled" blocks.
 *
 * Why: a perfect 90° cube reads as "developer primitive". Real moulded plastic
 * blocks always have a generous radius on every edge, which sweeps a soft
 * specular highlight all the way around each silhouette line — that continuous
 * rolling glint is what your eye uses to recognise "manufactured object" vs
 * "math abstraction". Multi-segment fillets (vs a single flat chamfer) make the
 * highlight roll smoothly instead of snapping between three flat facets.
 *
 * Construction (size = 1, radius = r, inn = size/2 − r):
 *   6 flat face quads, inset to ±(size/2) on their axis and spanning
 *      [−inn, inn] on the other two — flat face normals.
 *   12 quarter-cylinder edge fillets (one per cube edge), each `seg` quads
 *      sweeping a 90° arc; normals are radial about the edge axis.
 *   8 spherical-octant corner fillets (`seg × seg` grid); normals are radial
 *      about the corner centre. The top latitude band collapses to a pole —
 *      those zero-area triangles are dropped.
 *
 * Each patch owns its own vertices (no sharing across patches) so face normals
 * stay flat, but seam vertices coincide in both position and normal, so the
 * surface looks watertight and shades smoothly across the fillets. Triangle
 * winding is derived per-triangle from the geometric normal vs. the outward
 * (averaged vertex) normal, so the mesh is robust under backface culling
 * regardless of parameterisation sign conventions.
 *
 * Cheap enough to thin-instance across the whole board (≤ ~204 instances): at
 * seg = 3 the cube is ~250 vertices with no per-instance cost beyond the matrix.
 */

export interface RoundedBoxData {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs: Float32Array;
}

export function createRoundedBoxData(size = 1, radius = 0.2, seg = 3): RoundedBoxData {
    const h = size * 0.5;
    const r = Math.min(radius, h - 1e-4);
    const inn = h - r; // inner (flat-face) half-extent
    const HALF_PI = Math.PI / 2;
    const EPS = 1e-9;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Emit one triangle, choosing the winding that makes its geometric normal
    // agree with the outward (averaged vertex) normal. Zero-area triangles
    // (e.g. the degenerate quads at a corner's spherical pole) are skipped.
    function addTri(i0: number, i1: number, i2: number): void {
        const ax = positions[i0 * 3]!,
            ay = positions[i0 * 3 + 1]!,
            az = positions[i0 * 3 + 2]!;
        const bx = positions[i1 * 3]!,
            by = positions[i1 * 3 + 1]!,
            bz = positions[i1 * 3 + 2]!;
        const cx = positions[i2 * 3]!,
            cy = positions[i2 * 3 + 1]!,
            cz = positions[i2 * 3 + 2]!;
        const e1x = bx - ax,
            e1y = by - ay,
            e1z = bz - az;
        const e2x = cx - ax,
            e2y = cy - ay,
            e2z = cz - az;
        const gx = e1y * e2z - e1z * e2y;
        const gy = e1z * e2x - e1x * e2z;
        const gz = e1x * e2y - e1y * e2x;
        if (gx * gx + gy * gy + gz * gz < EPS) {
            return; // degenerate (zero-area) triangle
        }
        const onx = normals[i0 * 3]! + normals[i1 * 3]! + normals[i2 * 3]!;
        const ony = normals[i0 * 3 + 1]! + normals[i1 * 3 + 1]! + normals[i2 * 3 + 1]!;
        const onz = normals[i0 * 3 + 2]! + normals[i1 * 3 + 2]! + normals[i2 * 3 + 2]!;
        if (gx * onx + gy * ony + gz * onz >= 0) {
            indices.push(i0, i1, i2);
        } else {
            indices.push(i0, i2, i1);
        }
    }

    // Build a (rows+1)×(cols+1) vertex grid from `vert` and stitch it into quads.
    // `vert(i, j)` returns [px, py, pz, nx, ny, nz]; the normal is normalised here.
    function addGrid(rows: number, cols: number, vert: (i: number, j: number) => [number, number, number, number, number, number]): void {
        const base = positions.length / 3;
        const stride = cols + 1;
        for (let i = 0; i <= rows; i++) {
            for (let j = 0; j <= cols; j++) {
                const [px, py, pz, nx, ny, nz] = vert(i, j);
                const len = Math.hypot(nx, ny, nz) || 1;
                positions.push(px, py, pz);
                normals.push(nx / len, ny / len, nz / len);
                uvs.push(j / cols, i / rows);
            }
        }
        for (let i = 0; i < rows; i++) {
            for (let j = 0; j < cols; j++) {
                const a = base + i * stride + j;
                const b = base + i * stride + j + 1;
                const c = base + (i + 1) * stride + j + 1;
                const d = base + (i + 1) * stride + j;
                addTri(a, b, c);
                addTri(a, c, d);
            }
        }
    }

    // ── 6 flat face quads ────────────────────────────────────────────────
    for (let axis = 0; axis < 3; axis++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        for (const s of [-1, 1] as const) {
            addGrid(1, 1, (i, j) => {
                const p: [number, number, number] = [0, 0, 0];
                const n: [number, number, number] = [0, 0, 0];
                p[axis] = s * h;
                p[u] = j === 0 ? -inn : inn;
                p[v] = i === 0 ? -inn : inn;
                n[axis] = s;
                return [p[0], p[1], p[2], n[0], n[1], n[2]];
            });
        }
    }

    // ── 12 quarter-cylinder edge fillets ─────────────────────────────────
    // For each edge axis `e`, sweep a 90° arc (cols = seg) in the plane of the
    // other two axes (u, v) at each of the four (su, sv) corners; the edge runs
    // the full inner length along `e` (rows = 1, ends at ±inn).
    for (let e = 0; e < 3; e++) {
        const u = (e + 1) % 3;
        const v = (e + 2) % 3;
        for (const su of [-1, 1] as const) {
            for (const sv of [-1, 1] as const) {
                addGrid(1, seg, (i, j) => {
                    const t = (j / seg) * HALF_PI;
                    const du = su * Math.cos(t);
                    const dv = sv * Math.sin(t);
                    const p: [number, number, number] = [0, 0, 0];
                    const n: [number, number, number] = [0, 0, 0];
                    p[u] = su * inn + r * du;
                    p[v] = sv * inn + r * dv;
                    p[e] = i === 0 ? -inn : inn;
                    n[u] = du;
                    n[v] = dv;
                    return [p[0], p[1], p[2], n[0], n[1], n[2]];
                });
            }
        }
    }

    // ── 8 spherical-octant corner fillets ────────────────────────────────
    for (const sx of [-1, 1] as const) {
        for (const sy of [-1, 1] as const) {
            for (const sz of [-1, 1] as const) {
                addGrid(seg, seg, (i, j) => {
                    const phi = (i / seg) * HALF_PI;
                    const th = (j / seg) * HALF_PI;
                    const cphi = Math.cos(phi);
                    const dx = sx * cphi * Math.cos(th);
                    const dy = sy * cphi * Math.sin(th);
                    const dz = sz * Math.sin(phi);
                    return [sx * inn + r * dx, sy * inn + r * dy, sz * inn + r * dz, dx, dy, dz];
                });
            }
        }
    }

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
        uvs: new Float32Array(uvs),
    };
}
