// Voronoi mesh fracture — ports the half-space clipping approach from
// CedricGuillemet/64Kb5 `src/edit/DynamicsEdit.cpp` (BuildVoronoiMesh /
// ClipMeshRaw / voronoiPlanes) to Babylon Lite, with UV interpolation added.
//
// For each seed point we build the set of perpendicular-bisector half-space
// planes against every other seed (the Voronoi cell of that seed) and clip the
// source mesh against them with the Sutherland–Hodgman algorithm. Original
// surface triangles keep the source mesh's material; the newly generated cut
// surfaces ("caps") are emitted as separate meshes using a caller-provided
// material. Each cell is nudged radially outward so the break is visible.
//
// A Babylon Lite mesh carries exactly one material, so every cell yields up to
// two meshes: a "shell" (original material) and a "cap" (provided material),
// both sharing the same outward offset so the cell moves as a unit.

import type { EngineContext, Material, Mesh } from "babylon-lite";
import { createMeshFromData, setParent } from "babylon-lite";

/** Position + normal + UV vertex used through the clipping pipeline. */
interface FVertex {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    u: number;
    v: number;
}

/** Half-space plane `dot(n, p) - w >= 0` keeps points on the +normal side. */
interface Plane {
    nx: number;
    ny: number;
    nz: number;
    w: number;
}

interface RawGeom {
    verts: FVertex[];
    indices: number[];
}

/** Options controlling how the fractured cells are laid out. */
export interface BreakMeshOptions {
    /** Outward separation between cells, as a fraction of the model's largest
     *  dimension. 0 leaves cells touching. Default 0.12. */
    separation?: number;
    /** Planar-projection scale for generated cap UVs, in model-size units.
     *  Larger = more texture repeats across a cut face. Default 4. */
    capUvScale?: number;
    /** Whether generated pieces should receive shadows. Default true. */
    receiveShadows?: boolean;
}

function planeDist(p: Plane, x: number, y: number, z: number): number {
    return p.nx * x + p.ny * y + p.nz * z - p.w;
}

/** Interpolate a vertex along edge a→b at parameter t (position, normal, UV). */
function lerpVert(a: FVertex, b: FVertex, t: number): FVertex {
    let nx = a.nx + (b.nx - a.nx) * t;
    let ny = a.ny + (b.ny - a.ny) * t;
    let nz = a.nz + (b.nz - a.nz) * t;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
        nx /= len;
        ny /= len;
        nz /= len;
    }
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        nx,
        ny,
        nz,
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
    };
}

/** Sutherland–Hodgman: clip a convex polygon to the +side of a plane. */
function clipPolygonByPlane(input: FVertex[], plane: Plane): FVertex[] {
    const out: FVertex[] = [];
    const n = input.length;
    if (n === 0) {
        return out;
    }
    for (let i = 0; i < n; i++) {
        const s = input[i]!;
        const e = input[(i + 1) % n]!;
        const ds = planeDist(plane, s.x, s.y, s.z);
        const de = planeDist(plane, e.x, e.y, e.z);
        if (de >= 0) {
            if (ds < 0) {
                out.push(lerpVert(s, e, ds / (ds - de)));
            }
            out.push(e);
        } else if (ds >= 0) {
            out.push(lerpVert(s, e, ds / (ds - de)));
        }
    }
    return out;
}

/** Build the perpendicular-bisector half-spaces that define seed `i`'s cell. */
function voronoiPlanes(sites: number[][], i: number): Plane[] {
    const planes: Plane[] = [];
    const pi = sites[i]!;
    for (let j = 0; j < sites.length; j++) {
        if (j === i) {
            continue;
        }
        const pj = sites[j]!;
        let dx = pi[0]! - pj[0]!;
        let dy = pi[1]! - pj[1]!;
        let dz = pi[2]! - pj[2]!;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) {
            continue;
        }
        dx /= len;
        dy /= len;
        dz /= len;
        const mx = (pi[0]! + pj[0]!) * 0.5;
        const my = (pi[1]! + pj[1]!) * 0.5;
        const mz = (pi[2]! + pj[2]!) * 0.5;
        planes.push({ nx: dx, ny: dy, nz: dz, w: dx * mx + dy * my + dz * mz });
    }
    return planes;
}

