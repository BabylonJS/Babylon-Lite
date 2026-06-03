/**
 * Tetromino shape definitions and palette.
 *
 * Each piece has 4 rotation states stored as relative cell offsets [col, row]
 * inside a bounding box (I uses 4x4, O 2x2, others 3x3). Rotation index is
 * 0..3 (CW from spawn). The arrays are intentionally explicit (rather than
 * computed via SRS rotation math) so the demo stays small, dependency-free
 * and easy to audit.
 *
 * Colors match the classic Tetris palette.
 */

export type PieceType = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type Cell = readonly [number, number];

export const PIECE_COUNT = 7;

/** I, O, T, S, Z, J, L */
export const PIECE_ROTATIONS: readonly (readonly Cell[])[][] = [
    // I
    [
        [
            [0, 1],
            [1, 1],
            [2, 1],
            [3, 1],
        ],
        [
            [2, 0],
            [2, 1],
            [2, 2],
            [2, 3],
        ],
        [
            [0, 2],
            [1, 2],
            [2, 2],
            [3, 2],
        ],
        [
            [1, 0],
            [1, 1],
            [1, 2],
            [1, 3],
        ],
    ],
    // O (same for every rotation)
    [
        [
            [1, 0],
            [2, 0],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [2, 0],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [2, 0],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [2, 0],
            [1, 1],
            [2, 1],
        ],
    ],
    // T
    [
        [
            [1, 0],
            [0, 1],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [1, 1],
            [2, 1],
            [1, 2],
        ],
        [
            [0, 1],
            [1, 1],
            [2, 1],
            [1, 2],
        ],
        [
            [1, 0],
            [0, 1],
            [1, 1],
            [1, 2],
        ],
    ],
    // S
    [
        [
            [1, 0],
            [2, 0],
            [0, 1],
            [1, 1],
        ],
        [
            [1, 0],
            [1, 1],
            [2, 1],
            [2, 2],
        ],
        [
            [1, 1],
            [2, 1],
            [0, 2],
            [1, 2],
        ],
        [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 2],
        ],
    ],
    // Z
    [
        [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 1],
        ],
        [
            [2, 0],
            [1, 1],
            [2, 1],
            [1, 2],
        ],
        [
            [0, 1],
            [1, 1],
            [1, 2],
            [2, 2],
        ],
        [
            [1, 0],
            [0, 1],
            [1, 1],
            [0, 2],
        ],
    ],
    // J
    [
        [
            [0, 0],
            [0, 1],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [2, 0],
            [1, 1],
            [1, 2],
        ],
        [
            [0, 1],
            [1, 1],
            [2, 1],
            [2, 2],
        ],
        [
            [1, 0],
            [1, 1],
            [0, 2],
            [1, 2],
        ],
    ],
    // L
    [
        [
            [2, 0],
            [0, 1],
            [1, 1],
            [2, 1],
        ],
        [
            [1, 0],
            [1, 1],
            [1, 2],
            [2, 2],
        ],
        [
            [0, 1],
            [1, 1],
            [2, 1],
            [0, 2],
        ],
        [
            [0, 0],
            [1, 0],
            [1, 1],
            [1, 2],
        ],
    ],
];

/** Linear RGB diffuse colors, one per piece. */
export const PIECE_COLORS: readonly [number, number, number][] = [
    [0.15, 0.85, 0.95], // I — cyan
    [0.95, 0.85, 0.15], // O — yellow
    [0.7, 0.2, 0.85], // T — purple
    [0.2, 0.85, 0.25], // S — green
    [0.95, 0.2, 0.2], // Z — red
    [0.2, 0.35, 0.95], // J — blue
    [0.95, 0.55, 0.15], // L — orange
];

/** Default spawn column inside the 10-wide playfield. */
export const SPAWN_COL = 3;
