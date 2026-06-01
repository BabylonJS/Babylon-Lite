/**
 * Procedural world generator for the Freeciv demo.
 *
 * Produces a deterministic Civilization-style continent: an island of varied
 * terrain surrounded by ocean, threaded with rivers and dotted with cities
 * connected by roads.
 *
 * Height comes from summed value-noise octaves multiplied by a radial falloff
 * (so the map edges sink into the sea); terrain type is then chosen from height
 * plus latitude (poles → tundra/arctic, equator → desert/jungle) and a
 * low-frequency moisture field (dry deserts vs. wet jungles). Rivers trace
 * downhill from high ground to the sea; cities settle hospitable land and are
 * linked by roads along greedy shortest paths.
 *
 * Everything is seeded, so the same map renders every run (good for a demo).
 */

import { DIR8, DIR_DELTA, EDGES, type Dir8 } from "./iso.js";

export const enum Terrain {
    Ocean,
    Grassland,
    Plains,
    Desert,
    Forest,
    Jungle,
    Swamp,
    Hills,
    Mountains,
    Tundra,
    Arctic,
}

/** Base-terrain sprite tag for each land terrain (column 0 of `terrain1`). */
export const TERRAIN_TAG: Readonly<Record<Terrain, string | null>> = {
    [Terrain.Ocean]: null,
    [Terrain.Grassland]: "t.l0.grassland1",
    [Terrain.Plains]: "t.l0.plains1",
    [Terrain.Desert]: "t.l0.desert1",
    [Terrain.Forest]: "t.l0.forest1",
    [Terrain.Jungle]: "t.l0.jungle1",
    [Terrain.Swamp]: "t.l0.swamp1",
    [Terrain.Hills]: "t.l0.hills1",
    [Terrain.Mountains]: "t.l0.mountains1",
    [Terrain.Tundra]: "t.l0.tundra1",
    [Terrain.Arctic]: "t.l0.arctic1",
};

export interface City {
    x: number;
    y: number;
    /** Fake population (1‒15), used to pick the city-size sprite tier + label. */
    size: number;
    /** Display name floated above the city. */
    name: string;
}

/** Pool of city names handed out in placement order. */
const CITY_NAMES = [
    "Rome",
    "Athens",
    "Carthage",
    "Madrid",
    "Memphis",
    "Thebes",
    "Sparta",
    "Nineveh",
    "Tyre",
    "Ur",
    "Uruk",
    "Argos",
] as const;

/** A bonus resource sitting on a tile (the little "resource-dot" icons). */
export const enum Special {
    None,
    Wheat,
    Gold,
    Oasis,
    Furs,
    Gems,
    Wine,
    Coal,
    Fish,
    Whales,
}

/** `ts.*` sprite tag for each special, or `null` for {@link Special.None}. */
export const SPECIAL_TAG: Readonly<Record<Special, string | null>> = {
    [Special.None]: null,
    [Special.Wheat]: "ts.wheat",
    [Special.Gold]: "ts.gold",
    [Special.Oasis]: "ts.oasis",
    [Special.Furs]: "ts.furs",
    [Special.Gems]: "ts.gems",
    [Special.Wine]: "ts.wine",
    [Special.Coal]: "ts.coal",
    [Special.Fish]: "ts.fish",
    [Special.Whales]: "ts.whales",
};

/** A terrain improvement built on a tile. */
export const enum Improvement {
    None,
    Irrigation,
    Farmland,
    Mine,
}

/** `tx.*` sprite tag for each improvement, or `null` for {@link Improvement.None}. */
export const IMPROVEMENT_TAG: Readonly<Record<Improvement, string | null>> = {
    [Improvement.None]: null,
    [Improvement.Irrigation]: "tx.irrigation",
    [Improvement.Farmland]: "tx.farmland",
    [Improvement.Mine]: "tx.mine",
};

