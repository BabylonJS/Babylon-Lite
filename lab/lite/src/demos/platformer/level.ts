/**
 * World layout for the platformer demo, modelled as discrete **areas**.
 *
 * Each `LevelArea` is a self-contained little level on its OWN tile grid (its own
 * `solid`/`oneway` collider, terrain, blocks, coins, enemies, lava, torches, movers,
 * pipes, named entry points and an optional flag goal). The runtime loads one area at
 * a time with `loadArea`, tearing down + refilling the pooled sprite layers — so areas
 * can differ in size and theme without a giant shared grid. Pipes warp between areas by
 * naming a destination `toArea` + `toEntry`.
 *
 * Areas today: `overworld` (1-1, grassy) and `cave` (1-2, lava-lit underground).
 *
 * One cohesive CC0 art style throughout (Kenney "Platformer Art Deluxe").
 */

export type BlockKind = "brick" | "coin-block" | "mushroom-block" | "star-block";
export type EnemyKind = "slime" | "snail" | "fly" | "piranha";
export type AreaId = "overworld" | "cave" | "castle";
export type AreaTheme = "overworld" | "cave" | "castle";

export interface Cell {
    cx: number;
    cy: number;
}

export interface TerrainTile extends Cell {
    /** Tiles-sheet frame name. */
    name: string;
}

export interface BlockSpawn extends Cell {
    kind: BlockKind;
}

export interface EnemySpawn extends Cell {
    kind: EnemyKind;
}

/** A rectangular molten-lava pool (tile coordinates) — an animated underground hazard. */
export interface LavaRect extends Cell {
    w: number;
    h: number;
}

/** A moving (kinematic) platform that carries the player. Travels along one axis and ping-pongs. */
export interface MoverSpec extends Cell {
    /** Platform width in tiles. */
    w: number;
    axis: "x" | "y";
    /** Travel distance in tiles from the start cell. */
    range: number;
    /** Speed in tiles per second. */
    speed: number;
}

/** A pipe sprite. Warp pipes name a destination area + entry; decorative pipes don't. */
export interface Pipe {
    /** Top-left tile of the pipe sprite + its solid collision footprint. */
    cx: number;
    cy: number;
    w: number;
    h: number;
    /** Destination area for a warp pipe (undefined ⇒ decorative, not a warp trigger). */
    toArea?: AreaId;
    /** Named entry point in the destination area to emerge from. */
    toEntry?: string;
    /** Decorative pipes are solid + drawn but never warp (e.g. piranha / emerge pipes). */
    decorative?: boolean;
}

/** One self-contained area: its own grid, content, entries and theme. */
export interface LevelArea {
    id: AreaId;
    theme: AreaTheme;
    cols: number;
    rows: number;
    solid: Uint8Array;
    /** One-way platforms: pass up through, land on top (parallel to `solid`). */
    oneway: Uint8Array;
    terrain: TerrainTile[];
    blocks: BlockSpawn[];
    coins: Cell[];
    enemies: EnemySpawn[];
    hazards: Cell[];
    lava: LavaRect[];
    torches: Cell[];
    movers: MoverSpec[];
    pipes: Pipe[];
    /** Named entry cells the player can be placed at (warps + the default `start`). */
    entries: Record<string, Cell>;
    /** Default spawn (= `entries.start`), kept for convenience. */
    playerSpawn: Cell;
    /** Flag goal cell, or null for areas with no flag (cave). */
    flag: Cell | null;
    /** Boss spawn cell, or null for areas with no boss (overworld, cave). */
    bossSpawn: Cell | null;
    /** HUD world label shown while in this area. */
    worldLabel: string;
    /** Falling past this row (rows+1) kills the player. */
    deathRow: number;
}

export interface World {
    areas: Record<AreaId, LevelArea>;
    start: AreaId;
}

const ROWS = 14;
/** y of the top ground surface row (shared by all areas so the vertical scale matches). */
const GROUND_TOP = 12;

type Glyph = " " | "#" | "=" | "E" | "B" | "?" | "M" | "S" | "o" | "g" | "n" | "f" | "^" | "F" | "p";

