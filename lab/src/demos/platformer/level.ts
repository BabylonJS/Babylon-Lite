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
 * One cohesive CC0 art style throughout (Kenney "Platformer Pack Remastered").
 */

export type BlockKind = "brick" | "coin-block" | "mushroom-block" | "star-block";
export type EnemyKind = "slime" | "snail";

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

export interface Level {
    cols: number;
    rows: number;
    solid: Uint8Array;
    terrain: TerrainTile[];
    blocks: BlockSpawn[];
    coins: Cell[];
    enemies: EnemySpawn[];
    hazards: Cell[];
    playerSpawn: Cell;
    flag: Cell;
    /** World tile column where falling below the map kills the player. */
    deathRow: number;
}

const COLS = 124;
const ROWS = 14;
/** y of the top ground surface row. */
const GROUND_TOP = 12;

type Glyph = " " | "#" | "=" | "B" | "?" | "M" | "S" | "o" | "g" | "n" | "^" | "F" | "p";

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
    for (let c = 0; c < COLS; c++) {
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
    const terrain: TerrainTile[] = [];
    const blocks: BlockSpawn[] = [];
    const coins: Cell[] = [];
    const enemies: EnemySpawn[] = [];
    const hazards: Cell[] = [];
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

    return { cols: COLS, rows: ROWS, solid, terrain, blocks, coins, enemies, hazards, playerSpawn, flag, deathRow: ROWS + 1 };
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