/** Orthonormal in-plane basis (tangent, bitangent) for a given normal. */
function planeBasis(nx: number, ny: number, nz: number): [number, number, number, number, number, number] {
    // Pick an up vector that isn't near-parallel to the normal.
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (Math.abs(ny) > 0.9) {
        ux = 1;
        uy = 0;
        uz = 0;
    }
    // tangent = normalize(cross(n, up))
    let tx = ny * uz - nz * uy;
    let ty = nz * ux - nx * uz;
    let tz = nx * uy - ny * ux;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // bitangent = cross(n, tangent)
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    return [tx, ty, tz, bx, by, bz];
}

/** Is 2D point `p` inside triangle (a,b,c)? (winding-agnostic, boundary counts as inside). */
function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple polygon given as 2D coords `[u, v]` per
 * vertex. Returns triangles as index triples into the input. Handles concave
 * polygons (unlike a naive triangle fan) and preserves the input winding, so the
 * generated cap faces keep the correct orientation.
 */
function triangulatePolygon2D(uv: number[][]): [number, number, number][] {
    const n = uv.length;
    const out: [number, number, number][] = [];
    if (n < 3) {
        return out;
    }
    // Signed area → winding sign; a vertex is convex when its turn matches it.
    let area = 0;
    for (let i = 0; i < n; i++) {
        const a = uv[i]!;
        const b = uv[(i + 1) % n]!;
        area += a[0]! * b[1]! - b[0]! * a[1]!;
    }
    const s = area >= 0 ? 1 : -1;
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
        v.push(i);
    }
    let guard = 0;
    while (v.length > 3 && guard++ < n * n + 4) {
        let clipped = false;
        for (let vi = 0; vi < v.length; vi++) {
            const i0 = v[(vi + v.length - 1) % v.length]!;
            const i1 = v[vi]!;
            const i2 = v[(vi + 1) % v.length]!;
            const a = uv[i0]!;
            const b = uv[i1]!;
            const c = uv[i2]!;
            // Convex (ear tip candidate) only if the turn agrees with the winding.
            const cross = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
            if (cross * s <= 0) {
                continue;
            }
            let ok = true;
            for (const vk of v) {
                if (vk === i0 || vk === i1 || vk === i2) {
                    continue;
                }
                const q = uv[vk]!;
                if (pointInTriangle(q[0]!, q[1]!, a[0]!, a[1]!, b[0]!, b[1]!, c[0]!, c[1]!)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) {
                continue;
            }
            out.push([i0, i1, i2]);
            v.splice(vi, 1);
            clipped = true;
            break;
        }
        if (!clipped) {
            break; // degenerate remainder — stop rather than loop forever
        }
    }
    if (v.length === 3) {
        out.push([v[0]!, v[1]!, v[2]!]);
    }
    return out;
}

/**
 * Clip a set of world-space triangles to a single Voronoi cell, returning the
 * clipped original surface ("shell") and the reconstructed cut faces ("cap")
 * as separate geometry so they can carry different materials.
 */
