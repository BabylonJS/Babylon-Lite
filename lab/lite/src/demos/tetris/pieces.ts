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

/**
 * Display RGB colours, one per piece — set to each Cube Pet's body colour so
 * the HUD next-piece preview and line-clear particle bursts match the animal
 * that renders for that piece. Piece order I,O,T,S,Z,J,L maps to
 * pig, panda, bunny, crab, chick, cat, caterpillar.
 */
export const PIECE_COLORS: readonly [number, number, number][] = [
    [0.859, 0.490, 0.588], // I — pig (pink)
    [0.82, 0.82, 0.85], // O — panda (white/grey)
    [0.918, 0.569, 0.408], // T — bunny (tan)
    [0.753, 0.290, 0.275], // S — crab (red)
    [1.0, 0.788, 0.357], // Z — chick (yellow)
    [0.396, 0.396, 0.478], // J — cat (slate-blue)
    [0.306, 0.722, 0.510], // L — caterpillar (green)
];

/** Default spawn column inside the 10-wide playfield. */
export const SPAWN_COL = 3;
