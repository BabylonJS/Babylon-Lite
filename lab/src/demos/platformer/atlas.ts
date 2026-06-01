/**
 * Loads a Kenney "Platformer Pack Remastered" spritesheet (`.png`) plus its
 * TexturePacker `.xml` descriptor into a single Lite `SpriteAtlas`, and exposes a
 * `name → frame index` lookup.
 *
 * Lite's built-in `loadSpriteAtlas` only understands the uniform-grid path
 * (`gridSize`); a TexturePacker `metadataUrl` throws. These sheets are *packed*
 * (tightly nested sub-rectangles, no grid), so we parse the XML ourselves and
 * build `SpriteFrame`s directly — the same approach the freeciv demo uses for its
 * `.spec` sheets.
 *
 * The XML is the generic TexturePacker form:
 *   <TextureAtlas imagePath="sheet.png">
 *     <SubTexture name="alienBeige_walk1.png" x="0" y="0" width="128" height="256"/>
 *     ...
 *   </TextureAtlas>
 */

import { loadTexture2D, type EngineContext, type SpriteAtlas, type SpriteFrame, type Texture2D } from "babylon-lite";

/** A loaded spritesheet: its atlas, source texture, and a name → frame-index map. */
export interface PlatformerSheet {
    texture: Texture2D;
    atlas: SpriteAtlas;
    /** Frame index for a sub-texture name (with or without the trailing ".png"). */
    frameOf: (name: string) => number;
    /** Like `frameOf` but returns `undefined` instead of throwing when absent. */
    tryFrameOf: (name: string) => number | undefined;
    /** Source pixel size of a named sub-texture, for sprite sizing. */
    sizeOf: (name: string) => readonly [number, number];
    /** All sub-texture names in the sheet (without the ".png" suffix). */
    names: readonly string[];
}

interface SubTexture {
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

/** Strip a trailing ".png" so callers can use either "coinGold" or "coinGold.png". */
function normalizeName(name: string): string {
    return name.endsWith(".png") ? name.slice(0, -4) : name;
}

/** Parse the `<SubTexture .../>` rows out of a TexturePacker XML descriptor. */
function parseSubTextures(xml: string): SubTexture[] {
    const subs: SubTexture[] = [];
    const tagRe = /<SubTexture\b([^>]*)\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(xml)) !== null) {
        const attrs: Record<string, string> = {};
        ATTR_RE.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = ATTR_RE.exec(m[1]!)) !== null) {
            attrs[a[1]!] = a[2]!;
        }
        if (attrs.name === undefined) continue;
        subs.push({
            name: normalizeName(attrs.name),
            x: Number(attrs.x ?? 0),
            y: Number(attrs.y ?? 0),
            width: Number(attrs.width ?? 0),
            height: Number(attrs.height ?? 0),
        });
    }
    return subs;
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`loadPlatformerSheet: failed to fetch ${url} (HTTP ${res.status})`);
    return res.text();
}

/** Options for {@link loadPlatformerSheet}. */
export interface LoadSheetOptions {
    /**
     * Texture filtering. Defaults to `"linear"` (smooth for isolated sprites).
     * Tile sheets that tessellate edge-to-edge should use `"nearest"`: linear
     * filtering on this straight-alpha art bleeds a dark fringe at frame edges,
     * which shows up as thin black seams between adjacent tiles.
     */
    filter?: "linear" | "nearest";
}

/**
 * Load one Kenney spritesheet by its base URL (without extension), e.g.
 * `loadPlatformerSheet(engine, "/platformer/players")` reads `players.png` +
 * `players.xml`.
 */
export async function loadPlatformerSheet(engine: EngineContext, baseUrl: string, options: LoadSheetOptions = {}): Promise<PlatformerSheet> {
    const filter = options.filter ?? "linear";
    const [xml, texture] = await Promise.all([
        fetchText(`${baseUrl}.xml`),
        loadTexture2D(engine, `${baseUrl}.png`, {
            invertY: false,
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            mipMaps: false,
            minFilter: filter,
            magFilter: filter,
        }),
    ]);

    const subs = parseSubTextures(xml);
    if (subs.length === 0) throw new Error(`loadPlatformerSheet: no <SubTexture> entries in ${baseUrl}.xml`);

    const tw = texture.width;
    const th = texture.height;
    const frames: SpriteFrame[] = [];
    const index = new Map<string, number>();
    const sizes = new Map<string, readonly [number, number]>();

    for (const s of subs) {
        index.set(s.name, frames.length);
        sizes.set(s.name, [s.width, s.height]);
        // Inset the UV rect by half a texel. These sheets are tightly packed, so
        // at a frame's edge the bilinear (linear-filter) kernel would otherwise
        // sample the neighbouring sprite and bleed a thin dark seam (e.g. the line
        // beside the flag). The inset keeps sampling inside the frame's own pixels.
        const ix = 0.5 / tw;
        const iy = 0.5 / th;
        frames.push({
            uvMin: [s.x / tw + ix, s.y / th + iy],
            uvMax: [(s.x + s.width) / tw - ix, (s.y + s.height) / th - iy],
            sourceSizePx: [s.width, s.height],
            pivot: [0.5, 0.5],
        });
    }

    const atlas: SpriteAtlas = {
        texture,
        textureSizePx: [tw, th],
        frames,
        premultipliedAlpha: false,
    };

    const tryFrameOf = (name: string): number | undefined => index.get(normalizeName(name));
    const frameOf = (name: string): number => {
        const i = tryFrameOf(name);
        if (i === undefined) throw new Error(`loadPlatformerSheet: frame "${name}" not found in ${baseUrl}.xml`);
        return i;
    };
    const sizeOf = (name: string): readonly [number, number] => {
        const s = sizes.get(normalizeName(name));
        if (!s) throw new Error(`loadPlatformerSheet: size for "${name}" not found in ${baseUrl}.xml`);
        return s;
    };

    return {
        texture,
        atlas,
        frameOf,
        tryFrameOf,
        sizeOf,
        names: subs.map((s) => s.name),
    };
}
