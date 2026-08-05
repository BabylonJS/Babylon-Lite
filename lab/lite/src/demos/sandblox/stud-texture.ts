/**
 * Procedural stud textures for block tops.
 *
 * Generates a single-stud tile (base color + normal map) that tiles seamlessly
 * across the ground. The stud is a small rounded square (outset / raised) with
 * a sharp bevel at the edges for a raised plastic-tile look.
 *
 * The base-color texture is near-white grayscale so that the material's
 * `diffuseColor` controls the overall hue while the texture adds subtle stud
 * shading. The normal map is derived from a smooth heightfield via finite
 * differences, giving studs a convincing 3-D raised appearance.
 */

import type { EngineContext, Texture2D } from "babylon-lite";
import { loadTexture2D } from "babylon-lite";

// ── Tuning constants ─────────────────────────────────────────────────────────

/** Pixel resolution of one stud tile. Higher = smoother edges, more memory. */
const TILE_PX = 64;

/** Stud half-size as a fraction of the tile (0 … 0.5). Stud width = 2 × this. */
const STUD_HALF_SIZE = 0.25;

/** Corner rounding radius as a fraction of the tile. */
const CORNER_RADIUS = 0.12;

/** Bevel width in pixels — controls sharpness of the stud edge transition. */
const BEVEL_PX = 2;

/** Normal-map gradient strength. Higher = more pronounced 3-D edges. */
const NORMAL_STRENGTH = 8.0;

// ── Public API ───────────────────────────────────────────────────────────────

export interface StudTextures {
    /** Near-white diffuse texture — modulates diffuseColor with stud shading. */
    readonly baseColor: Texture2D;
    /** Tangent-space normal map for the raised stud bump. */
    readonly normalMap: Texture2D;
}

/**
 * Generate a pair of tiling stud textures (base color + normal map).
 *
 * Both textures represent a single stud cell and are configured with `repeat`
 * addressing so that the material's `uvScale` controls how many studs appear.
 * Mipmaps are generated via `loadTexture2D` so the studs look clean at distance.
 */
export async function createStudTextures(engine: EngineContext): Promise<StudTextures> {
    const size = TILE_PX;
    const heightField = generateStudHeightField(size);
    const baseColorData = generateBaseColorFromHeightField(heightField, size);
    const normalMapData = generateNormalMapFromHeightField(heightField, size);

    const loadOpts = {
        addressModeU: "repeat" as const,
        addressModeV: "repeat" as const,
        invertY: false,
    };

    const [baseColor, normalMap] = await Promise.all([
        pixelsToTexture(engine, baseColorData, size, loadOpts),
        pixelsToTexture(engine, normalMapData, size, loadOpts),
    ]);

    return { baseColor, normalMap };
}

/**
 * Upload RGBA8 pixels via OffscreenCanvas → blob URL → loadTexture2D,
 * giving us automatic mipmap generation and trilinear sampling.
 */
async function pixelsToTexture(engine: EngineContext, rgba: Uint8Array, size: number, opts: Parameters<typeof loadTexture2D>[2]): Promise<Texture2D> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0); // value copy — TS 5.7 ArrayBufferLike split rejects the buffer view
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const url = URL.createObjectURL(blob);
    const tex = await loadTexture2D(engine, url, opts);
    URL.revokeObjectURL(url);
    return tex;
}

// ── Heightfield generation ───────────────────────────────────────────────────

/**
 * Build a [0…1] heightfield for a single stud: 1.0 on the flat stud top,
 * sharp bevel at the rim, 0.0 on the base plane.
 *
 * Uses a rounded-box signed distance field for the blocky stud shape.
 */
function generateStudHeightField(size: number): Float32Array {
    const heights = new Float32Array(size * size);
    const center = size / 2;
    const halfPx = STUD_HALF_SIZE * size;
    const cornerPx = CORNER_RADIUS * size;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = x + 0.5 - center;
            const py = y + 0.5 - center;
            const dist = sdRoundedBox(px, py, halfPx, cornerPx);
            // dist < 0 inside, > 0 outside; map to 1 inside → 0 outside
            heights[y * size + x] = smoothstep(BEVEL_PX, -BEVEL_PX, dist);
        }
    }
    return heights;
}

// ── Base-color texture ───────────────────────────────────────────────────────

/**
 * Derive a subtle grayscale RGBA texture from the heightfield.
 *
 * Base plane is slightly darker so the stud reads as raised; stud top is
 * near-white so `diffuseColor` comes through at full intensity.
 */
function generateBaseColorFromHeightField(heights: Float32Array, size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);

    const BASE_BRIGHTNESS = 0.82;
    const STUD_BRIGHTNESS = 1.0;

    for (let i = 0; i < size * size; i++) {
        const h = heights[i]!;
        const brightness = lerp(BASE_BRIGHTNESS, STUD_BRIGHTNESS, h);
        const v = Math.round(brightness * 255);
        const idx = i * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
    }
    return data;
}

// ── Normal-map texture ───────────────────────────────────────────────────────

/**
 * Derive a tangent-space normal map from the heightfield using central
 * finite differences. Uses wrapping reads so the tile remains seamless.
 *
 * Normals are oriented for an outset (raised) appearance — edges of studs
 * deflect the surface normal outward, creating highlights on the light-facing
 * side and shadows on the opposite side.
 */
function generateNormalMapFromHeightField(heights: Float32Array, size: number): Uint8Array {
    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hL = heights[y * size + ((x - 1 + size) % size)]!;
            const hR = heights[y * size + ((x + 1) % size)]!;
            const hU = heights[((y - 1 + size) % size) * size + x]!;
            const hD = heights[((y + 1) % size) * size + x]!;

            const dhdx = (hR - hL) * NORMAL_STRENGTH;
            const dhdy = (hD - hU) * NORMAL_STRENGTH;

            // Outset (raised) studs, standard convention: n = normalize(-dh/dx, -dh/dy, 1)
            // in image space (+y = down = +v). Consumers map green to their +V axis
            // directly (see stud-material-plugin.ts).
            const len = Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
            const nx = -dhdx / len;
            const ny = -dhdy / len;
            const nz = 1 / len;

            const idx = (y * size + x) * 4;
            data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
            data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            data[idx + 3] = 255;
        }
    }
    return data;
}

// ── Math helpers ─────────────────────────────────────────────────────────────

/** 2-D signed distance to a rounded box centered at the origin.
 *  Returns negative inside, positive outside, zero on the boundary. */
function sdRoundedBox(px: number, py: number, halfSize: number, cornerRadius: number): number {
    const qx = Math.abs(px) - halfSize + cornerRadius;
    const qy = Math.abs(py) - halfSize + cornerRadius;
    const outer = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2);
    const inner = Math.min(Math.max(qx, qy), 0);
    return outer + inner - cornerRadius;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}