/** Mutable accumulator used while assembling one area. */
interface AreaBuild {
    cols: number;
    solid: Uint8Array;
    oneway: Uint8Array;
    terrain: TerrainTile[];
    blocks: BlockSpawn[];
    coins: Cell[];
    enemies: EnemySpawn[];
    hazards: Cell[];
    lava: LavaRect[];
    torches: Cell[];
    movers: MoverSpec[];
    pipes: Pipe[];
}

function makeBuild(cols: number): AreaBuild {
    return {
        cols,
        solid: new Uint8Array(cols * ROWS),
        oneway: new Uint8Array(cols * ROWS),
        terrain: [],
        blocks: [],
        coins: [],
        enemies: [],
        hazards: [],
        lava: [],
        torches: [],
        movers: [],
        pipes: [],
    };
}

// ── Overworld (World 1-1) ─────────────────────────────────────────────────────

const OVERWORLD_COLS = 124;
const FLAG_COL = 114;

function buildOverworld(): LevelArea {
    const cols = OVERWORLD_COLS;
    const grid: Glyph[][] = Array.from({ length: ROWS }, () => Array.from({ length: cols }, () => " " as Glyph));
    const set = (cx: number, cy: number, g: Glyph): void => {
        if (cx >= 0 && cx < cols && cy >= 0 && cy < ROWS) grid[cy]![cx] = g;
    };

    // ── Solid ground floor (rows 12-13), with a few pits ──────────────────────
    const pits = new Set<number>();
    const addPit = (from: number, to: number): void => {
        for (let c = from; c <= to; c++) pits.add(c);
    };
    addPit(28, 29);
    addPit(57, 59);
    addPit(88, 89);
    for (let c = 0; c < cols; c++) {
        if (pits.has(c)) continue;
        set(c, GROUND_TOP, "#");
        set(c, GROUND_TOP + 1, "#");
    }

    set(3, GROUND_TOP - 1, "p"); // player spawn

    // ── Floating ?-block / brick rows ─────────────────────────────────────────
    const blockRow = GROUND_TOP - 4;
    set(16, blockRow, "?"); // coin
    set(18, blockRow, "B");
    set(19, blockRow, "M"); // mushroom (grow)
    set(20, blockRow, "B");
    set(22, blockRow, "?");
    set(19, blockRow - 4, "B");
    set(20, blockRow - 4, "S"); // star (invincibility)
    set(21, blockRow - 4, "B");

    // floating coins arcing over the first pit
    for (let i = 0; i < 4; i++) set(26 + i, GROUND_TOP - 3 - (i === 1 || i === 2 ? 1 : 0), "o");

    // ── Crate-style step blocks (solid) forming little platforms ──────────────
    set(34, GROUND_TOP - 2, "=");
    set(35, GROUND_TOP - 2, "=");
    set(40, GROUND_TOP - 3, "=");
    set(41, GROUND_TOP - 3, "=");
    set(46, GROUND_TOP - 4, "=");
    set(47, GROUND_TOP - 4, "=");
    for (let i = 0; i < 3; i++) set(41 + i, GROUND_TOP - 6, "o");

    // ── Enemies ───────────────────────────────────────────────────────────────
    set(14, GROUND_TOP - 1, "g");
    set(33, GROUND_TOP - 1, "g");
    set(44, GROUND_TOP - 5, "g"); // on the high platform
    set(53, GROUND_TOP - 1, "n"); // snail (shell-kick)
    set(54, GROUND_TOP - 1, "g");
    set(72, GROUND_TOP - 1, "g");
    set(73, GROUND_TOP - 1, "g");
    set(96, GROUND_TOP - 1, "n");
    set(38, GROUND_TOP - 4, "f"); // flyers (bob through the air)
    set(70, GROUND_TOP - 5, "f");
    set(108, GROUND_TOP - 4, "f");

    // ── A spike pit hazard run ────────────────────────────────────────────────
    for (let c = 64; c <= 67; c++) set(c, GROUND_TOP - 1, "^");

    // ── Brick/?-block bridge over second pit ──────────────────────────────────
    set(56, GROUND_TOP - 5, "B");
    set(57, GROUND_TOP - 5, "?");
    set(58, GROUND_TOP - 5, "B");
    set(59, GROUND_TOP - 5, "?");
    set(60, GROUND_TOP - 5, "B");

    // ── Coin cluster ──────────────────────────────────────────────────────────
    for (let i = 0; i < 6; i++) set(76 + i, GROUND_TOP - 3, "o");
    set(78, blockRow, "M"); // a second mushroom for safety

    // ── Ascending staircase before the goal (solid blocks) ────────────────────
    const stairBase = 100;
    for (let s = 0; s < 6; s++) {
        for (let h = 0; h <= s; h++) set(stairBase + s, GROUND_TOP - 1 - h, "E");
    }

    // ── Flag goal on a tall pedestal ──────────────────────────────────────────
    for (let h = 0; h < 8; h++) set(FLAG_COL, GROUND_TOP - 1 - h, "=");
    for (let h = 1; h < 8; h++) set(FLAG_COL, GROUND_TOP - 1 - h, " "); // clear pole cells (flag is an entity)
    set(FLAG_COL, GROUND_TOP - 1, "E"); // pedestal base = earthen tile (matches the ground, not white stone)
    set(FLAG_COL, GROUND_TOP - 9, "F");

    const b = makeBuild(cols);
    const compiled = compileGrid(b, grid, "overworld");

    // ── Warp + decorative pipes ───────────────────────────────────────────────
    // Green pipe at col 50 → into the cave; you emerge back out of it ("fromCave").
    addPipe(b, 50, GROUND_TOP - 2, 2, 2, { toArea: "cave", toEntry: "entry" });
    // A decorative pipe at col 80 with a piranha plant rising from it.
    addPipe(b, 80, GROUND_TOP - 2, 2, 2, { decorative: true });
    b.enemies.push({ cx: 80.5, cy: GROUND_TOP - 3, kind: "piranha" });

    // ── Breakable-brick platform over the later pit (replaces the old jump-through ledges) ──
    for (let i = 0; i < 5; i++) {
        b.solid[(GROUND_TOP - 4) * b.cols + (84 + i)] = 1;
        b.blocks.push({ cx: 84 + i, cy: GROUND_TOP - 4, kind: "brick" });
    }
    for (let i = 0; i < 5; i++) b.coins.push({ cx: 84 + i, cy: GROUND_TOP - 5 });

    // ── Moving platforms ──────────────────────────────────────────────────────
    b.movers.push({ cx: 56, cy: GROUND_TOP - 1, w: 3, axis: "x", range: 4, speed: 2.4 }); // ferry over 2nd pit
    b.movers.push({ cx: 92, cy: GROUND_TOP - 1, w: 3, axis: "y", range: 5, speed: 2.2 }); // elevator to a coin stash
    for (let i = 0; i < 3; i++) b.coins.push({ cx: 92 + i, cy: GROUND_TOP - 7 });

    const entries: Record<string, Cell> = {
        start: compiled.spawn,
        fromCave: { cx: 50.5, cy: GROUND_TOP - 3 }, // standing on top of the col-50/51 pipe
    };
    return finishArea(b, "overworld", "overworld", "1-1", entries, compiled.flag);
}

