/**
 * Level 1-1 layout for the platformer demo, built programmatically on a tile grid.
 *
 * Rather than ship a giant hand-aligned ASCII block, the level is assembled with a
 * few helpers (ground runs, pits, stairs, block rows) into a `Level` describing:
 *  - a `solid` grid for the collider,
 *  - static `terrain` tiles (auto-edged grass/dirt) to draw once,
 *  - interactive `blocks` (?-blocks, bricks) with their hidden contents,
 *  - `coins`, `enemies`, `hazards`, the player spawn, and the flag goal.
 *
 * One cohesive CC0 art style throughout (Kenney "Platformer Art Deluxe").
 */

export type BlockKind = "brick" | "coin-block" | "mushroom-block" | "star-block";
export type EnemyKind = "slime" | "snail" | "fly" | "piranha";

export interface Cell {
    cx: number;
    cy: number;
}

export interface TerrainTile extends Cell {
    /** Ground-sheet frame name. */
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
    /** Footprint size in tiles. */
    w: number;
    h: number;
}

/** A moving (kinematic) platform that carries the player. Travels along one axis and ping-pongs. */
export interface MoverSpec extends Cell {
    /** Platform width in tiles. */
    w: number;
    /** Travel axis. */
    axis: "x" | "y";
    /** Travel distance in tiles from the start cell. */
    range: number;
    /** Speed in tiles per second. */
    speed: number;
}

/** A warp pipe linking the overworld to the underground bonus chamber (or back). */
export interface Pipe {
    /** Top-left tile of the pipe sprite + its solid collision footprint. */
    cx: number;
    cy: number;
    /** Footprint size in tiles. */
    w: number;
    h: number;
    /** Tile the player lands on after warping through this pipe. */
    toCx: number;
    toCy: number;
    /** True when this pipe leads into the cave (drives the dark backdrop + HUD label). */
    toCave: boolean;
    /** HUD world label to show after warping (e.g. "1-2"). */
    worldLabel: string;
    /** Decorative pipes are solid + drawn but are NOT warp triggers (e.g. piranha pipes). */
    decorative?: boolean;
}

export interface Level {
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
    /** Molten-lava pools (underground): animated visuals + an instant-death hazard. */
    lava: LavaRect[];
    /** Wall-torch cells lighting the underground (light sources for the lantern effect). */
    torches: Cell[];
    /** Moving platforms that carry the player (overworld pit-crosser + cave elevators). */
    movers: MoverSpec[];
    playerSpawn: Cell;
    flag: Cell;
    /** World tile column where falling below the map kills the player. */
    deathRow: number;
    /** Warp pipes linking the overworld and the underground bonus chamber. */
    pipes: Pipe[];
}

const OVERWORLD_COLS = 124;
const ROWS = 14;
/** y of the top ground surface row (shared by the overworld and the cave floor). */
const GROUND_TOP = 12;

// ── Underground cavern (a large sealed area reached by warp pipes) ──
/** Left / right solid wall columns of the cave; the interior lies between them.
 *  Placed well past the overworld (a wide void gap) so the two areas are never
 *  on screen together — the camera can't show overworld grass from inside the cave. */
const CAVE_X0 = 140;
const CAVE_X1 = 195;
/** Solid ceiling row of the cave. */
const CAVE_CEIL = 3;
/** Where the player lands when warping into the cave. */
const CAVE_ENTRY = { cx: CAVE_X0 + 2, cy: GROUND_TOP - 1 };
/** Where the player lands when warping back out to the overworld. */
const OVERWORLD_RETURN = { cx: 48, cy: GROUND_TOP - 1 };

/** Full grid width: the overworld, a void gap, then the cave chamber + margin. */
const COLS = CAVE_X1 + 3;

type Glyph = " " | "#" | "=" | "B" | "?" | "M" | "S" | "o" | "g" | "n" | "f" | "^" | "F" | "p";

