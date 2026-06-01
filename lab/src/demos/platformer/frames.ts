/**
 * Shared world constants and Kenney frame-name helpers for the platformer demo.
 *
 * The level is laid out on a uniform tile grid; `TILE` is the world-pixel size of
 * one cell. The art is the curated CC0 "Platformer Pack Remastered" subset under
 * `lab/public/platformer/`.
 */

/** World-pixel size of one tile cell. */
export const TILE = 70;

/** Gravity and movement tuning (world pixels, seconds). */
export const PHYS = {
    gravity: 2600,
    /** Reduced gravity while ascending and holding jump, for a variable-height hop. */
    jumpHoldGravity: 1300,
    walkAccel: 2600,
    runAccel: 3200,
    groundFriction: 2400,
    airAccel: 1600,
    maxWalk: 360,
    maxRun: 560,
    maxFall: 1200,
    jumpSpeed: 1020,
    /** Upward speed imparted by a successful enemy stomp. */
    stompBounce: 760,
    /** Coyote-time and input-buffer windows (seconds). */
    coyote: 0.09,
    jumpBuffer: 0.11,
    enemySpeed: 95,
    shellSpeed: 620,
} as const;

/** Which alien colour the player uses (all five colours share the same frame suffixes). */
export const PLAYER = "alienGreen";

/** Player animation frame names (suffix-only; the loader prepends nothing). */
export const PLAYER_FRAMES = {
    stand: `${PLAYER}_stand`,
    walk1: `${PLAYER}_walk1`,
    walk2: `${PLAYER}_walk2`,
    jump: `${PLAYER}_jump`,
    duck: `${PLAYER}_duck`,
    hit: `${PLAYER}_hit`,
    front: `${PLAYER}_front`,
} as const;