// ── Cave (World 1-2) ──────────────────────────────────────────────────────────

const CAVE_CEIL = 3;
const CAVE_W = 55; // interior span (col 0 = left wall, CAVE_W = right wall)
const CAVE_COLS = CAVE_W + 2;

function buildCave(): LevelArea {
    const b = makeBuild(CAVE_COLS);
    const caveSolid = (cx: number, cy: number, name: string): void => {
        b.solid[cy * b.cols + cx] = 1;
        b.terrain.push({ cx, cy, name });
    };
    const caveBlock = (cx: number, cy: number, kind: BlockKind): void => {
        b.solid[cy * b.cols + cx] = 1;
        b.blocks.push({ cx, cy, kind });
    };
    const W = CAVE_W;
    const lavaChannels: ReadonlyArray<readonly [number, number]> = [
        [13, 21],
        [35, 42],
    ];
    const inLavaChannel = (c: number): boolean => lavaChannels.some(([a, c1]) => c >= a && c <= c1);

    // Ceiling everywhere; floor everywhere except over the lava channels.
    for (let c = 0; c <= W; c++) {
        caveSolid(c, CAVE_CEIL, "stoneCenter");
        if (!inLavaChannel(c)) {
            caveSolid(c, GROUND_TOP, "stoneMid");
            caveSolid(c, GROUND_TOP + 1, "stoneCenter");
        }
    }
    // Side walls (full height).
    for (let cy = CAVE_CEIL + 1; cy <= GROUND_TOP + 1; cy++) {
        caveSolid(0, cy, "stoneCenter");
        caveSolid(W, cy, "stoneCenter");
    }
    // Molten lava filling each channel; first crossed on stepping-stones, second on a mover.
    lavaChannels.forEach(([a, c1], idx) => {
        b.lava.push({ cx: a, cy: GROUND_TOP, w: c1 - a + 1, h: 2 });
        if (idx === 0) {
            for (let c = a; c + 1 <= c1; c += 3) {
                caveSolid(c, GROUND_TOP - 2, "stoneMid");
                caveSolid(c + 1, GROUND_TOP - 2, "stoneMid");
                b.coins.push({ cx: c, cy: GROUND_TOP - 4 });
                b.coins.push({ cx: c + 1, cy: GROUND_TOP - 4 });
            }
        } else {
            b.movers.push({ cx: a, cy: GROUND_TOP - 1, w: 3, axis: "x", range: c1 - a - 2, speed: 2.3 });
            for (let c = a + 1; c <= c1 - 1; c += 2) b.coins.push({ cx: c, cy: GROUND_TOP - 3 });
        }
    });
    // Left entry chamber coins.
    for (let c = 5; c <= 11; c += 2) b.coins.push({ cx: c, cy: GROUND_TOP - 1 });
    // Mid chamber bonus ledge with reward blocks.
    for (let c = 24; c <= 30; c++) caveSolid(c, GROUND_TOP - 3, "stoneMid");
    caveBlock(26, GROUND_TOP - 6, "mushroom-block");
    caveBlock(28, GROUND_TOP - 6, "star-block");
    b.coins.push({ cx: 24, cy: GROUND_TOP - 6 });
    b.coins.push({ cx: 30, cy: GROUND_TOP - 6 });
    // Right chamber coin hoard before the exit.
    for (let c = 44; c <= 49; c += 2) {
        b.coins.push({ cx: c, cy: GROUND_TOP - 1 });
        b.coins.push({ cx: c, cy: GROUND_TOP - 2 });
    }
    // Underground slimes.
    b.enemies.push({ cx: 8, cy: GROUND_TOP - 1, kind: "slime" });
    b.enemies.push({ cx: 46, cy: GROUND_TOP - 1, kind: "slime" });
    // Torches.
    b.torches.push({ cx: 1, cy: GROUND_TOP - 1 });
    b.torches.push({ cx: 25, cy: GROUND_TOP - 4 });
    b.torches.push({ cx: 29, cy: GROUND_TOP - 4 });
    b.torches.push({ cx: W - 1, cy: GROUND_TOP - 1 });

    // Entry emerge pipe (decorative): the player rises out of it on warp-in.
    addPipe(b, 2, GROUND_TOP - 2, 2, 2, { decorative: true });
    // Exit pipe near the right wall → back to the overworld (emerge from its col-50 pipe).
    addPipe(b, 51, GROUND_TOP - 2, 2, 2, { toArea: "overworld", toEntry: "fromCave" });

    const entries: Record<string, Cell> = {
        start: { cx: 2.5, cy: GROUND_TOP - 3 }, // standing on top of the cols 2/3 emerge pipe
        entry: { cx: 2.5, cy: GROUND_TOP - 3 }, // top of the emerge pipe
    };
    return finishArea(b, "cave", "cave", "1-2", entries, null);
}

