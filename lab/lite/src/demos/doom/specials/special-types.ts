// Clean-room DOOM linedef-special table for the subset Freedoom E1M1 uses.
//
// Behaviour values (speeds, waits, target rules) are reproduced from publicly
// documented DOOM facts (Doom Wiki / Unofficial Doom Specs), written as original
// code. No GPL DOOM source is used or copied.

export type Trigger = "push" | "switch" | "walk" | "gun";

export type ActionKind = "doorOpenWaitClose" | "doorOpenStay" | "lift" | "floorLowerToLowest" | "exit";

export type KeyColor = "blue" | "yellow" | "red";

export interface SpecialDef {
    trigger: Trigger;
    repeatable: boolean;
    action: ActionKind;
    /** Manual (tag 0) specials act on the line's back sector; tagged ones act on
     *  every sector sharing the linedef tag. */
    manual: boolean;
    /** Door/floor/lift movement speed in map units per 35Hz tic. */
    speed: number;
    /** Wait time before auto-reversing (tics), for OWC doors and lifts. */
    wait: number;
    key?: KeyColor;
}

const DOOR_SPEED = 2;
const BLAZE_SPEED = 8;
const LIFT_SPEED = 4;
const FLOOR_SPEED = 2;
const DOOR_WAIT = 150;
const LIFT_WAIT = 105;

// Only the specials present in Freedoom E1M1 (plus their obvious cousins) are
// defined; unknown specials are simply inert in this demo.
export const SPECIALS: Record<number, SpecialDef> = {
    // Manual doors (push, tag 0, act on back sector).
    // Keyed doors (types 26/27/28) require a keycard in DOOM. This demo has no
    // key/inventory yet (combat phase), so they open unconditionally to keep the
    // level traversable; key gating will be added with the pickup system.
    1: { trigger: "push", repeatable: true, action: "doorOpenWaitClose", manual: true, speed: DOOR_SPEED, wait: DOOR_WAIT },
    26: { trigger: "push", repeatable: true, action: "doorOpenWaitClose", manual: true, speed: DOOR_SPEED, wait: DOOR_WAIT, key: "blue" },
    27: { trigger: "push", repeatable: true, action: "doorOpenWaitClose", manual: true, speed: DOOR_SPEED, wait: DOOR_WAIT, key: "yellow" },
    28: { trigger: "push", repeatable: true, action: "doorOpenWaitClose", manual: true, speed: DOOR_SPEED, wait: DOOR_WAIT, key: "red" },
    117: { trigger: "push", repeatable: true, action: "doorOpenWaitClose", manual: true, speed: BLAZE_SPEED, wait: DOOR_WAIT },

    // Tagged doors.
    2: { trigger: "walk", repeatable: false, action: "doorOpenStay", manual: false, speed: DOOR_SPEED, wait: 0 },
    29: { trigger: "switch", repeatable: false, action: "doorOpenWaitClose", manual: false, speed: DOOR_SPEED, wait: DOOR_WAIT },
    63: { trigger: "switch", repeatable: true, action: "doorOpenWaitClose", manual: false, speed: DOOR_SPEED, wait: DOOR_WAIT },

    // Lifts (lower, wait, raise).
    62: { trigger: "switch", repeatable: true, action: "lift", manual: false, speed: LIFT_SPEED, wait: LIFT_WAIT },
    88: { trigger: "walk", repeatable: true, action: "lift", manual: false, speed: LIFT_SPEED, wait: LIFT_WAIT },

    // Floors.
    23: { trigger: "switch", repeatable: false, action: "floorLowerToLowest", manual: false, speed: FLOOR_SPEED, wait: 0 },

    // Level exit.
    11: { trigger: "switch", repeatable: false, action: "exit", manual: false, speed: 0, wait: 0 },
};

export function getSpecial(type: number): SpecialDef | undefined {
    return SPECIALS[type];
}