export interface GameMap {
    width: number;
    height: number;
    /** Row-major `width * height` terrain grid. */
    tiles: Uint8Array;
    /** Row-major boolean (`0`/`1`): does this land tile carry a river? */
    river: Uint8Array;
    /** Row-major boolean (`0`/`1`): does this land tile carry a road? */
    road: Uint8Array;
    /** Row-major {@link Special} per tile (`0` = none). */
    special: Uint8Array;
    /** Row-major {@link Improvement} per tile (`0` = none). */
    improvement: Uint8Array;
    cities: City[];
    at: (x: number, y: number) => Terrain;
    isLand: (x: number, y: number) => boolean;
    isOcean: (x: number, y: number) => boolean;
    hasRiver: (x: number, y: number) => boolean;
    hasRoad: (x: number, y: number) => boolean;
    specialAt: (x: number, y: number) => Special;
    improvementAt: (x: number, y: number) => Improvement;
}

/** Deterministic 32-bit hash → float in [0, 1). */
function hash2(x: number, y: number, seed: number): number {
    let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
}

function smooth(t: number): number {
    return t * t * (3 - 2 * t);
}

/** Value noise sampled at a fractional grid coordinate. */
function valueNoise(x: number, y: number, seed: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const v00 = hash2(xi, yi, seed);
    const v10 = hash2(xi + 1, yi, seed);
    const v01 = hash2(xi, yi + 1, seed);
    const v11 = hash2(xi + 1, yi + 1, seed);
    const top = v00 + (v10 - v00) * xf;
    const bot = v01 + (v11 - v01) * xf;
    return top + (bot - top) * yf;
}

/** Fractal (summed-octave) value noise in [0, 1]. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
    }
    return sum / norm;
}

export interface WorldGenOptions {
    width?: number;
    height?: number;
    seed?: number;
}

/** Generate a deterministic island continent with rivers, cities and roads. */
export function generateWorld(opts: WorldGenOptions = {}): GameMap {
    const width = opts.width ?? 48;
    const height = opts.height ?? 48;
    const seed = opts.seed ?? 1337;

    const tiles = new Uint8Array(width * height);
    const elevation = new Float32Array(width * height);
    const river = new Uint8Array(width * height);
    const road = new Uint8Array(width * height);
    const special = new Uint8Array(width * height);
    const improvement = new Uint8Array(width * height);

    const scale = 5.5; // continent feature size
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const ndx = (x - cx) / cx;
            const ndy = (y - cy) / cy;
            const dist = Math.sqrt(ndx * ndx + ndy * ndy);
            const falloff = Math.max(0, 1 - dist * dist * 1.15);

            const elev = fbm(x / scale, y / scale, seed, 5) * falloff * 1.35;
            const moisture = fbm(x / 7 + 50, y / 7 + 50, seed + 999, 3);
            const lat = Math.abs(y - cy) / cy;

            elevation[y * width + x] = elev;
            tiles[y * width + x] = classify(elev, moisture, lat);
        }
    }

    const at = (x: number, y: number): Terrain => {
        if (x < 0 || y < 0 || x >= width || y >= height) return Terrain.Ocean;
        return tiles[y * width + x] as Terrain;
    };
    const isLand = (x: number, y: number): boolean => at(x, y) !== Terrain.Ocean;
    const isOcean = (x: number, y: number): boolean => at(x, y) === Terrain.Ocean;

    const map: GameMap = {
        width,
        height,
        tiles,
        river,
        road,
        special,
        improvement,
        cities: [],
        at,
        isLand,
        isOcean,
        hasRiver: (x, y) => x >= 0 && y >= 0 && x < width && y < height && river[y * width + x] === 1,
        hasRoad: (x, y) => x >= 0 && y >= 0 && x < width && y < height && road[y * width + x] === 1,
        specialAt: (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? (special[y * width + x] as Special) : Special.None),
        improvementAt: (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? (improvement[y * width + x] as Improvement) : Improvement.None),
    };

    carveRivers(map, elevation, seed);
    map.cities = placeCities(map, seed);
    connectCities(map);
    decorateTiles(map, seed);

    return map;
}

function classify(elevation: number, moisture: number, lat: number): Terrain {
    if (elevation < 0.32) return Terrain.Ocean;
    if (lat > 0.86) return Terrain.Arctic;
    if (lat > 0.72) return elevation > 0.6 ? Terrain.Mountains : Terrain.Tundra;
    if (elevation > 0.78) return Terrain.Mountains;
    if (elevation > 0.62) return Terrain.Hills;

    const equatorial = lat < 0.32;
    if (moisture < 0.36) return equatorial ? Terrain.Desert : Terrain.Plains;
    if (moisture > 0.66) {
        if (elevation < 0.4) return Terrain.Swamp;
        return equatorial ? Terrain.Jungle : Terrain.Forest;
    }
    return equatorial ? Terrain.Plains : Terrain.Grassland;
}