// ── Castle (World 1-3, the boss finale) ───────────────────────────────────────

const CASTLE_COLS = 30;
const CASTLE_CEIL = 2;

function buildCastle(): LevelArea {
    const b = makeBuild(CASTLE_COLS);
    const W = CASTLE_COLS - 1;
    const put = (cx: number, cy: number, name: string): void => {
        b.solid[cy * b.cols + cx] = 1;
        b.terrain.push({ cx, cy, name });
    };
    // Floor (rows 12-13) + a solid ceiling (row 2) the boss arena sits under.
    for (let c = 0; c <= W; c++) {
        put(c, GROUND_TOP, "castleMid");
        put(c, GROUND_TOP + 1, "castleCenter");
        put(c, CASTLE_CEIL, "castleCenter");
    }
    // Left + right walls (full height) so the arena is sealed.
    for (let cy = CASTLE_CEIL + 1; cy <= GROUND_TOP + 1; cy++) {
        put(0, cy, "castleCenter");
        put(W, cy, "castleCenter");
    }
    // A couple of castle ledges for the player to use against the boss.
    for (let c = 6; c <= 8; c++) put(c, GROUND_TOP - 4, "castleHalfMid");
    b.terrain.push({ cx: 5, cy: GROUND_TOP - 4, name: "castleHalfLeft" });
    b.oneway[(GROUND_TOP - 4) * b.cols + 5] = 1;
    b.terrain.push({ cx: 9, cy: GROUND_TOP - 4, name: "castleHalfRight" });
    b.oneway[(GROUND_TOP - 4) * b.cols + 9] = 1;
    for (let c = 5; c <= 9; c++) b.oneway[(GROUND_TOP - 4) * b.cols + c] = 1;
    // Reward coins above the ledge.
    for (let c = 5; c <= 9; c++) b.coins.push({ cx: c, cy: GROUND_TOP - 6 });
    // A power-up box on the entry ledge: a mushroom if you arrive small, a fire flower
    // if you're already big — so you can always gear up to fight the boss (fireballs +
    // a spare hit) even if you reached the castle without fire.
    b.solid[(GROUND_TOP - 7) * b.cols + 7] = 1;
    b.blocks.push({ cx: 7, cy: GROUND_TOP - 7, kind: "mushroom-block" });
    // Atmosphere: wall torches.
    b.torches.push({ cx: 2, cy: GROUND_TOP - 1 });
    b.torches.push({ cx: W - 2, cy: GROUND_TOP - 1 });
    b.torches.push({ cx: 14, cy: CASTLE_CEIL + 2 });
    // Decorative arched windows along the upper back wall (purely visual, not solid).
    for (const wx of [5, 10, 19, 24]) b.terrain.push({ cx: wx, cy: CASTLE_CEIL + 2, name: "window" });
    // A decorative door at the far right (the way "out", flavour only).
    b.terrain.push({ cx: W - 1, cy: GROUND_TOP - 2, name: "door_closedTop" });
    b.terrain.push({ cx: W - 1, cy: GROUND_TOP - 1, name: "door_closedMid" });

    const entries: Record<string, Cell> = {
        start: { cx: 3, cy: GROUND_TOP - 1 }, // player enters on the left floor
    };
    return finishArea(b, "castle", "castle", "1-3", entries, null, { cx: 22, cy: GROUND_TOP - 1 });
}