export function buildLevel(): Level {
    const grid: Glyph[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => " " as Glyph));
    const set = (cx: number, cy: number, g: Glyph): void => {
        if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS) grid[cy]![cx] = g;
    };

    // ── Solid ground floor (rows 12-13), with a few pits ──────────────────────
    const pits = new Set<number>();
    const addPit = (from: number, to: number): void => {
        for (let c = from; c <= to; c++) pits.add(c);
    };
    addPit(28, 29);
    addPit(57, 59);
    addPit(88, 89);
    for (let c = 0; c < OVERWORLD_COLS; c++) {
        if (pits.has(c)) continue;
        set(c, GROUND_TOP, "#");
        set(c, GROUND_TOP + 1, "#");
    }

    // ── Player spawn ──────────────────────────────────────────────────────────
    set(3, GROUND_TOP - 1, "p");

    // ── Floating ?-block / brick rows ─────────────────────────────────────────
    const blockRow = GROUND_TOP - 4;
    set(16, blockRow, "?"); // coin
    set(18, blockRow, "B");
    set(19, blockRow, "M"); // mushroom (grow)
    set(20, blockRow, "B");
    set(22, blockRow, "?");
    // a stacked brick + ?-block above the middle of the first row
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
    // Flying enemies (bob through the air; stompable from above).
    set(38, GROUND_TOP - 4, "f");
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
        for (let h = 0; h <= s; h++) {
            set(stairBase + s, GROUND_TOP - 1 - h, "=");
        }
    }

    // ── Flag goal on a tall pedestal ──────────────────────────────────────────
    const flagCol = 114;
    for (let h = 0; h < 8; h++) set(flagCol, GROUND_TOP - 1 - h, "="); // pole pedestal column (solid base only at bottom)
    // keep only the base solid; clear the pole cells (flag handled as entity)
    for (let h = 1; h < 8; h++) set(flagCol, GROUND_TOP - 1 - h, " ");
    set(flagCol, GROUND_TOP - 9, "F");

    // ── Compile to Level ──────────────────────────────────────────────────────
    const solid = new Uint8Array(COLS * ROWS);
    const oneway = new Uint8Array(COLS * ROWS);
    const terrain: TerrainTile[] = [];
    const blocks: BlockSpawn[] = [];
    const coins: Cell[] = [];
    const enemies: EnemySpawn[] = [];
    const hazards: Cell[] = [];
    const movers: MoverSpec[] = [];
    let playerSpawn: Cell = { cx: 3, cy: GROUND_TOP - 1 };
    let flag: Cell = { cx: flagCol, cy: GROUND_TOP - 9 };

    const isGround = (cx: number, cy: number): boolean => {
        if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false;
        const g = grid[cy]![cx]!;
        return g === "#" || g === "=";
    };

    for (let cy = 0; cy < ROWS; cy++) {
        for (let cx = 0; cx < COLS; cx++) {
            const g = grid[cy]![cx]!;
            switch (g) {
                case "#": {
                    solid[cy * COLS + cx] = 1;
                    terrain.push({ cx, cy, name: groundFrame(cx, cy, isGround) });
                    break;
                }
                case "=": {
                    solid[cy * COLS + cx] = 1;
                    terrain.push({ cx, cy, name: platformFrame(cx, cy, isGround) });
                    break;
                }
                case "B":
                    solid[cy * COLS + cx] = 1;
                    blocks.push({ cx, cy, kind: "brick" });
                    break;
                case "?":
                    solid[cy * COLS + cx] = 1;
                    blocks.push({ cx, cy, kind: "coin-block" });
                    break;
                case "M":
                    solid[cy * COLS + cx] = 1;
                    blocks.push({ cx, cy, kind: "mushroom-block" });
                    break;
                case "S":
                    solid[cy * COLS + cx] = 1;
                    blocks.push({ cx, cy, kind: "star-block" });
                    break;
                case "o":
                    coins.push({ cx, cy });
                    break;
                case "g":
                    enemies.push({ cx, cy, kind: "slime" });
                    break;
                case "n":
                    enemies.push({ cx, cy, kind: "snail" });
                    break;
                case "f":
                    enemies.push({ cx, cy, kind: "fly" });
                    break;
                case "^":
                    hazards.push({ cx, cy });
                    break;
                case "F":
                    flag = { cx, cy };
                    break;
                case "p":
                    playerSpawn = { cx, cy };
                    break;
                default:
                    break;
            }
        }
    }

    // ── Underground cavern ────────────────────────────────────────────────────
    // A large sealed cavern appended to the same tile grid (past a void gap), reached
    // only by warp pipe. Built directly into solid/terrain/lava (bypassing the glyph
    // grid) with explicit stone frames: two molten LAVA channels crossed on stone
    // stepping-stones, a raised bonus ledge with reward blocks, and wall torches that
    // light the gloom. The existing terrain/coin/block systems draw it as-is.
    const caveSolid = (cx: number, cy: number, name: string): void => {
        solid[cy * COLS + cx] = 1;
        terrain.push({ cx, cy, name });
    };
    const caveBlock = (cx: number, cy: number, kind: BlockKind): void => {
        solid[cy * COLS + cx] = 1;
        blocks.push({ cx, cy, kind });
    };
    const lava: LavaRect[] = [];
    const torches: Cell[] = [];
    const col = (c: number): number => CAVE_X0 + c; // interior column offset → absolute
    const W = CAVE_X1 - CAVE_X0; // interior span in columns (0 = left wall, W = right wall)
    // Lava channels (relative column ranges): the floor is omitted here and the gap
    // filled with molten lava; stone stepping-stones let the player hop across.
    const lavaChannels: ReadonlyArray<readonly [number, number]> = [
        [13, 21],
        [35, 42],
    ];
    const inLavaChannel = (c: number): boolean => lavaChannels.some(([a, b]) => c >= a && c <= b);

    // Ceiling everywhere; floor everywhere except over the lava channels.
    for (let c = 0; c <= W; c++) {
        caveSolid(col(c), CAVE_CEIL, "stoneCenter");
        if (!inLavaChannel(c)) {
            caveSolid(col(c), GROUND_TOP, "stoneMid");
            caveSolid(col(c), GROUND_TOP + 1, "stoneCenter");
        }
    }
    // Side walls (full height).
    for (let cy = CAVE_CEIL + 1; cy <= GROUND_TOP + 1; cy++) {
        caveSolid(CAVE_X0, cy, "stoneCenter");
        caveSolid(CAVE_X1, cy, "stoneCenter");
    }
    // Molten lava filling each channel (rows GROUND_TOP..+1). The first channel is
    // crossed on stone stepping-stones; the second on a horizontal moving platform.
    lavaChannels.forEach(([a, b], idx) => {
        lava.push({ cx: col(a), cy: GROUND_TOP, w: b - a + 1, h: 2 });
        if (idx === 0) {
            for (let c = a; c + 1 <= b; c += 3) {
                caveSolid(col(c), GROUND_TOP - 2, "stoneMid"); // 2-wide stepping platform
                caveSolid(col(c + 1), GROUND_TOP - 2, "stoneMid");
                coins.push({ cx: col(c), cy: GROUND_TOP - 4 }); // a coin reward above each
                coins.push({ cx: col(c + 1), cy: GROUND_TOP - 4 });
            }
        } else {
            movers.push({ cx: col(a), cy: GROUND_TOP - 1, w: 3, axis: "x", range: b - a - 2, speed: 2.3 });
            for (let c = a + 1; c <= b - 1; c += 2) coins.push({ cx: col(c), cy: GROUND_TOP - 3 });
        }
    });
    // Left entry chamber: a few ground coins to greet the player.
    for (let c = 3; c <= 11; c += 2) coins.push({ cx: col(c), cy: GROUND_TOP - 1 });
    // Mid chamber raised bonus ledge with reward blocks the player bumps from below.
    for (let c = 24; c <= 30; c++) caveSolid(col(c), GROUND_TOP - 4, "stoneMid");
    caveBlock(col(26), GROUND_TOP - 6, "mushroom-block");
    caveBlock(col(28), GROUND_TOP - 6, "star-block");
    coins.push({ cx: col(24), cy: GROUND_TOP - 6 });
    coins.push({ cx: col(30), cy: GROUND_TOP - 6 });
    // Right chamber: a small coin hoard before the exit pipe.
    for (let c = 44; c <= 49; c += 2) {
        coins.push({ cx: col(c), cy: GROUND_TOP - 1 });
        coins.push({ cx: col(c), cy: GROUND_TOP - 2 });
    }
    // A little underground life: slimes patrolling the entry + right chambers.
    enemies.push({ cx: col(8), cy: GROUND_TOP - 1, kind: "slime" });
    enemies.push({ cx: col(46), cy: GROUND_TOP - 1, kind: "slime" });
    // Wall/ledge torches (underground light sources): corner braziers + ledge torches.
    torches.push({ cx: col(1), cy: GROUND_TOP - 1 }); // entry corner, on the floor
    torches.push({ cx: col(25), cy: GROUND_TOP - 5 }); // on the mid bonus ledge
    torches.push({ cx: col(29), cy: GROUND_TOP - 5 }); // on the mid bonus ledge
    torches.push({ cx: col(W - 1), cy: GROUND_TOP - 1 }); // exit corner, on the floor

    // ── Warp pipes (duck on top to enter) ─────────────────────────────────────
    const pipes: Pipe[] = [];
    const addPipe = (cx: number, cy: number, w: number, h: number, toCx: number, toCy: number, toCave: boolean, worldLabel: string): void => {
        for (let x = cx; x < cx + w; x++) {
            for (let y = cy; y < cy + h; y++) solid[y * COLS + x] = 1;
        }
        pipes.push({ cx, cy, w, h, toCx, toCy, toCave, worldLabel });
    };
    // Overworld pipe on the ground at col 50 → into the cave.
    addPipe(50, GROUND_TOP - 2, 2, 2, CAVE_ENTRY.cx, CAVE_ENTRY.cy, true, "1-2");
    // Cave exit pipe on the cave floor near the right wall → back to the overworld.
    addPipe(col(51), GROUND_TOP - 2, 2, 2, OVERWORLD_RETURN.cx, OVERWORLD_RETURN.cy, false, "1-1");

    // Decorative (non-warp) pipes that house piranha plants. Solid + drawn, but not warps.
    const addPiranhaPipe = (cx: number): void => {
        for (let x = cx; x < cx + 2; x++) {
            for (let y = GROUND_TOP - 2; y <= GROUND_TOP - 1; y++) solid[y * COLS + x] = 1;
        }
        pipes.push({ cx, cy: GROUND_TOP - 2, w: 2, h: 2, toCx: 0, toCy: 0, toCave: false, worldLabel: "", decorative: true });
        // Piranha centred over the pipe, emerging from its lip (row GROUND_TOP-2).
        enemies.push({ cx: cx + 0.5, cy: GROUND_TOP - 3, kind: "piranha" });
    };
    addPiranhaPipe(80);

    // ── One-way (jump-through) platforms ──────────────────────────────────────
    // Thin grass ledges you can hop up through and land on; drawn auto-edged.
    const addOneWay = (cx0: number, cx1: number, cy: number): void => {
        for (let cx = cx0; cx <= cx1; cx++) {
            oneway[cy * COLS + cx] = 1;
            const name = cx0 === cx1 ? "grassHalf" : cx === cx0 ? "grassHalfLeft" : cx === cx1 ? "grassHalfRight" : "grassHalfMid";
            terrain.push({ cx, cy, name });
        }
    };
    addOneWay(31, 35, GROUND_TOP - 3); // over the first pit — an upper route
    for (let i = 0; i < 5; i++) coins.push({ cx: 31 + i, cy: GROUND_TOP - 4 });
    addOneWay(84, 88, GROUND_TOP - 4); // after the piranha pipe
    for (let i = 0; i < 5; i++) coins.push({ cx: 84 + i, cy: GROUND_TOP - 5 });

    // ── Moving platforms (kinematic; carry the player) ────────────────────────
    // Horizontal ferry across the second pit (cols 57-59).
    movers.push({ cx: 56, cy: GROUND_TOP - 1, w: 3, axis: "x", range: 4, speed: 2.4 });
    // Vertical elevator up to a high coin stash past the third pit.
    movers.push({ cx: 92, cy: GROUND_TOP - 1, w: 3, axis: "y", range: 5, speed: 2.2 });
    for (let i = 0; i < 3; i++) coins.push({ cx: 92 + i, cy: GROUND_TOP - 7 });

    return { cols: COLS, rows: ROWS, solid, oneway, terrain, blocks, coins, enemies, hazards, lava, torches, movers, playerSpawn, flag, deathRow: ROWS + 1, pipes };
}

/** Pick a grass/dirt ground-sheet frame for a solid ground cell based on neighbours. */
function groundFrame(cx: number, cy: number, isGround: (x: number, y: number) => boolean): string {
    const surface = !isGround(cx, cy - 1);
    if (surface) {
        const openLeft = !isGround(cx - 1, cy);
        const openRight = !isGround(cx + 1, cy);
        if (openLeft && !openRight) return "grassLeft";
        if (openRight && !openLeft) return "grassRight";
        return "grassMid";
    }
    return "dirtCenter";
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
