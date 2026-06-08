/**
 * Runtime entity shapes for the platformer demo — the game's "data model".
 *
 * These are the per-entity state records the orchestrator ({@link ../game.ts})
 * pools and mutates each frame (player poses, enemies, the boss, pickups,
 * projectiles and particles). They're split out from `game.ts` so the data model
 * reads in one place, separate from the ~1.9k lines of update/render logic.
 *
 * Sprite slots are integer indices into a pooled `Sprite2DLayer`; entities keep a
 * stable slot for the level and hide with `visible:false` rather than being removed
 * (see the note atop `game.ts`).
 */

import { type Sprite2DLayer } from "babylon-lite";
import { type AABB } from "./physics.js";
import { type BlockKind } from "./level.js";

/** One recorded player pose sampled by the star afterimage trail. */
export interface TrailPose {
    x: number;
    y: number;
    w: number;
    h: number;
    frame: number;
    flip: boolean;
}

/** A bumpable block (brick or `?`-box) on the tiles layer. */
export interface BlockState {
    cx: number;
    cy: number;
    kind: BlockKind;
    used: boolean;
    broken: boolean;
    slot: number;
    /** Vertical bump offset (px) when hit from below; animates back to 0. */
    bump: number;
}

/** A walking / flying / pipe enemy. `kind` selects the AI branch + frames. */
export interface EnemyState {
    kind: "slime" | "snail" | "fly" | "piranha";
    box: AABB;
    vx: number;
    vy: number;
    dir: -1 | 1;
    alive: boolean;
    /** snail-only: stomped into a shell. */
    shell: boolean;
    /** shell sliding speed sign, or 0 if idle. */
    shellDir: -1 | 0 | 1;
    /** Seconds left of "just-kicked" immunity (a kicked shell passes through harmlessly). */
    kickGrace: number;
    dying: number; // >0 = death animation countdown
    slot: number;
    /** The layer this enemy's sprite lives on. Piranhas use a layer BEHIND the pipes so
     *  they emerge from / retract into the pipe mouth; all others use the front enemy layer. */
    layer: Sprite2DLayer;
    animT: number;
    /** fly: vertical bob centre (world px). piranha: pipe-mouth top Y (world px). */
    homeY: number;
    /** fly: sine phase. piranha: emerge/retract cycle phase (seconds). */
    phase: number;
}

/** A kinematic moving platform that ping-pongs along one axis and carries the rider. */
export interface MovingPlatform {
    box: AABB;
    axis: "x" | "y";
    /** Travel bounds along the axis (world px). */
    min: number;
    max: number;
    /** Speed in world px/sec, and the current travel direction. */
    speed: number;
    dir: 1 | -1;
    /** This frame's movement delta (used to carry the rider). */
    dx: number;
    dy: number;
    /** Sprite slots, one per platform tile (left → right). */
    slots: number[];
}

/** The castle boss: a big spider that paces, lobs projectiles, and takes 3 hits. */
export interface BossState {
    active: boolean;
    box: AABB;
    hp: number;
    dir: -1 | 1;
    vy: number;
    /** Counts down after a hit: invulnerable + flashing while > 0. */
    hurt: number;
    /** Death animation countdown (> 0 = dying), then defeated. */
    dying: number;
    /** Seconds until the next projectile lob. */
    attackT: number;
    animT: number;
    slot: number;
}

/** A boss projectile: an arcing additive orb that hurts the player on contact. */
export interface BossProjectile {
    box: AABB;
    vx: number;
    vy: number;
    active: boolean;
    slot: number;
}

/** A power-up / coin-pop drop. `kind` selects the behaviour + grant on pickup. */
export interface PickupState {
    kind: "coin-pop" | "mushroom" | "star" | "fire-flower";
    box: AABB;
    vx: number;
    vy: number;
    active: boolean;
    /** coin-pop only: lifetime countdown. */
    life: number;
    slot: number;
    /** The layer this pool entry's sprite lives on (atlas-specific). */
    layer: Sprite2DLayer;
    /** fire-flower only: seconds left of the box-emerge rise (0 = done / not emerging). */
    emergeT: number;
    /** fire-flower only: the box.y it settles at once fully emerged (sitting on the block). */
    emergeEndY: number;
    /** fire-flower only: its sprite slot on the behind-block emerge layer (-1 if unused). */
    emergeSlot: number;
}

/** A fire-power projectile: bounces along the ground, pops enemies, drawn additive. */
export interface Fireball {
    box: AABB;
    vx: number;
    vy: number;
    life: number;
    active: boolean;
    slot: number;
}

/** An additive sparkle particle for coin/stomp bursts. */
export interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    active: boolean;
    slot: number;
    color: readonly [number, number, number];
}

/** A floating score popup (e.g. "100") rendered from HUD digit sprites. */
export interface Popup {
    x: number;
    y: number;
    life: number;
    active: boolean;
    /** Digit frame indices (left to right) for the value's text. */
    digits: number[];
    /** This popup's digit sprite slots on the digit layer (fixed run). */
    slots: number[];
}

/** A spinning brick chunk thrown out when a brick is smashed. */
export interface Debris {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    spin: number;
    life: number;
    active: boolean;
    slot: number;
}

/** The top-level game state machine phase (attract screen → play → finale). */
export type Phase = "title" | "ready" | "playing" | "warping" | "dying" | "complete" | "won" | "gameover";
