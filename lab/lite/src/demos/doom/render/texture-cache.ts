// On-demand texture cache: decodes WAD wall textures and flats into GPU textures
// in the indexed (R = palette index, A = coverage) format the DOOM material reads.

import { createTexture2DFromPixels, type EngineContext, type Texture2D } from "babylon-lite";
import type { Wad } from "../wad/wad-file.js";
import { tryGetLump } from "../wad/wad-file.js";
import { buildCompositeTexture, decodeFlat, indexedToIndexRgba, parsePnames, parseTextureLump, type TextureDef } from "../wad/graphics.js";

export interface CachedTexture {
    texture: Texture2D;
    width: number;
    height: number;
}

export const SKY_FLAT = "F_SKY1";

export class DoomTextureCache {
    private readonly defs = new Map<string, TextureDef>();
    private readonly pnames: string[];
    private readonly walls = new Map<string, CachedTexture | null>();
    private readonly flats = new Map<string, CachedTexture | null>();

    constructor(
        private readonly engine: EngineContext,
        private readonly wad: Wad
    ) {
        this.pnames = parsePnames(wad);
        for (const def of parseTextureLump(wad, "TEXTURE1")) this.defs.set(def.name, def);
        for (const def of parseTextureLump(wad, "TEXTURE2")) this.defs.set(def.name, def);
    }

    /** Resolves a composite wall texture by name. Returns null for "-"/missing. */
    getWall(name: string): CachedTexture | null {
        if (name === "-" || name === "") return null;
        const cached = this.walls.get(name);
        if (cached !== undefined) return cached;
        const def = this.defs.get(name);
        let result: CachedTexture | null = null;
        if (def) {
            const img = buildCompositeTexture(this.wad, def, this.pnames);
            const texture = createTexture2DFromPixels(this.engine, indexedToIndexRgba(img), img.width, img.height, {
                addressModeU: "repeat",
                addressModeV: "repeat",
            });
            result = { texture, width: img.width, height: img.height };
        }
        this.walls.set(name, result);
        return result;
    }

    /** Resolves a flat (floor/ceiling) by name. Returns null for sky/missing. */
    getFlat(name: string): CachedTexture | null {
        if (name === "-" || name === "" || name === SKY_FLAT) return null;
        const cached = this.flats.get(name);
        if (cached !== undefined) return cached;
        const lump = tryGetLump(this.wad, name);
        let result: CachedTexture | null = null;
        if (lump && lump.length >= 4096) {
            const img = decodeFlat(lump);
            const texture = createTexture2DFromPixels(this.engine, indexedToIndexRgba(img), img.width, img.height, {
                addressModeU: "repeat",
                addressModeV: "repeat",
            });
            result = { texture, width: img.width, height: img.height };
        }
        this.flats.set(name, result);
        return result;
    }
}
