// Culled voxel meshing with ambient occlusion. For every solid block we emit a
// quad per face that borders a non-occluding neighbour; interior faces are
// skipped. Each face maps to exactly one atlas tile (no greedy tiling), so UVs
// stay inside the tile cell. Per-vertex ambient occlusion + a per-face direction
// shade are baked into the vertex colour. Output is split into three batches by
// render mode (opaque / cutout / blend) so each can use the right pipeline.

import { Block, blockDef, lightOpaque, type RenderMode } from "./blocks.js";
import type { World } from "./world.js";
import type { BlockAtlas, TileRect } from "./atlas.js";
import { CHUNK_SX, CHUNK_SZ, WORLD_H } from "./constants.js";
import { MAX_LIGHT } from "./world-light.js";

export interface MeshGeometry {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
}

export interface ChunkMeshData {
    opaque: MeshGeometry | null;
    cutout: MeshGeometry | null;
    blend: MeshGeometry | null;
}

interface FaceSpec {
    n: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
    /** Which face-texture group to sample. */
    group: "top" | "side" | "bottom";
}

// Outward-facing quads. Corners are emitted in (cu,cv) order (0,0),(1,0),(1,1),(0,1).
// Face direction shade is computed in the material shader from the normal, so it
// can be combined with the dynamic sun; only ambient occlusion is baked here.
const FACES: FaceSpec[] = [
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], group: "top" },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], group: "bottom" },
    { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], group: "side" },
    { n: [-1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], group: "side" },
    { n: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0], group: "side" },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], group: "side" },
];

// occlusion 0 (most occluded) .. 3 (open) -> brightness multiplier.
const AO_LUT = [0.5, 0.68, 0.84, 1.0];

class Batch {
    pos: number[] = [];
    nrm: number[] = [];
    uv: number[] = [];
    col: number[] = [];
    idx: number[] = [];

    addFace(corners: [number, number, number][], rect: TileRect, normal: [number, number, number], ao: number[], sky: number[], blk: number[], fluid: boolean): void {
        const base = this.pos.length / 3;
        // Vertex colour packs four baked terms: r = ambient-occlusion multiplier,
        // g = skylight (0..1), b = blocklight (0..1), a = fluid flag (1 = animated
        // water surface, 0 = static). The shader combines them.
        const aoMul = [AO_LUT[ao[0]!]!, AO_LUT[ao[1]!]!, AO_LUT[ao[2]!]!, AO_LUT[ao[3]!]!];
        const fluidFlag = fluid ? 1 : 0;
        // (cu,cv): (0,0),(1,0),(1,1),(0,1) -> atlas corners.
        const uvU = [rect.u0, rect.u1, rect.u1, rect.u0];
        const uvV = [rect.v1, rect.v1, rect.v0, rect.v0];
        for (let i = 0; i < 4; i++) {
            this.pos.push(corners[i]![0], corners[i]![1], corners[i]![2]);
            this.nrm.push(normal[0], normal[1], normal[2]);
            this.uv.push(uvU[i]!, uvV[i]!);
            this.col.push(aoMul[i]!, sky[i]!, blk[i]!, fluidFlag);
        }
        // Flip the triangulation diagonal toward the brighter pair to avoid AO seams.
        if (ao[0]! + ao[2]! > ao[1]! + ao[3]!) {
            this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        } else {
            this.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
        }
    }

    toGeometry(): MeshGeometry | null {
        if (this.idx.length === 0) return null;
        return {
            positions: new Float32Array(this.pos),
            normals: new Float32Array(this.nrm),
            uvs: new Float32Array(this.uv),
            colors: new Float32Array(this.col),
            indices: new Uint32Array(this.idx),
        };
    }
}

function occludes(id: number): boolean {
    return blockDef(id)?.castsAO === true;
}

/** 0fps ambient-occlusion value for one vertex from its 3 plane neighbours. */
function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
    if (side1 && side2) return 0;
    return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

/** Decide whether block `cur`'s face toward neighbour `nb` should be drawn. */
function faceVisible(cur: number, nb: number): boolean {
    if (nb === Block.AIR) return true;
    const nd = blockDef(nb);
    if (!nd) return true;
    if (nd.hidesNeighborFaces) return false; // opaque neighbour fully covers it
    // Neighbour is transparent/cutout/fluid: hide only shared internal faces of same id.
    if (nb === cur) return false;
    return true;
}