function clipCell(tris: FVertex[], planes: Plane[], capUvScale: number): { shell: RawGeom; cap: RawGeom } {
    const shell: RawGeom = { verts: [], indices: [] };
    const cap: RawGeom = { verts: [], indices: [] };
    const planeCount = planes.length;
    const capEdges: [FVertex, FVertex][][] = Array.from({ length: planeCount }, () => []);
    const triCount = (tris.length / 3) | 0;

    for (let t = 0; t < triCount; t++) {
        const orig = [tris[t * 3]!, tris[t * 3 + 1]!, tris[t * 3 + 2]!];

        // Record the entry/exit points where this triangle crosses each plane —
        // these seed the cap polygons for the cut surfaces.
        for (let p = 0; p < planeCount; p++) {
            const plane = planes[p]!;
            let entry: FVertex | null = null;
            let exit: FVertex | null = null;
            for (let i = 0; i < 3; i++) {
                const s = orig[i]!;
                const e = orig[(i + 1) % 3]!;
                const ds = planeDist(plane, s.x, s.y, s.z);
                const de = planeDist(plane, e.x, e.y, e.z);
                if (ds < 0 && de >= 0) {
                    entry = lerpVert(s, e, ds / (ds - de));
                } else if (ds >= 0 && de < 0) {
                    exit = lerpVert(s, e, ds / (ds - de));
                }
            }
            if (entry && exit) {
                capEdges[p]!.push([entry, exit]);
            }
        }

        // Clip the triangle against all cell planes, fan-triangulate the result.
        let poly: FVertex[] = [orig[0]!, orig[1]!, orig[2]!];
        for (let p = 0; p < planeCount && poly.length; p++) {
            poly = clipPolygonByPlane(poly, planes[p]!);
        }
        if (poly.length >= 3) {
            const base = shell.verts.length;
            for (const v of poly) {
                shell.verts.push(v);
            }
            for (let i = 1; i < poly.length - 1; i++) {
                shell.indices.push(base, base + i, base + i + 1);
            }
        }
    }

    // Reconstruct the cut faces on each plane. A single plane cut through a
    // non-convex mesh yields MULTIPLE disjoint boundary contours (the body
    // outline plus every hole), so we chain ALL entry/exit edges into as many
    // loops as exist — not just the first — and ear-clip each. Cap normal = -n.
    for (let p = 0; p < planeCount; p++) {
        const edges = capEdges[p]!;
        if (edges.length === 0) {
            continue;
        }
        const plane = planes[p]!;
        const cnx = -plane.nx;
        const cny = -plane.ny;
        const cnz = -plane.nz;
        const [tx, ty, tz, bx, by, bz] = planeBasis(cnx, cny, cnz);
        const used = new Array<boolean>(edges.length).fill(false);

        for (let seed = 0; seed < edges.length; seed++) {
            if (used[seed]) {
                continue;
            }
            used[seed] = true;
            let capPoly: FVertex[] = [edges[seed]![0], edges[seed]![1]];
            // Greedily chain edges whose start meets the current loop end, until
            // the contour closes or no further edge connects.
            for (;;) {
                const last = capPoly[capPoly.length - 1]!;
                let found = false;
                for (let i = 0; i < edges.length; i++) {
                    if (used[i]) {
                        continue;
                    }
                    const ea = edges[i]![0];
                    const dx = ea.x - last.x;
                    const dy = ea.y - last.y;
                    const dz = ea.z - last.z;
                    if (dx * dx + dy * dy + dz * dz < 1e-8) {
                        used[i] = true;
                        const eb = edges[i]![1];
                        const start = capPoly[0]!;
                        const dx2 = eb.x - start.x;
                        const dy2 = eb.y - start.y;
                        const dz2 = eb.z - start.z;
                        if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 >= 1e-8) {
                            capPoly.push(eb);
                        }
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    break;
                }
            }
            // Bound this contour to the cell by clipping against the other planes.
            for (let q = 0; q < planeCount && capPoly.length; q++) {
                if (q === p) {
                    continue;
                }
                capPoly = clipPolygonByPlane(capPoly, planes[q]!);
            }
            if (capPoly.length < 3) {
                continue;
            }

            const base = cap.verts.length;
            const poly2d: number[][] = new Array<number[]>(capPoly.length);
            for (let i = 0; i < capPoly.length; i++) {
                const v = capPoly[i]!;
                // Planar-projected UVs on the cut plane so the cap material tiles
                // consistently across the exposed interior. The unscaled (u, v) is
                // reused as the ear-clipping projection.
                const pu = v.x * tx + v.y * ty + v.z * tz;
                const pv = v.x * bx + v.y * by + v.z * bz;
                cap.verts.push({ x: v.x, y: v.y, z: v.z, nx: cnx, ny: cny, nz: cnz, u: pu * capUvScale, v: pv * capUvScale });
                poly2d[i] = [pu, pv];
            }
            for (const [a, b, c] of triangulatePolygon2D(poly2d)) {
                cap.indices.push(base + a, base + b, base + c);
            }
        }
    }

    return { shell, cap };
}