// ── Shared assembly helpers ───────────────────────────────────────────────────

/** Add a pipe (solid footprint + sprite). Warp pipes pass `toArea`/`toEntry`. */
function addPipe(b: AreaBuild, cx: number, cy: number, w: number, h: number, opts: { toArea?: AreaId; toEntry?: string; decorative?: boolean }): void {
    for (let x = cx; x < cx + w; x++) {
        for (let y = cy; y < cy + h; y++) b.solid[y * b.cols + x] = 1;
    }
    b.pipes.push({ cx, cy, w, h, ...opts });
}

/** Compile a glyph grid into the build's solid/terrain/blocks/coins/enemies/hazards. */
function compileGrid(b: AreaBuild, grid: Glyph[][], theme: AreaTheme): { spawn: Cell; flag: Cell | null } {
    const cols = b.cols;
    let spawn: Cell = { cx: 3, cy: GROUND_TOP - 1 };
    let flag: Cell | null = null;
    const isGround = (cx: number, cy: number): boolean => {
        if (cx < 0 || cx >= cols || cy < 0 || cy >= ROWS) return false;
        const g = grid[cy]![cx]!;
        return g === "#" || g === "=" || g === "E";
    };
    for (let cy = 0; cy < ROWS; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            const g = grid[cy]![cx]!;
            switch (g) {
                case "#":
                    b.solid[cy * cols + cx] = 1;
                    b.terrain.push({ cx, cy, name: groundFrame(cx, cy, isGround, theme) });
                    break;
                case "=":
                    b.solid[cy * cols + cx] = 1;
                    b.terrain.push({ cx, cy, name: platformFrame(cx, cy, isGround) });
                    break;
                case "E":
                    // Earthen step: grassMid is the only tile with a brown body, so the
                    // whole staircase (incl. its base) reads brown and blends into the ground.
                    b.solid[cy * cols + cx] = 1;
                    b.terrain.push({ cx, cy, name: "grassMid" });
                    break;
                case "B":
                    b.solid[cy * cols + cx] = 1;
                    b.blocks.push({ cx, cy, kind: "brick" });
                    break;
                case "?":
                    b.solid[cy * cols + cx] = 1;
                    b.blocks.push({ cx, cy, kind: "coin-block" });
                    break;
                case "M":
                    b.solid[cy * cols + cx] = 1;
                    b.blocks.push({ cx, cy, kind: "mushroom-block" });
                    break;
                case "S":
                    b.solid[cy * cols + cx] = 1;
                    b.blocks.push({ cx, cy, kind: "star-block" });
                    break;
                case "o":
                    b.coins.push({ cx, cy });
                    break;
                case "g":
                    b.enemies.push({ cx, cy, kind: "slime" });
                    break;
                case "n":
                    b.enemies.push({ cx, cy, kind: "snail" });
                    break;
                case "f":
                    b.enemies.push({ cx, cy, kind: "fly" });
                    break;
                case "^":
                    b.hazards.push({ cx, cy });
                    break;
                case "F":
                    flag = { cx, cy };
                    break;
                case "p":
                    spawn = { cx, cy };
                    break;
                default:
                    break;
            }
        }
    }
    return { spawn, flag };
}

