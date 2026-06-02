// Runtime mobj (map object) instance shared by monsters, projectiles, pickups
// and decorations. Fields cover the needs of the full combat sim; early phases
// only populate a subset.

import type { MobjInfo } from "./info.js";

export interface Mobj {
    info: MobjInfo;
    /** Position: x/y are the Doom map plane, z is the bottom (feet) height. */
    x: number;
    y: number;
    z: number;
    /** Facing angle in radians. */
    angle: number;
    /** Velocity per tic. */
    momx: number;
    momy: number;
    momz: number;
    radius: number;
    height: number;
    health: number;
    flags: number;
    /** Current sprite lump name (state machine may override info.sprite). */
    sprite: string;
    /** Current sprite frame letter index (A=0). */
    frame: number;
    /** Whether the current frame renders full-bright. */
    fullbright: boolean;
    /** Current state id (index into STATES), or -1 when stateless (decoration). */
    stateId: number;
    /** Tics remaining in the current state (-1 = never advance). */
    tics: number;
    /** AI bookkeeping. */
    target: Mobj | null;
    moveDir: number;
    moveCount: number;
    reactionTime: number;
    threshold: number;
    /** Sector index the mobj currently stands in (for live light + floor). */
    sectorIndex: number;
    /** Marked for removal at end of tic. */
    removed: boolean;
}

/** Eight compass move directions plus "none", in Doom's order (E, NE, N, ...). */
export const enum Dir {
    EAST = 0,
    NORTHEAST,
    NORTH,
    NORTHWEST,
    WEST,
    SOUTHWEST,
    SOUTH,
    SOUTHEAST,
    NONE,
}

export const DIR_ANGLE: number[] = [
    0,
    Math.PI / 4,
    Math.PI / 2,
    (3 * Math.PI) / 4,
    Math.PI,
    (5 * Math.PI) / 4,
    (3 * Math.PI) / 2,
    (7 * Math.PI) / 4,
];