export function meshChunk(world: World, cx: number, cz: number, atlas: BlockAtlas): ChunkMeshData {
    const opaque = new Batch();
    const cutout = new Batch();
    const blend = new Batch();
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    const batchFor = (mode: RenderMode): Batch => (mode === "blend" ? blend : mode === "cutout" ? cutout : opaque);

    for (let x = 0; x < CHUNK_SX; x++) {
        for (let z = 0; z < CHUNK_SZ; z++) {
            const wx = baseX + x;
            const wz = baseZ + z;
            for (let y = 0; y < WORLD_H; y++) {
                const cur = world.getBlock(wx, y, wz);
                if (cur === Block.AIR) continue;
                const cd = blockDef(cur);
                if (!cd) continue;

                for (const f of FACES) {
                    const nx = wx + f.n[0];
                    const ny = y + f.n[1];
                    const nz = wz + f.n[2];
                    const nb = world.getBlock(nx, ny, nz);
                    if (!faceVisible(cur, nb)) continue;

                    const tileName = cd.faces[f.group];
                    const rect = atlas.rects.get(tileName) ?? atlas.fallback;

                    // Four corner world positions for this face.
                    const corners: [number, number, number][] = [];
                    const aos: number[] = [];
                    const skies: number[] = [];
                    const blks: number[] = [];
                    const doAO = cd.renderMode !== "blend";
                    // Face base corner: shift +1 on each axis where the normal is
                    // positive or an edge vector points negative, so cu/cv in {0,1}
                    // sweep the unit face from its min corner.
                    const baseFx = wx + (f.n[0] > 0 ? 1 : 0) + (f.u[0] < 0 ? 1 : 0) + (f.v[0] < 0 ? 1 : 0);
                    const baseFy = y + (f.n[1] > 0 ? 1 : 0) + (f.u[1] < 0 ? 1 : 0) + (f.v[1] < 0 ? 1 : 0);
                    const baseFz = wz + (f.n[2] > 0 ? 1 : 0) + (f.u[2] < 0 ? 1 : 0) + (f.v[2] < 0 ? 1 : 0);
                    for (let c = 0; c < 4; c++) {
                        const cu = c === 1 || c === 2 ? 1 : 0;
                        const cv = c === 2 || c === 3 ? 1 : 0;
                        corners.push([baseFx + cu * f.u[0] + cv * f.v[0], baseFy + cu * f.u[1] + cv * f.v[1], baseFz + cu * f.u[2] + cv * f.v[2]]);

                        // The two side cells and the diagonal corner cell in the
                        // air-side plane, shared by AO and smooth lighting.
                        const su = cu === 1 ? 1 : -1;
                        const sv = cv === 1 ? 1 : -1;
                        const s1x = nx + su * f.u[0];
                        const s1y = ny + su * f.u[1];
                        const s1z = nz + su * f.u[2];
                        const s2x = nx + sv * f.v[0];
                        const s2y = ny + sv * f.v[1];
                        const s2z = nz + sv * f.v[2];
                        const cnx = nx + su * f.u[0] + sv * f.v[0];
                        const cny = ny + su * f.u[1] + sv * f.v[1];
                        const cnz = nz + su * f.u[2] + sv * f.v[2];
                        const b1 = world.getBlock(s1x, s1y, s1z);
                        const b2 = world.getBlock(s2x, s2y, s2z);
                        const bc = world.getBlock(cnx, cny, cnz);

                        if (doAO) {
                            aos.push(vertexAO(occludes(b1), occludes(b2), occludes(bc)));
                        } else {
                            aos.push(3);
                        }

                        // Smooth lighting: average sky/block light over the air-side
                        // cells touching this vertex, skipping light-opaque cells (and
                        // the diagonal when both sides are blocked, to avoid leaks).
                        const o1 = lightOpaque(b1);
                        const o2 = lightOpaque(b2);
                        const oc = lightOpaque(bc);
                        const pf = world.getLightPacked(nx, ny, nz);
                        let skySum = pf >> 4;
                        let blkSum = pf & 15;
                        let cnt = 1;
                        if (!o1) {
                            const p = world.getLightPacked(s1x, s1y, s1z);
                            skySum += p >> 4;
                            blkSum += p & 15;
                            cnt++;
                        }
                        if (!o2) {
                            const p = world.getLightPacked(s2x, s2y, s2z);
                            skySum += p >> 4;
                            blkSum += p & 15;
                            cnt++;
                        }
                        if (!oc && !(o1 && o2)) {
                            const p = world.getLightPacked(cnx, cny, cnz);
                            skySum += p >> 4;
                            blkSum += p & 15;
                            cnt++;
                        }
                        skies.push(skySum / cnt / MAX_LIGHT);
                        blks.push(blkSum / cnt / MAX_LIGHT);
                    }

                    batchFor(cd.renderMode).addFace(corners, rect, f.n, aos, skies, blks, cd.fluid === true || cd.sway === true);
                }
            }
        }
    }

    return { opaque: opaque.toGeometry(), cutout: cutout.toGeometry(), blend: blend.toGeometry() };
}
