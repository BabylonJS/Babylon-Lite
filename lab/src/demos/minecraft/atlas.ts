// Builds a single texture atlas from individual block-face PNGs (Kenney Voxel
// Pack, CC0) decoded in the browser. Culled meshing means every face maps to
// exactly one tile with UVs inside its cell, so a half-texel inset is enough to
// prevent bleeding with nearest sampling (no greedy tiling across cells).

import { createTexture2DFromPixels, type EngineContext, type Texture2D } from "babylon-lite";

/** Per-tile UV cell, already inset by half a texel. */
export interface TileRect {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

export interface BlockAtlas {
    texture: Texture2D;
    rects: Map<string, TileRect>;
    /** Fallback rect for unknown tiles (magenta would be ideal; we use first tile). */
    fallback: TileRect;
}

const TILE_PX = 64; // per-tile resolution in the atlas

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        return await createImageBitmap(await res.blob());
    } catch {
        return null;
    }
}

/**
 * Build an atlas for the given tile names from `${baseUrl}/<name>.png`.
 * Tiles that fail to load are filled with a visible magenta placeholder.
 */
export async function buildBlockAtlas(engine: EngineContext, baseUrl: string, tileNames: string[]): Promise<BlockAtlas> {
    const names = [...new Set(tileNames)];
    const cols = Math.ceil(Math.sqrt(names.length));
    const rows = Math.ceil(names.length / cols);
    const atlasW = cols * TILE_PX;
    const atlasH = rows * TILE_PX;

    // Compose every tile into one canvas, then read the whole atlas back once.
    // A single getImageData avoids the per-tile readback warning entirely (no need
    // for the willReadFrequently hint, which some tooling mishandles).
    const canvas = document.createElement("canvas");
    canvas.width = atlasW;
    canvas.height = atlasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("atlas: 2D canvas context unavailable");

    const rects = new Map<string, TileRect>();
    const halfU = 0.5 / atlasW;
    const halfV = 0.5 / atlasH;

    for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ox = col * TILE_PX;
        const oy = row * TILE_PX;

        const bmp = await loadBitmap(`${baseUrl}/${name}.png`);
        if (bmp) {
            ctx.drawImage(bmp, ox, oy, TILE_PX, TILE_PX);
            bmp.close();
        } else {
            // Magenta placeholder so missing textures are obvious, not invisible.
            ctx.fillStyle = "#ff00ff";
            ctx.fillRect(ox, oy, TILE_PX, TILE_PX);
        }

        rects.set(name, {
            u0: ox / atlasW + halfU,
            v0: oy / atlasH + halfV,
            u1: (ox + TILE_PX) / atlasW - halfU,
            v1: (oy + TILE_PX) / atlasH - halfV,
        });
    }

    const imageData = ctx.getImageData(0, 0, atlasW, atlasH);
    const pixels = new Uint8Array(imageData.data.buffer.slice(0));

    const texture = createTexture2DFromPixels(engine, pixels, atlasW, atlasH, {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        srgb: true,
    });

    const fallback = rects.values().next().value ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    return { texture, rects, fallback };
}
