/**
 * Isometric grid geometry shared by the world generator (river/road
 * connectivity) and the renderer (directional + corner sprite selection).
 *
 * The map is laid out so a tile `(x, y)` sits at screen pixel
 *   `((x - y) * TILE_W/2, (x + y) * TILE_H/2)`.
 * That makes the eight Freeciv map directions correspond to these tile
 * deltas (and the four cardinals N/E/S/W appear as the diamond's vertices,
 * i.e. straight up / right / down / left on screen):
 */

export const TILE_W = 96;
export const TILE_H = 48;

export type Dir8 = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Map direction → tile delta. */
export const DIR_DELTA: Readonly<Record<Dir8, readonly [number, number]>> = {
    n: [-1, -1],
    ne: [0, -1],
    e: [1, -1],
    se: [1, 0],
    s: [1, 1],
    sw: [0, 1],
    w: [-1, 1],
    nw: [-1, 0],
};

/** The eight directions in clockwise order starting at north. */
export const DIR8: readonly Dir8[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/**
 * The four edge-adjacent neighbours (tiles that share a diamond *edge*). In our
 * `(x, y)` grid these are the orthogonal 4-neighbourhood, and on screen they sit
 * at the diamond's edge midpoints (upper-right, lower-right, lower-left,
 * upper-left). Freeciv's isometric topology treats *these* as the "cardinal"
 * directions for rivers and coastlines.
 */
export const EDGES: readonly Dir8[] = ["ne", "se", "sw", "nw"];

/**
 * Freeciv names its directional road/river sprites in *map*-direction terms,
 * which sit one 45° step off from our *screen*-direction labels. This maps a
 * screen-direction neighbour to the Freeciv sprite suffix whose channel visually
 * points at it — e.g. a neighbour straight up-screen (our `"n"`, the top vertex)
 * is drawn by Freeciv's `"nw"` sprite, and an edge neighbour up-and-right (our
 * `"ne"`) is drawn by Freeciv's `"n"` sprite (its cardinal river bit).
 */
export const SPRITE_DIR: Readonly<Record<Dir8, Dir8>> = {
    n: "nw",
    ne: "n",
    e: "ne",
    se: "e",
    s: "se",
    sw: "s",
    w: "sw",
    nw: "w",
};

/** Screen-space centre of tile `(x, y)` in unscaled world pixels. */
export function isoCentre(x: number, y: number): [number, number] {
    return [(x - y) * (TILE_W / 2), (x + y) * (TILE_H / 2)];
}

/**
 * Inverse of {@link isoCentre}: world pixel → the tile whose diamond contains it.
 *
 * Solving the isoCentre system for `(x, y)`:
 *   `wx = (x - y) * TILE_W/2`  ⇒  `x - y = 2·wx / TILE_W`
 *   `wy = (x + y) * TILE_H/2`  ⇒  `x + y = 2·wy / TILE_H`
 * gives `x = ((x−y)+(x+y))/2`, `y = ((x+y)−(x−y))/2`. Rounding the fractional
 * result snaps to the nearest tile centre, which — because the diamonds tessellate
 * as the Voronoi cells of those centres — is exactly the diamond under the point.
 */
export function worldToTile(wx: number, wy: number): [number, number] {
    const xMinusY = (2 * wx) / TILE_W;
    const xPlusY = (2 * wy) / TILE_H;
    return [Math.round((xPlusY + xMinusY) / 2), Math.round((xPlusY - xMinusY) / 2)];
}