/** Trace rivers from a handful of high-ground sources downhill to the sea. */
function carveRivers(map: GameMap, elevation: Float32Array, seed: number): void {
    const { width, height, river } = map;
    const elevAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? -1 : elevation[y * width + x]!);

    // Candidate sources: high land tiles, sampled deterministically.
    const sources: { x: number; y: number; e: number }[] = [];
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            if (!map.isLand(x, y)) continue;
            const e = elevation[y * width + x]!;
            if (e > 0.66 && hash2(x, y, seed + 7) > 0.78) sources.push({ x, y, e });
        }
    }
    sources.sort((a, b) => b.e - a.e);

    let carved = 0;
    for (const src of sources) {
        if (carved >= 8) break;
        let x = src.x;
        let y = src.y;
        const visited = new Set<number>();
        let reachedSea = false;
        for (let step = 0; step < width + height; step++) {
            const key = y * width + x;
            if (visited.has(key)) break;
            visited.add(key);
            // Flow into the sea: mark and stop.
            if (map.isOcean(x, y)) {
                reachedSea = true;
                break;
            }
            river[key] = 1;
            // Pick the lowest edge neighbour (rivers run along diamond edges,
            // i.e. the orthogonal 4-neighbourhood, so sprites connect cleanly).
            let best: Dir8 | null = null;
            let bestE = elevAt(x, y);
            for (const dir of EDGES) {
                const [dx, dy] = DIR_DELTA[dir];
                const e = elevAt(x + dx, y + dy);
                if (e >= 0 && e < bestE) {
                    bestE = e;
                    best = dir;
                }
            }
            if (!best) break; // local minimum — leave a short inland river
            const [dx, dy] = DIR_DELTA[best];
            x += dx;
            y += dy;
        }
        // Only keep rivers that actually reach water, so we don't strand puddles.
        if (reachedSea && visited.size > 1) carved++;
        else for (const k of visited) river[k] = 0;
    }
}

/** Settle cities on hospitable land, spread apart. */
function placeCities(map: GameMap, seed: number): City[] {
    const { width, height } = map;
    const cities: City[] = [];
    const spacing = 6;
    const hospitable = (x: number, y: number): boolean => {
        const t = map.at(x, y);
        return t === Terrain.Grassland || t === Terrain.Plains;
    };

    // Score tiles by desirability (river + coast bonus) and greedily pick spread-out ones.
    const scored: { x: number; y: number; s: number }[] = [];
    for (let y = 2; y < height - 2; y++) {
        for (let x = 2; x < width - 2; x++) {
            if (!hospitable(x, y)) continue;
            let s = hash2(x, y, seed + 31);
            if (map.hasRiver(x, y)) s += 1.5;
            if (DIR8.some((d) => map.isOcean(x + DIR_DELTA[d][0], y + DIR_DELTA[d][1]))) s += 0.6;
            scored.push({ x, y, s });
        }
    }
    scored.sort((a, b) => b.s - a.s);

    // Babylon — the capital — is pinned at the centre of the map (population 5,
    // a nod to Babylon 5). Spiral out from the exact centre to the nearest
    // hospitable tile so it always lands on settle-able ground.
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    let bx = cx;
    let by = cy;
    outer: for (let r = 0; r < Math.max(width, height); r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx;
                const y = cy + dy;
                if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
                if (hospitable(x, y)) {
                    bx = x;
                    by = y;
                    break outer;
                }
            }
        }
    }
    cities.push({ x: bx, y: by, size: 5, name: "Babylon" });

    let nameIndex = 0;
    for (const c of scored) {
        if (cities.length >= 9) break;
        if (cities.some((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) < spacing)) continue;
        const size = 1 + Math.floor(hash2(c.x, c.y, seed + 53) * 15); // fake population 1‒15
        const name = CITY_NAMES[nameIndex++ % CITY_NAMES.length]!;
        cities.push({ x: c.x, y: c.y, size, name });
    }
    return cities;
}

