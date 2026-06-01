// Seeded, deterministic noise for terrain generation. Integer-hash value noise
// with fractional Brownian motion (fBm). No external deps; identical output for
// a given seed across runs so the world is reproducible and chunk borders match.

function hash2(seed: number, ix: number, iy: number): number {
    let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    // Map to [0,1)
    return (h >>> 0) / 4294967296;
}

function hash3(seed: number, ix: number, iy: number, iz: number): number {
    let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Value noise in [0,1] at (x,y). */
export function valueNoise2(seed: number, x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const v00 = hash2(seed, x0, y0);
    const v10 = hash2(seed, x0 + 1, y0);
    const v01 = hash2(seed, x0, y0 + 1);
    const v11 = hash2(seed, x0 + 1, y0 + 1);
    return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/** Value noise in [0,1] at (x,y,z). */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const fz = smooth(z - z0);
    const c000 = hash3(seed, x0, y0, z0);
    const c100 = hash3(seed, x0 + 1, y0, z0);
    const c010 = hash3(seed, x0, y0 + 1, z0);
    const c110 = hash3(seed, x0 + 1, y0 + 1, z0);
    const c001 = hash3(seed, x0, y0, z0 + 1);
    const c101 = hash3(seed, x0 + 1, y0, z0 + 1);
    const c011 = hash3(seed, x0, y0 + 1, z0 + 1);
    const c111 = hash3(seed, x0 + 1, y0 + 1, z0 + 1);
    const x00 = lerp(c000, c100, fx);
    const x10 = lerp(c010, c110, fx);
    const x01 = lerp(c001, c101, fx);
    const x11 = lerp(c011, c111, fx);
    return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

/** fBm over value noise: sum of octaves at decreasing amplitude. Output [0,1]. */
export function fbm2(seed: number, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += amp * valueNoise2(seed + o * 1013, x * freq, y * freq);
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    return sum / norm;
}

/** A small deterministic [0,1) value keyed on three ints — handy for scatter/decoration. */
export function rand3(seed: number, x: number, y: number, z: number): number {
    return hash3(seed, x, y, z);
}
