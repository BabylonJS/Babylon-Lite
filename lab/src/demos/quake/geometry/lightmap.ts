// Builds a single grayscale lightmap atlas from the Quake BSP LIGHTING lump.
//
// Each lit face owns a small rectangle of luxels (one sample per 16 world units
// of surface extent, plus 1). We pack those rectangles into one atlas texture
// with a simple shelf allocator and hand back per-face atlas coordinates so the
// geometry builder can emit a second UV set. Texel (0,0) is reserved as a white
// "fullbright" luxel used by special surfaces (sky/liquids) and any face that
// has no lightmap or that overflows the atlas.

const ATLAS_W = 2048;
const ATLAS_H = 2048;
const PAD = 1;

// Brightness for non-special faces that ship with no lightmap data (lightOfs < 0).
// Quake clears such surfaces to "no light"; we render them fully dark (black)
// rather than fullbright so they don't glare at map borders.
const UNLIT_AMBIENT = 0;

export interface FaceLightmap {
    atlasX: number;
    atlasY: number;
    lmW: number;
    lmH: number;
}

export class LightmapAtlas {
    readonly width = ATLAS_W;
    readonly height = ATLAS_H;
    /** RGBA8 atlas pixels. */
    readonly pixels = new Uint8Array(ATLAS_W * ATLAS_H * 4);

    // Shelf allocator cursor.
    private shelfX = 0;
    private shelfY = 0;
    private shelfH = 0;

    constructor() {
        // Reserve a white luxel at (0,0) for fullbright surfaces.
        this.pixels[0] = 255;
        this.pixels[1] = 255;
        this.pixels[2] = 255;
        this.pixels[3] = 255;
        // Reserve a dim luxel at (1,0) for non-special faces that lack a lightmap.
        this.pixels[4] = UNLIT_AMBIENT;
        this.pixels[5] = UNLIT_AMBIENT;
        this.pixels[6] = UNLIT_AMBIENT;
        this.pixels[7] = 255;
        this.shelfX = 2; // leave the first column for the white texel
        this.shelfH = 2;
    }

    /** Atlas UV (0..1) of the reserved white/fullbright luxel center. */
    get whiteUV(): [number, number] {
        return [0.5 / ATLAS_W, 0.5 / ATLAS_H];
    }

    /** Atlas UV (0..1) of the reserved dim "unlit" luxel center. */
    get darkUV(): [number, number] {
        return [1.5 / ATLAS_W, 0.5 / ATLAS_H];
    }

    /**
     * Allocate an lmW×lmH block and copy the face's grayscale luxels (taken from
     * `lighting` at byte offset `lightOfs`) into the atlas. Returns null if the
     * atlas is full.
     */
    alloc(lighting: Uint8Array, lightOfs: number, lmW: number, lmH: number): FaceLightmap | null {
        if (lmW <= 0 || lmH <= 0) return null;
        if (this.shelfX + lmW + PAD > ATLAS_W) {
            // New shelf.
            this.shelfX = 0;
            this.shelfY += this.shelfH + PAD;
            this.shelfH = 0;
        }
        if (this.shelfY + lmH > ATLAS_H) return null; // atlas full
        const x = this.shelfX;
        const y = this.shelfY;
        this.shelfX += lmW + PAD;
        if (lmH > this.shelfH) this.shelfH = lmH;

        // Copy luxels. Out-of-range samples (truncated lump) become mid-gray.
        for (let ty = 0; ty < lmH; ty++) {
            for (let tx = 0; tx < lmW; tx++) {
                const src = lightOfs + ty * lmW + tx;
                const v = lightOfs >= 0 && src < lighting.length ? lighting[src]! : 128;
                const di = ((y + ty) * ATLAS_W + (x + tx)) * 4;
                this.pixels[di] = v;
                this.pixels[di + 1] = v;
                this.pixels[di + 2] = v;
                this.pixels[di + 3] = 255;
            }
        }
        return { atlasX: x, atlasY: y, lmW, lmH };
    }
}