/** Link each city to its nearest already-connected neighbour with a road. */
function connectCities(map: GameMap): void {
    const { cities } = map;
    if (cities.length < 2) return;

    const connected: City[] = [cities[0]!];
    const remaining = cities.slice(1);
    while (remaining.length > 0) {
        // Find the closest remaining→connected pair (Prim-style MST growth).
        let bestI = 0;
        let bestJ = 0;
        let bestD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const r = remaining[i]!;
            for (let j = 0; j < connected.length; j++) {
                const c = connected[j]!;
                const d = Math.abs(r.x - c.x) + Math.abs(r.y - c.y);
                if (d < bestD) {
                    bestD = d;
                    bestI = i;
                    bestJ = j;
                }
            }
        }
        const from = remaining[bestI]!;
        const to = connected[bestJ]!;
        carveRoad(map, from, to);
        connected.push(from);
        remaining.splice(bestI, 1);
    }
}

/** Step a road from `a` to `b` along a greedy land path (cardinal+diagonal moves). */
function carveRoad(map: GameMap, a: City, b: City): void {
    const { width, road } = map;
    let x = a.x;
    let y = a.y;
    let guard = 0;
    while ((x !== b.x || y !== b.y) && guard++ < map.width + map.height + 8) {
        road[y * width + x] = 1;
        // Choose the neighbour that reduces remaining distance most, preferring land.
        let best: Dir8 | null = null;
        let bestScore = Infinity;
        for (const dir of DIR8) {
            const [dx, dy] = DIR_DELTA[dir];
            const nx = x + dx;
            const ny = y + dy;
            const dist = Math.abs(nx - b.x) + Math.abs(ny - b.y);
            const penalty = map.isLand(nx, ny) ? 0 : 2; // cross water only if unavoidable
            const score = dist + penalty;
            if (score < bestScore) {
                bestScore = score;
                best = dir;
            }
        }
        if (!best) break;
        const [dx, dy] = DIR_DELTA[best];
        x += dx;
        y += dy;
    }
    road[b.y * width + b.x] = 1;
}

/** Scatter bonus resources and terrain improvements deterministically. */
function decorateTiles(map: GameMap, seed: number): void {
    const { width, height, special, improvement } = map;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!map.isLand(x, y)) continue;
            const i = y * width + x;
            const t = map.at(x, y);

            // Sparse bonus resources (~9% of land), terrain-appropriate.
            if (hash2(x, y, seed + 131) > 0.91) {
                special[i] = specialFor(t, hash2(x, y, seed + 137));
                continue; // keep a tile to either a resource OR an improvement, not both
            }

            // Mines on rough terrain; irrigation/farmland on workable flat land
            // near a water source (river or coast).
            if (t === Terrain.Hills || t === Terrain.Mountains) {
                if (hash2(x, y, seed + 211) > 0.85) improvement[i] = Improvement.Mine;
            } else if (t === Terrain.Grassland || t === Terrain.Plains) {
                const watered = map.hasRiver(x, y) || EDGES.some((d) => map.isOcean(x + DIR_DELTA[d][0], y + DIR_DELTA[d][1]) || map.hasRiver(x + DIR_DELTA[d][0], y + DIR_DELTA[d][1]));
                if (watered && hash2(x, y, seed + 223) > 0.45) {
                    improvement[i] = hash2(x, y, seed + 229) > 0.6 ? Improvement.Farmland : Improvement.Irrigation;
                }
            }
        }
    }
}

/** Pick a terrain-appropriate bonus resource. */
function specialFor(t: Terrain, r: number): Special {
    switch (t) {
        case Terrain.Desert:
            return Special.Oasis;
        case Terrain.Plains:
            return Special.Wheat;
        case Terrain.Grassland:
            return r > 0.5 ? Special.Wheat : Special.Wine;
        case Terrain.Hills:
            return r > 0.5 ? Special.Gold : Special.Coal;
        case Terrain.Mountains:
            return r > 0.5 ? Special.Gold : Special.Coal;
        case Terrain.Forest:
            return Special.Furs;
        case Terrain.Jungle:
            return Special.Gems;
        case Terrain.Tundra:
            return Special.Furs;
        case Terrain.Swamp:
            return Special.Gems;
        default:
            return Special.None;
    }
}