function buildMesh(engine: EngineContext, name: string, geom: RawGeom, material: Material, offset: [number, number, number], receiveShadows: boolean): Mesh {
    const n = geom.verts.length;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
        const v = geom.verts[i]!;
        positions[i * 3] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;
        normals[i * 3] = v.nx;
        normals[i * 3 + 1] = v.ny;
        normals[i * 3 + 2] = v.nz;
        uvs[i * 2] = v.u;
        uvs[i * 2 + 1] = v.v;
    }
    // Orient each triangle so its winding is consistent with the baked vertex
    // normals (which point outward), so faces cull correctly regardless of the
    // source transform's handedness/scale. A determinant test on the transform
    // isn't reliable here because the clipped/re-triangulated winding doesn't
    // always track the transform's sign.
    const src = geom.indices;
    const indices = new Uint32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
        const a = src[i]!;
        const b = src[i + 1]!;
        const c = src[i + 2]!;
        const ax = positions[a * 3]!;
        const ay = positions[a * 3 + 1]!;
        const az = positions[a * 3 + 2]!;
        const e1x = positions[b * 3]! - ax;
        const e1y = positions[b * 3 + 1]! - ay;
        const e1z = positions[b * 3 + 2]! - az;
        const e2x = positions[c * 3]! - ax;
        const e2y = positions[c * 3 + 1]! - ay;
        const e2z = positions[c * 3 + 2]! - az;
        const gx = e1y * e2z - e1z * e2y;
        const gy = e1z * e2x - e1x * e2z;
        const gz = e1x * e2y - e1y * e2x;
        const nx = normals[a * 3]! + normals[b * 3]! + normals[c * 3]!;
        const ny = normals[a * 3 + 1]! + normals[b * 3 + 1]! + normals[c * 3 + 1]!;
        const nz = normals[a * 3 + 2]! + normals[b * 3 + 2]! + normals[c * 3 + 2]!;
        // Lite uses a left-handed (Babylon) convention, so a correctly front-facing
        // triangle's right-handed geometric normal points OPPOSITE the outward vertex
        // normal — keep that orientation, flip the other.
        const keep = gx * nx + gy * ny + gz * nz <= 0;
        indices[i] = a;
        indices[i + 1] = keep ? b : c;
        indices[i + 2] = keep ? c : b;
    }
    const mesh = createMeshFromData(engine, name, positions, normals, indices, uvs);
    mesh.material = material;
    mesh.receiveShadows = receiveShadows;
    mesh.position.set(offset[0], offset[1], offset[2]);
    return mesh;
}

/**
 * Fracture a mesh into per-cell pieces using Voronoi half-space clipping.
 *
 * @param engine - Engine used to allocate the generated meshes' GPU geometry.
 * @param sourceMesh - Mesh to break; must retain CPU geometry (any Lite factory
 *   or loader mesh does). Its world transform is baked into the pieces.
 * @param points - Seed sites in world space; one Voronoi cell is produced per
 *   seed. Provide 2+ points for a meaningful fracture.
 * @param capMaterial - Material applied to the generated interior cut faces.
 * @param options - Layout tuning (separation, cap UV scale, receiveShadows).
 * @returns A flat array of generated meshes. Each cell contributes a "shell"
 *   mesh (original material, a scene root) and, when it has cut faces, a "cap"
 *   mesh (cap material) parented to that shell — so one physics body on each
 *   shell (a root, `parent == null`) drives the whole cell, caps included.
 */