/** Freeze an accumulator into a LevelArea. */
function finishArea(b: AreaBuild, id: AreaId, theme: AreaTheme, worldLabel: string, entries: Record<string, Cell>, flag: Cell | null, bossSpawn: Cell | null = null): LevelArea {
    return {
        id,
        theme,
        cols: b.cols,
        rows: ROWS,
        solid: b.solid,
        oneway: b.oneway,
        terrain: b.terrain,
        blocks: b.blocks,
        coins: b.coins,
        enemies: b.enemies,
        hazards: b.hazards,
        lava: b.lava,
        torches: b.torches,
        movers: b.movers,
        pipes: b.pipes,
        entries,
        playerSpawn: entries.start ?? { cx: 3, cy: GROUND_TOP - 1 },
        flag,
        bossSpawn,
        worldLabel,
        deathRow: ROWS + 1,
    };
}

/** Build the whole world (all areas). */
export function buildWorld(): World {
    return {
        areas: {
            overworld: buildOverworld(),
            cave: buildCave(),
            castle: buildCastle(),
        },
        start: "overworld",
    };
}

/** Pick a grass/dirt (or stone, in cave) ground frame for a solid ground cell. */
function groundFrame(cx: number, cy: number, isGround: (x: number, y: number) => boolean, theme: AreaTheme): string {
    const surface = !isGround(cx, cy - 1);
    if (theme === "cave") return surface ? "stoneMid" : "stoneCenter";
    if (surface) {
        const openLeft = !isGround(cx - 1, cy);
        const openRight = !isGround(cx + 1, cy);
        if (openLeft && !openRight) return "grassLeft";
        if (openRight && !openLeft) return "grassRight";
        return "grassMid";
    }
    // Below the surface: a full brown earth tile. (The pack's `dirtCenter` is bugged —
    // it shares atlas coords with `snowCenter` and renders light grey/white — so use
    // `grassCenter`, the dirt body that sits under grass; its brown matches `grassMid`.)
    return "grassCenter";
}

/** Floating solid platforms use stone tiles to read distinctly from the ground. */
function platformFrame(cx: number, cy: number, isGround: (x: number, y: number) => boolean): string {
    const surface = !isGround(cx, cy - 1);
    if (surface) {
        const openLeft = !isGround(cx - 1, cy);
        const openRight = !isGround(cx + 1, cy);
        if (openLeft && !openRight) return "stoneLeft";
        if (openRight && !openLeft) return "stoneRight";
        return "stoneMid";
    }
    return "stoneCenter";
}
