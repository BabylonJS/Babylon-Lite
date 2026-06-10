/**
 * Live simulation layer for the Freeciv demo — the bits that move.
 *
 * Pure-2D, no scene: a handful of sprites are mutated every animation frame to
 * make the static tilemap feel alive:
 *   - a roaming **scout** (explorer unit) that wanders the continent (and, while
 *     selected, gently blinks via its sprite alpha so the player can spot it), and
 *   - a few pieces of **roaming wildlife** from the animals sheet.
 *
 * Fog of war (which lifts as the scout and cities gain sight) lives in its own
 * module (`fog.ts`); it reads the scout's tile from here each frame. The selection
 * ring / destination marker / click-ping command feedback lives in `commandfx.ts`.
 *
 * Everything is seeded off the world so the demo replays identically.
 */

import { addSprite2DIndex, updateSprite2DIndex } from "babylon-lite";
import { DIR8, DIR_DELTA, TILE_H, isoCentre } from "./iso.js";
import type { TileLayers, TileSheets } from "./tilemap.js";
import type { GameMap } from "./worldgen.js";

/** Wildlife species drawn from the animals sheet. */
const ANIMAL_TAGS = ["u.wolf", "u.bear", "u.leopard", "u.tiger", "u.crocodile", "u.gorilla", "u.snake"] as const;
const ANIMAL_COUNT = 6;
/** Scout sprite footprint (world px). */
const SCOUT_W = 64;
const SCOUT_H = 48;
/** Selected-unit BLINK: its opacity oscillates between SCOUT_BLINK_MIN and full, at this
 * speed (rad/ms), so the active unit flashes gently instead of changing size. */
const SCOUT_BLINK_MIN = 0.3;
const SCOUT_BLINK_SPEED = 0.006;

/** A sprite that walks tile-to-tile with smooth interpolation. */
interface Walker {
    x: number;
    y: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    /** Interpolation progress 0→1 across the current hop. */
    t: number;
    /** Progress added per millisecond (≈ hop speed). */
    speed: number;
    /** Milliseconds left to idle before the next hop. */
    dwellMs: number;
    /** Sprite slot index in `layer`. */
    index: number;
    /** Vertical pixel offset so the sprite stands on the diamond. */
    yOffset: number;
    /** Deterministic per-walker RNG state. */
    rng: number;
}

export interface LiveSim {
    /** Advance the simulation by `dtMs` and push sprite updates. */
    step: (dtMs: number) => void;
    /**
     * Queue a tile-by-tile path for the scout (each entry must be adjacent to the
     * previous one). Switches the scout from autonomous wandering to player
     * control: once ordered, it waits for orders instead of roaming.
     */
    commandScout: (path: ReadonlyArray<readonly [number, number]>) => void;
    /** The scout's current tile (or the tile it's about to reach, if mid-hop). */
    scoutTile: () => [number, number];
    /** The scout's live interpolated world-pixel position (its ground point), for trailing FX. */
    scoutWorld: () => [number, number];
    /** Whether the scout is mid-hop (moving) right now — emit dust only while it walks. */
    scoutMoving: () => boolean;
    /** Mark the scout selected/deselected. While selected the scout sprite gently blinks
     * (its alpha oscillates) so the player can see it's the unit under their command. */
    setScoutSelected: (selected: boolean) => void;
}

/** Mulberry32 — tiny deterministic RNG. */
function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Smoothstep easing for a less robotic hop. */
function ease(t: number): number {
    return t * t * (3 - 2 * t);
}

/**
 * Spawn the moving sprites and return a `step` driver. Adds the scout to the
 * (otherwise static) unit layer and wildlife to the animals layer. Fog of war
 * (`fog.ts`) and the selection / command feedback FX (`commandfx.ts`) are handled
 * in their own modules.
 */