export function breakMesh(engine: EngineContext, sourceMesh: Mesh, points: number[][], capMaterial: Material, options: BreakMeshOptions = {}): Mesh[] {
    const separation = options.separation ?? 0.12;
    const receiveShadows = options.receiveShadows ?? true;

    const g = sourceMesh as unknown as {
        _cpuPositions?: Float32Array;
        _cpuNormals?: Float32Array;
        _cpuUvs?: Float32Array;
        _cpuIndices?: Uint32Array;
        worldMatrix: Float32Array;
        name?: string;
    };
    const pos = g._cpuPositions;
    const nor = g._cpuNormals;
    const uv = g._cpuUvs;
    const idx = g._cpuIndices;
    if (!pos || !nor || !idx || points.length < 2) {
        return [];
    }
    const w = g.worldMatrix;

    // Bake the world transform into world-space triangles (positions + normals).
    // Normals use the rotation/uniform-scale part of `w` and are renormalised —
    // correct for the rigid/uniform transforms glTF nodes use here.
    const tris: FVertex[] = new Array<FVertex>(idx.length);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < idx.length; i++) {
        const vi = idx[i]!;
        const p = vi * 3;
        const t = vi * 2;
        const lx = pos[p]!;
        const ly = pos[p + 1]!;
        const lz = pos[p + 2]!;
        const x = w[0]! * lx + w[4]! * ly + w[8]! * lz + w[12]!;
        const y = w[1]! * lx + w[5]! * ly + w[9]! * lz + w[13]!;
        const z = w[2]! * lx + w[6]! * ly + w[10]! * lz + w[14]!;
        let nx = w[0]! * nor[p]! + w[4]! * nor[p + 1]! + w[8]! * nor[p + 2]!;
        let ny = w[1]! * nor[p]! + w[5]! * nor[p + 1]! + w[9]! * nor[p + 2]!;
        let nz = w[2]! * nor[p]! + w[6]! * nor[p + 1]! + w[10]! * nor[p + 2]!;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        tris[i] = { x, y, z, nx, ny, nz, u: uv ? uv[t]! : 0, v: uv ? uv[t + 1]! : 0 };
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-4);
    const capUvScale = (options.capUvScale ?? 4) / size;
    const gap = size * separation;

    const pieces: Mesh[] = [];
    const baseName = g.name ?? "mesh";
    for (let i = 0; i < points.length; i++) {
        const planes = voronoiPlanes(points, i);
        const { shell, cap } = clipCell(tris, planes, capUvScale);
        if (shell.verts.length === 0 && cap.verts.length === 0) {
            continue;
        }
        // Push the whole cell outward from the model centre so neighbouring cells
        // separate and the fracture is legible.
        const site = points[i]!;
        let ox = site[0]! - cx;
        let oy = site[1]! - cy;
        let oz = site[2]! - cz;
        const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
        if (ol > 1e-6) {
            ox = (ox / ol) * gap;
            oy = (oy / ol) * gap;
            oz = (oz / ol) * gap;
        } else {
            ox = oy = oz = 0;
        }
        const offset: [number, number, number] = [ox, oy, oz];

        let shellMesh: Mesh | null = null;
        if (shell.verts.length >= 3) {
            shellMesh = buildMesh(engine, `${baseName}-cell${i}-shell`, shell, sourceMesh.material, offset, receiveShadows);
            pieces.push(shellMesh);
        }
        if (cap.verts.length >= 3) {
            const capMesh = buildMesh(engine, `${baseName}-cell${i}-cap`, cap, capMaterial, offset, receiveShadows);
            // Parent the cut faces to the cell's shell so the whole cell behaves as ONE
            // rigid unit: a single physics body created on the shell then drives both, and
            // the convex-hull builder (which walks node.children) folds the cap into the
            // shell's hull. setParent keeps the world transform + children array in sync.
            if (shellMesh) {
                setParent(capMesh, shellMesh);
            }
            pieces.push(capMesh);
        }
    }
    return pieces;
}
