/**
 * Tetris game state and rules.
 *
 * Holds the playfield, the active piece, the next/hold queues, gravity timer,
 * scoring, level progression and game-over state. Pure data + plain functions —
 * no DOM, no rendering, no Babylon Lite dependency.
 *
 * Coordinate system:
 *   col: 0..9 left → right
 *   row: 0..19 top → bottom (gravity increases row)
 *
 * The renderer is responsible for mapping (col, row) into world space.
 */

import { PIECE_COLORS, PIECE_ROTATIONS, SPAWN_COL, type Cell, type PieceType } from "./pieces.js";

export const BOARD_COLS = 10;
export const BOARD_ROWS = 20;

/** 0 = empty, 1..7 = locked block of that piece color. */
export type Cellv = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Outcome sounds emitted by the rules layer, drained + played by the wiring
 *  layer each frame. Kept here (not in sound.ts) so the game logic stays free
 *  of any audio dependency — the audio module imports this type, never the
 *  reverse. */
export type GameSound = "lock" | "clear" | "tetris" | "levelUp" | "gameOver";

export interface ActivePiece {
    type: PieceType;
    rotation: 0 | 1 | 2 | 3;
    col: number;
    row: number;
}

export interface GameState {
    board: Cellv[];
    active: ActivePiece | null;
    next: PieceType;
    bag: PieceType[];
    score: number;
    lines: number;
    level: number;
    over: boolean;
    paused: boolean;
    /** ms since last gravity step. */
    gravityAcc: number;
    /** Last line-clear count (for HUD flashes). */
    lastClear: number;
    /** Monotonic version, bumped on any visible state change. */
    version: number;
    /** Rows cleared since the renderer last drained, with their pre-shift colors.
     *  Each entry: { row, colors[BOARD_COLS] } where colors[c] is 1..7. The
     *  renderer drains this queue each frame to spawn particle bursts and
     *  trigger camera shake. */
    pendingClears: Array<{ row: number; colors: Cellv[] }>;
    /** Outcome sounds queued since the wiring layer last drained them. Mirrors
     *  the `pendingClears` pattern: the rules push event tags here, the wiring
     *  layer (tetris.ts) drains + plays them once per frame. */
    pendingSounds: GameSound[];
}

export function createGame(): GameState {
    const state: GameState = {
        board: new Array<Cellv>(BOARD_COLS * BOARD_ROWS).fill(0),
        active: null,
        next: 0,
        bag: [],
        score: 0,
        lines: 0,
        level: 1,
        over: false,
        paused: false,
        gravityAcc: 0,
        lastClear: 0,
        version: 0,
        pendingClears: [],
        pendingSounds: [],
    };
    state.next = drawFromBag(state);
    spawnNext(state);
    return state;
}

export function restartGame(g: GameState): void {
    g.board.fill(0);
    g.active = null;
    g.bag.length = 0;
    g.score = 0;
    g.lines = 0;
    g.level = 1;
    g.over = false;
    g.paused = false;
    g.gravityAcc = 0;
    g.lastClear = 0;
    g.pendingClears.length = 0;
    g.pendingSounds.length = 0;
    g.next = drawFromBag(g);
    spawnNext(g);
    g.version++;
}

/** Standard 7-bag randomizer — every 7 spawns contains one of each piece. */
function drawFromBag(g: GameState): PieceType {
    if (g.bag.length === 0) {
        const bag: PieceType[] = [0, 1, 2, 3, 4, 5, 6];
        for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [bag[i], bag[j]] = [bag[j]!, bag[i]!];
        }
        g.bag = bag;
    }
    return g.bag.pop()!;
}

function spawnNext(g: GameState): void {
    const type = g.next;
    g.next = drawFromBag(g);
    const piece: ActivePiece = { type, rotation: 0, col: SPAWN_COL, row: 0 };
    if (collides(g, piece)) {
        g.active = null;
        g.over = true;
        g.pendingSounds.push("gameOver");
        g.version++;
        return;
    }
    g.active = piece;
}

function cellsOf(p: ActivePiece): readonly Cell[] {
    return PIECE_ROTATIONS[p.type]![p.rotation]!;
}

function collides(g: GameState, p: ActivePiece): boolean {
    for (const [dx, dy] of cellsOf(p)) {
        const x = p.col + dx;
        const y = p.row + dy;
        if (x < 0 || x >= BOARD_COLS || y >= BOARD_ROWS) {
            return true;
        }
        if (y < 0) {
            continue;
        }
        if (g.board[y * BOARD_COLS + x] !== 0) {
            return true;
        }
    }
    return false;
}

function tryMove(g: GameState, dCol: number, dRow: number, dRot: number): boolean {
    if (!g.active) {
        return false;
    }
    const moved: ActivePiece = {
        type: g.active.type,
        rotation: ((g.active.rotation + dRot + 4) % 4) as 0 | 1 | 2 | 3,
        col: g.active.col + dCol,
        row: g.active.row + dRow,
    };
    if (collides(g, moved)) {
        return false;
    }
    g.active = moved;
    g.version++;
    return true;
}

export function moveLeft(g: GameState): boolean {
    if (g.over || g.paused) {
        return false;
    }
    return tryMove(g, -1, 0, 0);
}

export function moveRight(g: GameState): boolean {
    if (g.over || g.paused) {
        return false;
    }
    return tryMove(g, 1, 0, 0);
}

