// Shared world constants. Kept dependency-free so both worldgen and the chunk
// store can import them without cycles.

export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
export const WORLD_H = 96;

/** Sea level (water fills up to, but not including, this Y). */
export const SEA_LEVEL = 30;

/** Linear index into a chunk's flat block array. */
export function blockIndex(x: number, y: number, z: number): number {
    return (y * CHUNK_SZ + z) * CHUNK_SX + x;
}

export function chunkKey(cx: number, cz: number): string {
    return cx + "," + cz;
}
