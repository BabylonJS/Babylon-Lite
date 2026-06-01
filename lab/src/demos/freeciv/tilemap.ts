/**
 * Builds the isometric sprite tilemap for the Freeciv demo: ocean, coast
 * blending, land terrain, rivers, roads, cities and units. Pure layout —
 * it only reads the generated {@link GameMap} and emits sprite indices into
 * the supplied layers.
 *
 * Layer ordering (back → front): ocean base → coast cells → land terrain →
 * rivers → roads → cities → units.
 *
 * Coast uses Freeciv's CELL_CORNER scheme: each shallow ocean tile is drawn as
 * four half-diamond corner cells, each chosen by the three land/water tiles
 * that meet at that corner. Rivers use the River style (one sprite per river
 * tile keyed on its cardinal river/ocean neighbours, plus ocean outlets), and
 * roads use RoadAllSeparate (one additive sprite per connected direction).
 */

import { addSprite2DIndex, type Sprite2DLayer } from "babylon-lite";
import type { FreecivSheet } from "./atlas.js";
import { DIR8, DIR_DELTA, EDGES, SPRITE_DIR, TILE_H, TILE_W, isoCentre, type Dir8 } from "./iso.js";
import { Improvement, IMPROVEMENT_TAG, Special, SPECIAL_TAG, Terrain, TERRAIN_TAG, type City, type GameMap } from "./worldgen.js";

const UNIT_TAGS = ["u.warriors", "u.legion", "u.horsemen", "u.knights", "u.musketeers", "u.catapult"] as const;

/** City graphics come in five size tiers (`_0`…`_4`) plus matching walls. */
const CITY_STYLE = "european";

/** Pixel height of a mountains sprite (taller than the 48px base diamond). */
const MOUNTAIN_H = 66;

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface TileLayers {
    ocean: Sprite2DLayer;
    coast: Sprite2DLayer;
    terrain: Sprite2DLayer;
    /** Raised forest + jungle silhouettes (terrain2 sheet). */
    forest: Sprite2DLayer;
    /** Raised hills silhouettes (hills sheet). */
    hills: Sprite2DLayer;
    /** Raised mountains silhouettes (mountains sheet, tall). */
    mountains: Sprite2DLayer;
    river: Sprite2DLayer;
    road: Sprite2DLayer;
    /** Irrigation / farmland / mine overlays (terrain1 sheet). */
    improvement: Sprite2DLayer;
    /** Bonus-resource icons (terrain1 sheet). */
    special: Sprite2DLayer;
    city: Sprite2DLayer;
    unit: Sprite2DLayer;
    /** Roaming wildlife (animals sheet). */
    animals: Sprite2DLayer;
    /** Pulsing selection ring on the active unit (select sheet). */
    selection: Sprite2DLayer;
    /** Fog-of-war darkness diamonds (terrain1 mask), drawn on top of the map. */
    fog: Sprite2DLayer;
}

export interface TileSheets {
    terrain: FreecivSheet;
    /** terrain2 sheet — forest & jungle overlays. */
    terrain2: FreecivSheet;
    hills: FreecivSheet;
    mountains: FreecivSheet;
    ocean: FreecivSheet;
    water: FreecivSheet;
    cities: FreecivSheet;
    units: FreecivSheet;
    /** Roaming wildlife sprites. */
    animals: FreecivSheet;
    /** Pulsing unit-selection ring (4 frames). */
    select: FreecivSheet;
}

/** The four corner cells of an ocean tile, with their in-tile offset and the
 * three neighbouring tiles (by direction) that meet at that corner. */
const CORNERS: readonly { pos: string; offset: readonly [number, number]; tiles: readonly [Dir8, Dir8, Dir8] }[] = [
    { pos: "u", offset: [0, -TILE_H / 4], tiles: ["nw", "n", "ne"] },
    { pos: "r", offset: [TILE_W / 4, 0], tiles: ["ne", "e", "se"] },
    { pos: "d", offset: [0, TILE_H / 4], tiles: ["se", "s", "sw"] },
    { pos: "l", offset: [-TILE_W / 4, 0], tiles: ["sw", "w", "nw"] },
];

