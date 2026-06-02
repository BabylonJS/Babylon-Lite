// Procedural terrain generation. Pure & deterministic: generateChunk fills a
// chunk's block array purely from (seed, cx, cz), so neighbouring chunks always
// agree at their shared borders (no seams) and the world is reproducible.
//
// Trees are stamped by scanning a margin of columns around the chunk so a trunk
// rooted just outside this chunk still spills its leaves in correctly.

import { Block } from "./blocks.js";
import { CHUNK_SX, CHUNK_SZ, WORLD_H, SEA_LEVEL, blockIndex } from "./constants.js";
import { fbm2, valueNoise3, rand3 } from "./noise.js";

const TREE_MARGIN = 2; // leaf canopy radius, in blocks

/** Surface height (Y of the topmost solid ground block) for a world column. */
function heightAt(seed: number, wx: number, wz: number): number {
    // Large-scale continents + medium hills + fine detail. The continent term is
    // centred slightly below sea level so basins flood into lakes and oceans while
    // landmasses still rise well above the water.
    const continent = fbm2(seed, wx / 220, wz / 220, 4);
    const hills = fbm2(seed + 7, wx / 70, wz / 70, 4);
    const detail = fbm2(seed + 19, wx / 24, wz / 24, 3);
    let h = SEA_LEVEL + (continent - 0.46) * 70 + (hills - 0.5) * 18 + (detail - 0.5) * 7;
    // Flatten low areas slightly so beaches/lakes read cleanly.
    if (h < SEA_LEVEL) h = SEA_LEVEL - (SEA_LEVEL - h) * 0.7;
    return Math.max(2, Math.min(WORLD_H - 12, Math.floor(h)));
}

const enum Biome {
    OCEAN,
    BEACH,
    DESERT,
    PLAINS,
    FOREST,
    SNOW,
}

/** Low-frequency climate fields in [0,1], independent of height. */
function temperature(seed: number, wx: number, wz: number): number {
    return fbm2(seed + 1300, wx / 360, wz / 360, 3);
}
function moisture(seed: number, wx: number, wz: number): number {
    return fbm2(seed + 2600, wx / 300, wz / 300, 3);
}

/** Classify a column's biome from its height and the climate fields. */
function biomeAt(seed: number, wx: number, wz: number, h: number): Biome {
    if (h <= SEA_LEVEL - 1) return Biome.OCEAN;
    if (h <= SEA_LEVEL + 1) return Biome.BEACH;
    if (h >= SEA_LEVEL + 38) return Biome.SNOW; // snow-capped high peaks only
    const t = temperature(seed, wx, wz);
    const m = moisture(seed, wx, wz);
    if (t < 0.28) return Biome.SNOW;
    if (t > 0.55 && m < 0.42) return Biome.DESERT;
    if (m > 0.55) return Biome.FOREST;
    return Biome.PLAINS;
}

/** Top surface block for a biome. */
function surfaceBlock(biome: Biome): Block {
    switch (biome) {
        case Biome.SNOW:
            return Block.SNOW;
        case Biome.DESERT:
        case Biome.BEACH:
        case Biome.OCEAN:
            return Block.SAND;
        default:
            return Block.GRASS;
    }
}

function carveCave(seed: number, wx: number, y: number, wz: number): boolean {
    if (y < 5 || y > SEA_LEVEL + 8) return false;
    const n = valueNoise3(seed + 101, wx / 18, y / 14, wz / 18);
    return n > 0.78;
}

function oreAt(seed: number, wx: number, y: number, wz: number): Block {
    const r = rand3(seed + 55, wx, y, wz);
    if (y < 14 && r > 0.992) return Block.DIAMOND_ORE;
    if (y < 22 && r > 0.99) return Block.GOLD_ORE;
    if (r > 0.978) return Block.IRON_ORE;
    if (r > 0.955) return Block.COAL_ORE;
    return Block.STONE;
}

function set(data: Uint8Array, x: number, y: number, z: number, id: Block): void {
    if (x < 0 || x >= CHUNK_SX || z < 0 || z >= CHUNK_SZ || y < 0 || y >= WORLD_H) return;
    data[blockIndex(x, y, z)] = id;
}