export function createLiveSim(world: GameMap, sheets: TileSheets, layers: TileLayers): LiveSim {
    const { width, height } = world;
    const rand = makeRng((world.cities.length + 1) * 2654435761);

    const landTiles: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (world.isLand(x, y)) landTiles.push({ x, y });
        }
    }

    const isCityTile = (x: number, y: number): boolean => world.cities.some((c) => c.x === x && c.y === y);

    // --- Scout (explorer) ------------------------------------------------
    const scoutStart = world.cities[0] ?? landTiles[Math.floor(rand() * landTiles.length)]!;
    const scoutGrid = sheets.units.grid("grid_main");
    const scoutFrame = scoutGrid.frameOf("u.explorer") ?? scoutGrid.frameOf("u.horsemen") ?? 0;
    const [ssx, ssy] = isoCentre(scoutStart.x, scoutStart.y);
    const scoutIndex = addSprite2DIndex(layers.unit, {
        positionPx: [ssx, ssy + TILE_H * 0.5],
        sizePx: [SCOUT_W, SCOUT_H],
        frame: scoutFrame,
    });
    const scout: Walker = {
        x: scoutStart.x,
        y: scoutStart.y,
        fromX: scoutStart.x,
        fromY: scoutStart.y,
        toX: scoutStart.x,
        toY: scoutStart.y,
        t: 1,
        speed: 1 / 620,
        dwellMs: 400,
        index: scoutIndex,
        yOffset: TILE_H * 0.5,
        rng: (scoutStart.x * 73856093) ^ (scoutStart.y * 19349663),
    };

    // Selected state drives the scout's pulse; `elapsedMs` accumulates wall time for it.
    let scoutSelected = false;
    let elapsedMs = 0;

    // --- Wildlife --------------------------------------------------------
    const animalGrid = sheets.animals.grid("grid_main");
    const animals: Walker[] = [];
    for (let i = 0; i < ANIMAL_COUNT; i++) {
        const tag = ANIMAL_TAGS[i % ANIMAL_TAGS.length]!;
        const frame = animalGrid.frameOf(tag);
        if (frame === undefined) continue;
        // Pick a land tile that isn't a city.
        let spot = landTiles[Math.floor(rand() * landTiles.length)]!;
        for (let tries = 0; tries < 8 && isCityTile(spot.x, spot.y); tries++) {
            spot = landTiles[Math.floor(rand() * landTiles.length)]!;
        }
        const [ax, ay] = isoCentre(spot.x, spot.y);
        const index = addSprite2DIndex(layers.animals, {
            positionPx: [ax, ay + TILE_H * 0.4],
            sizePx: [64, 48],
            frame,
        });
        animals.push({
            x: spot.x,
            y: spot.y,
            fromX: spot.x,
            fromY: spot.y,
            toX: spot.x,
            toY: spot.y,
            t: 1,
            speed: 1 / (700 + rand() * 500),
            dwellMs: 300 + rand() * 1200,
            index,
            yOffset: TILE_H * 0.4,
            rng: (spot.x * 83492791) ^ (spot.y * 12582917) ^ (i + 1),
        });
    }

    // Player-issued orders: a queue of adjacent tiles for the scout to walk. The
    // scout is fully player-controlled — it idles until the player clicks a
    // destination, then follows the commanded path.
    let scoutPath: Array<[number, number]> = [];

    // Pick the scout's next hop from the commanded path; idle when none is queued.
    const pickScoutTarget = (w: Walker): void => {
        if (scoutPath.length > 0) {
            const next = scoutPath.shift()!;
            w.toX = next[0];
            w.toY = next[1];
        }
    };

    // Pick a wandering animal's next hop (any adjacent land tile).
    const pickAnimalTarget = (w: Walker): void => {
        const r = makeRng(w.rng++ >>> 0);
        const opts: { x: number; y: number }[] = [];
        for (const d of DIR8) {
            const [dx, dy] = DIR_DELTA[d];
            const x = w.x + dx;
            const y = w.y + dy;
            if (world.isLand(x, y) && !isCityTile(x, y)) opts.push({ x, y });
        }
        if (opts.length === 0) return;
        const pick = opts[Math.floor(r() * opts.length)]!;
        w.toX = pick.x;
        w.toY = pick.y;
    };

    const advanceWalker = (w: Walker, dtMs: number, pickTarget: (w: Walker) => void): boolean => {
        let arrived = false;
        if (w.t >= 1) {
            if (w.dwellMs > 0) {
                w.dwellMs -= dtMs;
            } else {
                w.fromX = w.x;
                w.fromY = w.y;
                pickTarget(w);
                if (w.toX === w.x && w.toY === w.y) {
                    w.dwellMs = 300; // nowhere to go; idle and retry
                } else {
                    w.t = 0;
                }
            }
        } else {
            w.t = Math.min(1, w.t + w.speed * dtMs);
            if (w.t >= 1) {
                w.x = w.toX;
                w.y = w.toY;
                w.dwellMs = 250 + ((w.rng >>> 8) & 0x3ff);
                arrived = true;
            }
        }
        return arrived;
    };

    const walkerPx = (w: Walker): [number, number] => {
        const [fx, fy] = isoCentre(w.fromX, w.fromY);
        const [tx, ty] = isoCentre(w.toX, w.toY);
        const k = ease(w.t);
        return [fx + (tx - fx) * k, fy + (ty - fy) * k];
    };

    return {
        step(dtMs: number): void {
            elapsedMs += dtMs;
            // Scout movement (sight/fog reveal is handled by the fog module, which
            // reads the scout's tile each frame).
            const scoutArrived = advanceWalker(scout, dtMs, pickScoutTarget);
            // While following a commanded path, step crisply between tiles instead of
            // taking the lazy wander pause.
            if (scoutArrived && scoutPath.length > 0) scout.dwellMs = 40;
            const [scx, scy] = walkerPx(scout);
            // Selected scouts blink (opacity oscillates) so the player can spot the active unit.
            const blink = scoutSelected ? SCOUT_BLINK_MIN + (1 - SCOUT_BLINK_MIN) * (0.5 + 0.5 * Math.sin(elapsedMs * SCOUT_BLINK_SPEED)) : 1;
            updateSprite2DIndex(layers.unit, scout.index, {
                positionPx: [scx, scy + scout.yOffset],
                color: [1, 1, 1, blink],
            });

            // Wildlife wander.
            for (const a of animals) {
                advanceWalker(a, dtMs, pickAnimalTarget);
                const [ax, ay] = walkerPx(a);
                updateSprite2DIndex(layers.animals, a.index, { positionPx: [ax, ay + a.yOffset] });
            }
        },
        commandScout(path: ReadonlyArray<readonly [number, number]>): void {
            scoutPath = path.map(([x, y]) => [x, y] as [number, number]);
            // If the scout is idling, clear its dwell so the next tick picks up the
            // first waypoint immediately rather than after the idle pause.
            if (scout.t >= 1) scout.dwellMs = 0;
        },
        scoutTile(): [number, number] {
            // Mid-hop the logical tile is still the origin, but new orders should
            // chain off the tile it's about to reach.
            return scout.t < 1 ? [scout.toX, scout.toY] : [scout.x, scout.y];
        },
        scoutWorld(): [number, number] {
            // The scout's smooth ground position (isoCentre interpolated across the hop),
            // so trailing FX can drop puffs exactly under it rather than snapping per tile.
            return walkerPx(scout);
        },
        scoutMoving(): boolean {
            return scout.t < 1;
        },
        setScoutSelected(selected: boolean): void {
            scoutSelected = selected;
        },
    };
}