/** Build the whole tilemap and return the land-tile bounds (for fit-to-view). */
export function buildTilemap(world: GameMap, sheets: TileSheets, layers: TileLayers): Bounds {
    const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

    buildOcean(world, sheets, layers);
    buildCoast(world, sheets, layers);
    buildTerrain(world, sheets, layers, bounds);
    buildRaisedTerrain(world, sheets, layers);
    buildRivers(world, sheets, layers);
    buildRoads(world, sheets, layers);
    buildImprovements(world, sheets, layers);
    buildSpecials(world, sheets, layers);
    buildFeatures(world, sheets, layers);

    return bounds;
}

/** Draw every ocean tile as a deep/shallow water diamond (shallow near land). */
function buildOcean(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.ocean.grid("grid_main");
    const deep = grid.frameOf("t.l0.cellgroup_d_d_d_d");
    const shallow = grid.frameOf("t.l0.cellgroup_s_s_s_s");

    forEachIso(world, (x, y) => {
        if (!world.isOcean(x, y)) return;
        const frame = isShallow(world, x, y) ? shallow : deep;
        if (frame === undefined) return;
        const [px, py] = isoCentre(x, y);
        addSprite2DIndex(layers.ocean, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
    });
}

/** Overlay coast corner cells on shallow tiles where they border land. */
function buildCoast(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.water.grid("grid_coasts");

    forEachIso(world, (x, y) => {
        if (!world.isOcean(x, y) || !isShallow(world, x, y)) return;
        const [px, py] = isoCentre(x, y);
        for (const corner of CORNERS) {
            const flags = corner.tiles
                .map((dir) => {
                    const [dx, dy] = DIR_DELTA[dir];
                    return world.isLand(x + dx, y + dy) ? "i" : "w";
                })
                .join("_");
            if (flags === "w_w_w") continue; // open water, nothing to draw
            const frame = grid.frameOf(`t.l1.coast_cell_${corner.pos}_${flags}`);
            if (frame === undefined) continue;
            addSprite2DIndex(layers.coast, {
                positionPx: [px + corner.offset[0], py + corner.offset[1]],
                sizePx: [TILE_W / 2, TILE_H / 2],
                frame,
            });
        }
    });
}

/** Paint every land tile as a terrain diamond (back-to-front); fills bounds. */
function buildTerrain(world: GameMap, sheets: TileSheets, layers: TileLayers, bounds: Bounds): void {
    const grid = sheets.terrain.grid("grid_main");
    const frameFor = new Map<Terrain, number>();
    for (let t = Terrain.Grassland; t <= Terrain.Arctic; t++) {
        const tag = TERRAIN_TAG[t as Terrain];
        const f = tag ? grid.frameOf(tag) : undefined;
        if (f !== undefined) frameFor.set(t as Terrain, f);
    }

    forEachIso(world, (x, y) => {
        const frame = frameFor.get(world.at(x, y));
        if (frame === undefined) return;
        const [px, py] = isoCentre(x, y);
        addSprite2DIndex(layers.terrain, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        if (px < bounds.minX) bounds.minX = px;
        if (px > bounds.maxX) bounds.maxX = px;
        if (py < bounds.minY) bounds.minY = py;
        if (py > bounds.maxY) bounds.maxY = py;
    });
}

/**
 * Overlay raised forest/jungle/hills/mountains silhouettes above the base
 * diamond for a 2.5D look. Each sprite is matched to its like-terrain edge
 * neighbours (Freeciv's CELL_WHOLE "match" scheme): forest & jungle share the
 * "forest" group; hills & mountains share the "hills" group. The four n/e/s/w
 * bits are Freeciv map-cardinals = our diamond edges (via SPRITE_DIR).
 */
function buildRaisedTerrain(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const forestGrid = sheets.terrain2.grid("grid_main");
    const hillsGrid = sheets.hills.grid("grid_main");
    const mountainsGrid = sheets.mountains.grid("grid_main");

    const isForestGroup = (t: Terrain): boolean => t === Terrain.Forest || t === Terrain.Jungle;
    const isHillsGroup = (t: Terrain): boolean => t === Terrain.Hills || t === Terrain.Mountains;

    // Freeciv map-cardinal match bits over our edge neighbours.
    const matchBits = (x: number, y: number, inGroup: (t: Terrain) => boolean): string => {
        const on = new Set<Dir8>();
        for (const edge of EDGES) {
            const [dx, dy] = DIR_DELTA[edge];
            if (inGroup(world.at(x + dx, y + dy))) on.add(SPRITE_DIR[edge]);
        }
        const b = (d: Dir8): string => (on.has(d) ? "1" : "0");
        return `n${b("n")}e${b("e")}s${b("s")}w${b("w")}`;
    };

    forEachIso(world, (x, y) => {
        const t = world.at(x, y);
        const [px, py] = isoCentre(x, y);
        if (t === Terrain.Forest || t === Terrain.Jungle) {
            const tag = `t.l1.${t === Terrain.Forest ? "forest" : "jungle"}_${matchBits(x, y, isForestGroup)}`;
            const frame = forestGrid.frameOf(tag);
            if (frame !== undefined) addSprite2DIndex(layers.forest, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        } else if (t === Terrain.Hills) {
            const frame = hillsGrid.frameOf(`t.l1.hills_${matchBits(x, y, isHillsGroup)}`);
            if (frame !== undefined) addSprite2DIndex(layers.hills, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        } else if (t === Terrain.Mountains) {
            const frame = mountainsGrid.frameOf(`t.l1.mountains_${matchBits(x, y, isHillsGroup)}`);
            // Tall sprite (96×66): bottom-align with the diamond and nudge down
            // by Freeciv's layer1_offset_y so peaks rise above the tile.
            if (frame !== undefined) addSprite2DIndex(layers.mountains, { positionPx: [px, py - (MOUNTAIN_H - TILE_H) / 2 + 6], sizePx: [TILE_W, MOUNTAIN_H], frame });
        }
    });
}

/** Draw irrigation / farmland / mine overlays on improved tiles. */
function buildImprovements(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.terrain.grid("grid_main");
    const frameFor = new Map<Improvement, number>();
    for (const imp of [Improvement.Irrigation, Improvement.Farmland, Improvement.Mine]) {
        const tag = IMPROVEMENT_TAG[imp];
        const f = tag ? grid.frameOf(tag) : undefined;
        if (f !== undefined) frameFor.set(imp, f);
    }

    forEachIso(world, (x, y) => {
        const frame = frameFor.get(world.improvementAt(x, y));
        if (frame === undefined) return;
        const [px, py] = isoCentre(x, y);
        addSprite2DIndex(layers.improvement, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
    });
}

/** Draw bonus-resource icons on tiles that carry a special. */
function buildSpecials(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.terrain.grid("grid_main");
    const frameFor = new Map<Special, number>();
    for (let s = Special.Wheat; s <= Special.Whales; s++) {
        const tag = SPECIAL_TAG[s as Special];
        const f = tag ? grid.frameOf(tag) : undefined;
        if (f !== undefined) frameFor.set(s as Special, f);
    }

    forEachIso(world, (x, y) => {
        const frame = frameFor.get(world.specialAt(x, y));
        if (frame === undefined) return;
        const [px, py] = isoCentre(x, y);
        addSprite2DIndex(layers.special, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
    });
}

/** Draw river segments on land tiles, plus outlets where rivers meet the sea. */
function buildRivers(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.water.grid("grid_main");

    forEachIso(world, (x, y) => {
        const [px, py] = isoCentre(x, y);
        if (world.hasRiver(x, y)) {
            // Rivers connect along diamond *edges* (our 4-neighbourhood). The
            // sprite's n/e/s/w bits are Freeciv map-cardinals, which map to our
            // edge neighbours via SPRITE_DIR (ne→n, se→e, sw→s, nw→w). A bit is
            // set when the edge neighbour is itself river or open sea.
            const on = new Set<Dir8>();
            for (const edge of EDGES) {
                const [dx, dy] = DIR_DELTA[edge];
                if (world.hasRiver(x + dx, y + dy) || world.isOcean(x + dx, y + dy)) on.add(SPRITE_DIR[edge]);
            }
            const bit = (d: Dir8): string => (on.has(d) ? "1" : "0");
            const frame = grid.frameOf(`road.river_s_n${bit("n")}e${bit("e")}s${bit("s")}w${bit("w")}`);
            if (frame !== undefined) addSprite2DIndex(layers.river, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        } else if (world.isOcean(x, y)) {
            // Ocean tile: draw an outlet toward any adjacent river mouth.
            for (const edge of EDGES) {
                const [dx, dy] = DIR_DELTA[edge];
                if (!world.hasRiver(x + dx, y + dy)) continue;
                const frame = grid.frameOf(`road.river_outlet_${SPRITE_DIR[edge]}`);
                if (frame !== undefined) addSprite2DIndex(layers.river, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
            }
        }
    });
}

/** Draw roads as additive directional sprites (RoadAllSeparate). */
function buildRoads(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const grid = sheets.terrain.grid("grid_main");

    forEachIso(world, (x, y) => {
        if (!world.hasRoad(x, y)) return;
        const [px, py] = isoCentre(x, y);
        let connected = false;
        for (const dir of DIR8) {
            const [dx, dy] = DIR_DELTA[dir];
            if (!world.hasRoad(x + dx, y + dy)) continue;
            connected = true;
            // road_<suffix> uses Freeciv map-direction names (SPRITE_DIR maps our
            // screen-direction neighbour to the sprite whose channel points at it).
            const frame = grid.frameOf(`road.road_${SPRITE_DIR[dir]}`);
            if (frame !== undefined) addSprite2DIndex(layers.road, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        }
        if (!connected) {
            const frame = grid.frameOf("road.road_isolated");
            if (frame !== undefined) addSprite2DIndex(layers.road, { positionPx: [px, py], sizePx: [TILE_W, TILE_H], frame });
        }
    });
}

/** Place cities (size-tiered, optionally walled) and a guard unit beside each. */
function buildFeatures(world: GameMap, sheets: TileSheets, layers: TileLayers): void {
    const cityGrid = sheets.cities.grid("grid_main");
    const unitGrid = sheets.units.grid("grid_main");

    interface Feature {
        x: number;
        y: number;
        layer: Sprite2DLayer;
        frame: number;
        size: [number, number];
    }
    const features: Feature[] = [];

    world.cities.forEach((c: City, i) => {
        const tier = Math.min(4, Math.floor((c.size - 1) / 3)); // 1-15 → 0-4
        // Larger cities (tier ≥ 2) gain a fortification ring, drawn behind the
        // city building (pushed first → stable-sorted before it at this tile).
        if (tier >= 2) {
            const wf = cityGrid.frameOf(`city.${CITY_STYLE}_wall_${tier}`);
            if (wf !== undefined) features.push({ x: c.x, y: c.y, layer: layers.city, frame: wf, size: [96, 72] });
        }
        const cf = cityGrid.frameOf(`city.${CITY_STYLE}_city_${tier}`);
        if (cf !== undefined) features.push({ x: c.x, y: c.y, layer: layers.city, frame: cf, size: [96, 72] });
        // Guard unit on an adjacent land tile.
        for (const dir of ["e", "se", "s"] as const) {
            const [dx, dy] = DIR_DELTA[dir];
            const ux = c.x + dx;
            const uy = c.y + dy;
            if (!world.isLand(ux, uy)) continue;
            const uf = unitGrid.frameOf(UNIT_TAGS[i % UNIT_TAGS.length]!);
            if (uf !== undefined) features.push({ x: ux, y: uy, layer: layers.unit, frame: uf, size: [64, 48] });
            break;
        }
    });

    // Stable sort by iso depth; wall/city pushed in order stay correctly layered.
    features.sort((a, b) => a.x + a.y - (b.x + b.y));
    for (const f of features) {
        const [cx, cy] = isoCentre(f.x, f.y);
        addSprite2DIndex(f.layer, { positionPx: [cx, cy + TILE_H * 0.5], sizePx: f.size, frame: f.frame });
    }
}

/** Is this ocean tile shallow (adjacent to any land)? */
function isShallow(world: GameMap, x: number, y: number): boolean {
    return DIR8.some((d) => world.isLand(x + DIR_DELTA[d][0], y + DIR_DELTA[d][1]));
}

/** Iterate tiles in back-to-front isometric order (`x + y` ascending). */
function forEachIso(world: GameMap, fn: (x: number, y: number) => void): void {
    for (let sum = 0; sum <= world.width + world.height - 2; sum++) {
        for (let x = 0; x < world.width; x++) {
            const y = sum - x;
            if (y < 0 || y >= world.height) continue;
            fn(x, y);
        }
    }
}
