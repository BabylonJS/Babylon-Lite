/**
 * Loads a Freeciv sprite sheet (`.png`) + its `.spec` description into one or
 * more Lite `SpriteAtlas`es (one per grid section) sharing a single GPU texture,
 * and exposes a tag → atlas-frame-index lookup per grid.
 *
 * Freeciv's grid is a uniform grid with `margin = x_top_left/y_top_left` and
 * `spacing = pixel_border`, so `createGridSpriteAtlas` slices it directly.
 * `createGridSpriteAtlas` emits frames row-major (top-left first), so the
 * frame index of cell `(row, col)` is `row * columns + col`, where `columns`
 * is computed with the same formula the atlas builder uses.
 */

import { loadTexture2D, type EngineContext, type SpriteAtlas, type SpriteFrame, type Texture2D } from "babylon-lite";
import { parseSpec, type SpecGrid } from "./spec-parser.js";

/** One grid of a sheet: its atlas plus a tag → frame lookup. */
export interface FreecivGrid {
    section: string;
    atlas: SpriteAtlas;
    columns: number;
    /** Frame index for a named tag, or `undefined` if the tag is absent in this grid. */
    frameOf: (tag: string) => number | undefined;
}

export interface FreecivSheet {
    texture: Texture2D;
    grids: Map<string, FreecivGrid>;
    /** Convenience accessor; throws if the named grid is absent. */
    grid: (section: string) => FreecivGrid;
}

/**
 * Load one Freeciv sheet. `specUrl` points at the `.spec`; the matching PNG is
 * resolved from the spec's `gfx` field relative to `baseUrl`.
 */
export async function loadFreecivSheet(engine: EngineContext, baseUrl: string, specUrl: string): Promise<FreecivSheet> {
    const specText = await fetchText(specUrl);
    const spec = parseSpec(specText);

    const pngUrl = `${baseUrl}/${spec.gfx}.png`;
    const texture = await loadTexture2D(engine, pngUrl, {
        invertY: false,
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        mipMaps: false,
        // Pixel-art tileset: nearest keeps edges crisp and avoids bleeding
        // across the 1px cell border into neighbouring diamonds.
        minFilter: "nearest",
        magFilter: "nearest",
    });

    const grids = new Map<string, FreecivGrid>();
    for (const g of spec.grids) {
        grids.set(g.section, buildGrid(texture, g));
    }

    return {
        texture,
        grids,
        grid: (section) => {
            const g = grids.get(section);
            if (!g) throw new Error(`loadFreecivSheet: grid "${section}" not found in ${specUrl}`);
            return g;
        },
    };
}

function buildGrid(texture: Texture2D, g: SpecGrid): FreecivGrid {
    // Freeciv grids have *independent* top-left origins per axis (e.g. the coast
    // grid sits at x=1, y=437 within the shared sheet), with no bottom/right
    // margin, so we build the frame table directly rather than via
    // createGridSpriteAtlas (which assumes a single symmetric margin).
    const stepX = g.dx + g.pixelBorder;
    const stepY = g.dy + g.pixelBorder;
    const columns = Math.max(1, Math.floor((texture.width - g.xTopLeft + g.pixelBorder) / stepX));
    const rows = Math.max(1, Math.floor((texture.height - g.yTopLeft + g.pixelBorder) / stepY));

    const tw = texture.width;
    const th = texture.height;
    const frames: SpriteFrame[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            const x = g.xTopLeft + c * stepX;
            const y = g.yTopLeft + r * stepY;
            frames.push({
                uvMin: [x / tw, y / th],
                uvMax: [(x + g.dx) / tw, (y + g.dy) / th],
                sourceSizePx: [g.dx, g.dy],
                pivot: [0.5, 0.5],
            });
        }
    }

    const atlas: SpriteAtlas = {
        texture,
        textureSizePx: [tw, th],
        frames,
        premultipliedAlpha: false,
    };

    return {
        section: g.section,
        atlas,
        columns,
        frameOf: (tag) => {
            const cell = g.tags.get(tag);
            return cell ? cell.row * columns + cell.col : undefined;
        },
    };
}

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status}. Run \`pnpm fetch:freeciv\`.`);
    }
    return res.text();
}
