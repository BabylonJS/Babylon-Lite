/**
 * Minimal parser for Freeciv `.spec` tileset description files.
 *
 * A `.spec` file is an INI-like document. We need:
 *
 *   1. The `[file] gfx = "amplio2/terrain1"` line — the sprite sheet this
 *      spec slices (without extension).
 *   2. One or more grid sections (`[grid_main]`, `[grid_coasts]`, …). Each
 *      carries `x_top_left`, `y_top_left`, `dx`, `dy`, `pixel_border` plus a
 *      `tiles = { "row", "column", "tag" … }` table naming every cell.
 *
 * Freeciv computes a cell's top-left pixel as
 *   `x = x_top_left + column * (dx + pixel_border)`
 *   `y = y_top_left + row    * (dy + pixel_border)`
 * which is a uniform grid with `margin = x_top_left/y_top_left` and
 * `spacing = pixel_border` — exactly what Lite's `createGridSpriteAtlas`
 * consumes.
 *
 * Some sheets (e.g. `water.spec`) carry *multiple* grids at different cell
 * sizes and origins (96×48 rivers in `[grid_main]`, 48×24 coast cells in
 * `[grid_coasts]`), so the parser is section-aware and returns one
 * `SpecGrid` per grid-bearing section.
 *
 * This is a clean-room reader of the publicly documented, plain-text spec
 * format — no Freeciv code is used.
 */

export interface SpecGrid {
    /** Section name, e.g. `"grid_main"` or `"grid_coasts"`. */
    section: string;
    xTopLeft: number;
    yTopLeft: number;
    dx: number;
    dy: number;
    pixelBorder: number;
    /** Map from sprite tag → its `(row, column)` cell in this grid. */
    tags: Map<string, { row: number; col: number }>;
}

export interface ParsedSpec {
    /** Sheet path as written in the spec, e.g. `"amplio2/terrain1"` (no extension). */
    gfx: string;
    grids: SpecGrid[];
}

/** Strip a trailing `; comment` and surrounding whitespace from a line. */
function stripComment(line: string): string {
    const semi = line.indexOf(";");
    return (semi >= 0 ? line.slice(0, semi) : line).trim();
}

/** Parse `key = value` returning the (unquoted) value, or null if not a match. */
function matchAssign(line: string, key: string): string | null {
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (!m) return null;
    return m[1]!.trim().replace(/^"(.*)"$/, "$1");
}

interface GridDraft {
    section: string;
    xTopLeft?: number;
    yTopLeft?: number;
    dx?: number;
    dy?: number;
    pixelBorder?: number;
    tags: Map<string, { row: number; col: number }>;
}

/**
 * Parse a Freeciv `.spec` file body into its `gfx` path and grid list.
 * Throws if no grid section carries `dx`/`dy`.
 */
export function parseSpec(text: string): ParsedSpec {
    const lines = text.split(/\r?\n/);
    let gfx = "";
    let section = "";
    let current: GridDraft | null = null;
    const drafts: GridDraft[] = [];

    let inTiles = false;
    for (const raw of lines) {
        const line = stripComment(raw);
        if (line.length === 0) continue;

        if (inTiles) {
            if (line === "}") {
                inTiles = false;
                continue;
            }
            // `0, 0, "t.l0.desert1"` — may carry several aliases:
            // `11, 4, "ts.grassland_resources", "ts.river"`.
            const m = line.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(.+)$/);
            if (!m || !current) continue;
            const row = Number(m[1]);
            const col = Number(m[2]);
            for (const q of m[3]!.matchAll(/"([^"]+)"/g)) {
                current.tags.set(q[1]!, { row, col });
            }
            continue;
        }

        const sectionMatch = line.match(/^\[(\w+)\]$/);
        if (sectionMatch) {
            section = sectionMatch[1]!;
            continue;
        }

        if (/^tiles\s*=\s*\{/.test(line)) {
            // A grid section's tile table. Ensure a draft exists for it.
            current = ensureDraft(drafts, section);
            inTiles = true;
            continue;
        }

        const gfxVal = matchAssign(line, "gfx");
        if (gfxVal !== null) {
            gfx = gfxVal;
            continue;
        }

        for (const key of ["x_top_left", "y_top_left", "dx", "dy", "pixel_border"] as const) {
            const v = matchAssign(line, key);
            if (v === null) continue;
            const draft = ensureDraft(drafts, section);
            const n = Number(v);
            if (key === "x_top_left") draft.xTopLeft = n;
            else if (key === "y_top_left") draft.yTopLeft = n;
            else if (key === "dx") draft.dx = n;
            else if (key === "dy") draft.dy = n;
            else draft.pixelBorder = n;
        }
    }

    const grids: SpecGrid[] = drafts
        .filter((d) => d.dx !== undefined && d.dy !== undefined)
        .map((d) => ({
            section: d.section,
            xTopLeft: d.xTopLeft ?? 0,
            yTopLeft: d.yTopLeft ?? 0,
            dx: d.dx as number,
            dy: d.dy as number,
            pixelBorder: d.pixelBorder ?? 0,
            tags: d.tags,
        }));

    if (grids.length === 0) {
        throw new Error("parseSpec: no grid section with dx/dy found");
    }

    return { gfx, grids };
}

function ensureDraft(drafts: GridDraft[], section: string): GridDraft {
    let d = drafts.find((x) => x.section === section);
    if (!d) {
        d = { section, tags: new Map() };
        drafts.push(d);
    }
    return d;
}