/** Stamp a tree whose trunk base is at world (bx, baseY, bz), clipped to this chunk. */
function stampTree(seed: number, data: Uint8Array, cx: number, cz: number, bx: number, baseY: number, bz: number): void {
    const trunkH = 4 + Math.floor(rand3(seed + 3, bx, 0, bz) * 3);
    const topY = baseY + trunkH;
    // Canopy: a small blob of leaves around the top.
    for (let dy = -2; dy <= 1; dy++) {
        const ly = topY + dy;
        const radius = dy >= 1 ? 1 : 2;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx * dx + dz * dz > radius * radius + 1) continue;
                // Trim corners on the widest layers for a rounder look.
                const lx = bx + dx - cx * CHUNK_SX;
                const lz = bz + dz - cz * CHUNK_SZ;
                if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ || ly < 0 || ly >= WORLD_H) continue;
                const idx = blockIndex(lx, ly, lz);
                if (data[idx] === Block.AIR) data[idx] = Block.LEAVES;
            }
        }
    }
    // Trunk overwrites leaves.
    for (let i = 0; i < trunkH; i++) {
        set(data, bx - cx * CHUNK_SX, baseY + i, bz - cz * CHUNK_SZ, Block.LOG);
    }
}

/** Stamp a vertical cactus (1-3 tall) at world (bx, baseY, bz), clipped to this chunk. */
function stampCactus(seed: number, data: Uint8Array, cx: number, cz: number, bx: number, baseY: number, bz: number): void {
    const tall = 1 + Math.floor(rand3(seed + 9, bx, 1, bz) * 3);
    for (let i = 0; i < tall; i++) {
        set(data, bx - cx * CHUNK_SX, baseY + i, bz - cz * CHUNK_SZ, Block.CACTUS);
    }
}

export function generateChunk(seed: number, cx: number, cz: number, data: Uint8Array): void {
    data.fill(Block.AIR);
    const baseX = cx * CHUNK_SX;
    const baseZ = cz * CHUNK_SZ;

    for (let x = 0; x < CHUNK_SX; x++) {
        for (let z = 0; z < CHUNK_SZ; z++) {
            const wx = baseX + x;
            const wz = baseZ + z;
            const h = heightAt(seed, wx, wz);
            const biome = biomeAt(seed, wx, wz, h);
            const surf = surfaceBlock(biome);

            for (let y = 0; y <= h; y++) {
                if (y === 0) {
                    data[blockIndex(x, y, z)] = Block.BEDROCK;
                    continue;
                }
                if (carveCave(seed, wx, y, wz)) continue;
                let id: Block;
                if (y === h) {
                    id = surf;
                } else if (y >= h - 3) {
                    id = surf === Block.SAND ? Block.SAND : Block.DIRT;
                } else {
                    id = oreAt(seed, wx, y, wz);
                }
                data[blockIndex(x, y, z)] = id;
            }

            // Water fills the ocean from sea level straight down until the first
            // solid block, flooding the seafloor AND any cave opening exposed
            // beneath it — so there is never an empty (air) pocket hanging
            // directly under the sea surface. Land columns (h >= SEA_LEVEL) get
            // no water. A cave sealed by a solid roof is left as air and only
            // floods later (via the runtime water sim) if the player digs into it.
            if (h < SEA_LEVEL) {
                for (let y = SEA_LEVEL - 1; y >= 1; y--) {
                    if (data[blockIndex(x, y, z)] !== Block.AIR) break;
                    data[blockIndex(x, y, z)] = Block.WATER;
                }
            }
        }
    }

    // Vegetation: scan a margin so trunks just outside the chunk still drop leaves in.
    // Tree/cactus density depends on the biome at each column.
    for (let x = -TREE_MARGIN; x < CHUNK_SX + TREE_MARGIN; x++) {
        for (let z = -TREE_MARGIN; z < CHUNK_SZ + TREE_MARGIN; z++) {
            const wx = baseX + x;
            const wz = baseZ + z;
            const h = heightAt(seed, wx, wz);
            if (h < SEA_LEVEL + 1) continue; // nothing on beaches / underwater
            // Skip columns whose surface block was carved away by a cave: rooting a
            // trunk on the missing surface would leave it floating over the cave
            // mouth. carveCave is pure in (seed,wx,y,wz), so this stays seam-safe
            // and matches the terrain fill above without needing neighbour data.
            if (carveCave(seed, wx, h, wz)) continue;
            const biome = biomeAt(seed, wx, wz, h);
            const r = rand3(seed + 777, wx, 5, wz);
            if (biome === Biome.FOREST && r > 0.985) {
                stampTree(seed, data, cx, cz, wx, h + 1, wz);
            } else if (biome === Biome.PLAINS && r > 0.995) {
                stampTree(seed, data, cx, cz, wx, h + 1, wz);
            } else if (biome === Biome.SNOW && r > 0.994) {
                stampTree(seed, data, cx, cz, wx, h + 1, wz);
            } else if (biome === Biome.DESERT && rand3(seed + 888, wx, 7, wz) > 0.99) {
                stampCactus(seed, data, cx, cz, wx, h + 1, wz);
            }
        }
    }
}