export function rotateCW(g: GameState): boolean {
    if (g.over || g.paused || !g.active) {
        return false;
    }
    // Simple wall-kicks: try base, ±1, ±2 (helps I-piece near walls).
    for (const dx of [0, -1, 1, -2, 2]) {
        if (tryMove(g, dx, 0, 1)) {
            return true;
        }
    }
    return false;
}

export function rotateCCW(g: GameState): boolean {
    if (g.over || g.paused || !g.active) {
        return false;
    }
    for (const dx of [0, -1, 1, -2, 2]) {
        if (tryMove(g, dx, 0, -1)) {
            return true;
        }
    }
    return false;
}

/** Move down one row. Returns true if moved; false if it locked. */
export function softDrop(g: GameState): boolean {
    if (g.over || g.paused || !g.active) {
        return false;
    }
    if (tryMove(g, 0, 1, 0)) {
        g.score += 1;
        g.version++;
        return true;
    }
    lockActive(g);
    return false;
}

/** Drop until collision, lock immediately. Returns number of rows dropped. */
export function hardDrop(g: GameState): number {
    if (g.over || g.paused || !g.active) {
        return 0;
    }
    let dropped = 0;
    while (tryMove(g, 0, 1, 0)) {
        dropped++;
    }
    g.score += dropped * 2;
    lockActive(g);
    return dropped;
}

/** Compute the row where the active piece would land (ghost piece). */
export function ghostRow(g: GameState): number {
    if (!g.active) {
        return 0;
    }
    let row = g.active.row;
    while (true) {
        const next: ActivePiece = { ...g.active, row: row + 1 };
        if (collides(g, next)) {
            return row;
        }
        row++;
    }
}

function lockActive(g: GameState): void {
    if (!g.active) {
        return;
    }
    const p = g.active;
    const color = (p.type + 1) as Cellv;
    for (const [dx, dy] of cellsOf(p)) {
        const x = p.col + dx;
        const y = p.row + dy;
        if (y < 0) {
            g.over = true;
            g.active = null;
            g.pendingSounds.push("gameOver");
            g.version++;
            return;
        }
        g.board[y * BOARD_COLS + x] = color;
    }
    g.active = null;
    const cleared = clearFullLines(g);
    g.lastClear = cleared;
    g.lines += cleared;
    g.score += scoreFor(cleared, g.level);
    const prevLevel = g.level;
    g.level = 1 + Math.floor(g.lines / 10);
    // Exactly one outcome sound per lock: a Tetris (4), a line clear (1–3), or
    // a plain landing thud. A level-up chime stacks on top when the threshold
    // is crossed.
    if (cleared >= 4) {
        g.pendingSounds.push("tetris");
    } else if (cleared > 0) {
        g.pendingSounds.push("clear");
    } else {
        g.pendingSounds.push("lock");
    }
    if (g.level > prevLevel) {
        g.pendingSounds.push("levelUp");
    }
    spawnNext(g);
    g.version++;
}

function clearFullLines(g: GameState): number {
    let cleared = 0;
    for (let y = BOARD_ROWS - 1; y >= 0; y--) {
        let full = true;
        for (let x = 0; x < BOARD_COLS; x++) {
            if (g.board[y * BOARD_COLS + x] === 0) {
                full = false;
                break;
            }
        }
        if (full) {
            cleared++;
            // Snapshot the cells before the shift so particles can be coloured
            // with the original block colors of the row that just disappeared.
            const colors: Cellv[] = new Array(BOARD_COLS);
            for (let x = 0; x < BOARD_COLS; x++) {
                colors[x] = g.board[y * BOARD_COLS + x]!;
            }
            g.pendingClears.push({ row: y, colors });
            for (let yy = y; yy > 0; yy--) {
                for (let x = 0; x < BOARD_COLS; x++) {
                    g.board[yy * BOARD_COLS + x] = g.board[(yy - 1) * BOARD_COLS + x]!;
                }
            }
            for (let x = 0; x < BOARD_COLS; x++) {
                g.board[x] = 0;
            }
            y++; // re-check this row (now holds what was above)
        }
    }
    return cleared;
}

function scoreFor(lines: number, level: number): number {
    switch (lines) {
        case 1:
            return 100 * level;
        case 2:
            return 300 * level;
        case 3:
            return 500 * level;
        case 4:
            return 800 * level;
        default:
            return 0;
    }
}

/** Gravity interval in ms, scaled by level. ~1000ms at level 1, down to 80ms. */
function gravityMs(level: number): number {
    const base = 1000 * Math.pow(0.82, level - 1);
    return Math.max(80, base);
}

/** Advance the game by `dtMs`. The renderer should call this every frame. */
export function tickGame(g: GameState, dtMs: number): void {
    if (g.over || g.paused) {
        return;
    }
    g.gravityAcc += dtMs;
    const step = gravityMs(g.level);
    while (g.gravityAcc >= step) {
        g.gravityAcc -= step;
        if (!g.active) {
            break;
        }
        if (!tryMove(g, 0, 1, 0)) {
            lockActive(g);
        }
    }
}

export function togglePause(g: GameState): void {
    if (g.over) {
        return;
    }
    g.paused = !g.paused;
    g.version++;
}

export function pieceColor(type: PieceType): readonly [number, number, number] {
    return PIECE_COLORS[type]!;
}

/** Cells for next-piece preview, in their 4x4 grid form. */
export function previewCells(type: PieceType): readonly Cell[] {
    return PIECE_ROTATIONS[type]![0]!;
}
