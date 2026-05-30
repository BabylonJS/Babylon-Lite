// Clean-room DOOM thing/mobj catalog for the demo.
//
// Maps THING "doomednum" values to an internal mobj kind plus the gameplay and
// appearance attributes the demo needs. Every value here is reproduced from
// public Doom documentation (Doom Wiki, Unofficial Doom Specs) and authored as
// original TypeScript; no GPL Doom source (mobjinfo[]/states[]) is copied.
//
// Sprite/frame: the 4-char sprite lump name and the initial frame letter index
// (A=0). Monsters animate via the state machine (states.ts); decorations and
// pickups mostly sit on their spawn frame.

export const enum MF {
    SOLID = 1 << 0,
    SHOOTABLE = 1 << 1,
    NOSECTOR = 1 << 2,
    COUNTKILL = 1 << 3,
    SPECIAL = 1 << 4, // touch = pickup
    MISSILE = 1 << 5,
    DROPOFF = 1 << 6,
    NOBLOCKMAP = 1 << 7,
    NOGRAVITY = 1 << 8,
    FLOAT = 1 << 9,
    COUNTITEM = 1 << 10,
}

export const enum Pickup {
    NONE = 0,
    HEALTH_BONUS, // +1 health, up to 200
    STIMPACK, // +10
    MEDIKIT, // +25
    SOULSPHERE, // +100, up to 200
    ARMOR_BONUS, // +1 armor, up to 200
    GREEN_ARMOR, // 100 armor
    BLUE_ARMOR, // 200 armor
    CLIP, // +10 bullets
    AMMO_BOX, // +50 bullets
    SHELLS, // +4 shells
    SHELL_BOX, // +20 shells
    ROCKET, // +1 rocket
    ROCKET_BOX, // +5 rockets
    CELL, // +20 cells
    CELL_PACK, // +100 cells
    BACKPACK, // +ammo and capacity
    WEAPON_SHOTGUN,
    WEAPON_CHAINGUN,
    WEAPON_CHAINSAW,
    WEAPON_ROCKET,
    WEAPON_PLASMA,
    WEAPON_BFG,
    KEY_BLUE,
    KEY_YELLOW,
    KEY_RED,
    KEY_BLUE_SKULL,
    KEY_YELLOW_SKULL,
    KEY_RED_SKULL,
}

export interface MobjInfo {
    /** Internal name (also used to look up states). */
    id: string;
    /** THING doomednum, or -1 for spawn-only actors (projectiles, puffs, blood). */
    doomednum: number;
    sprite: string;
    spawnFrame: number;
    fullbright: boolean;
    radius: number;
    height: number;
    health: number;
    speed: number;
    painChance: number;
    flags: number;
    pickup: Pickup;
    /** Optional message shown when picked up. */
    pickupMsg?: string;
    seeSound?: string;
    attackSound?: string;
    painSound?: string;
    deathSound?: string;
    activeSound?: string;
}

const MONSTER = MF.SOLID | MF.SHOOTABLE | MF.COUNTKILL;

function mob(p: Partial<MobjInfo> & { id: string; doomednum: number; sprite: string }): MobjInfo {
    return {
        spawnFrame: 0,
        fullbright: false,
        radius: 20,
        height: 56,
        health: 1000,
        speed: 0,
        painChance: 0,
        flags: 0,
        pickup: Pickup.NONE,
        ...p,
    };
}

// Ordered loosely by category. Only a faithful subset needed for a playable E1M1.
export const MOBJ_LIST: MobjInfo[] = [
    // ── Player + logic things (invisible) ───────────────────────────────
    mob({ id: "PLAYER", doomednum: 1, sprite: "PLAY", radius: 16, height: 56, health: 100, flags: MF.SOLID | MF.SHOOTABLE | MF.DROPOFF }),
    mob({ id: "TELEPORT_DEST", doomednum: 14, sprite: "----", flags: MF.NOSECTOR | MF.NOBLOCKMAP }),

    // ── Monsters ────────────────────────────────────────────────────────
    mob({ id: "ZOMBIEMAN", doomednum: 3004, sprite: "POSS", health: 20, speed: 8, painChance: 200, radius: 20, height: 56, flags: MONSTER, seeSound: "POSIT1", attackSound: "PISTOL", painSound: "POPAIN", deathSound: "PODTH1", activeSound: "POSACT" }),
    mob({ id: "SHOTGUNGUY", doomednum: 9, sprite: "SPOS", health: 30, speed: 8, painChance: 170, radius: 20, height: 56, flags: MONSTER, seeSound: "POSIT2", painSound: "POPAIN", deathSound: "PODTH2", activeSound: "POSACT" }),
    mob({ id: "IMP", doomednum: 3001, sprite: "TROO", health: 60, speed: 8, painChance: 200, radius: 20, height: 56, flags: MONSTER, seeSound: "BGSIT1", attackSound: "CLAW", painSound: "POPAIN", deathSound: "BGDTH1", activeSound: "BGACT" }),
    mob({ id: "DEMON", doomednum: 3002, sprite: "SARG", health: 150, speed: 10, painChance: 180, radius: 30, height: 56, flags: MONSTER, seeSound: "SGTSIT", attackSound: "SGTATK", painSound: "DMPAIN", deathSound: "SGTDTH", activeSound: "DMACT" }),
    mob({ id: "SPECTRE", doomednum: 58, sprite: "SARG", health: 150, speed: 10, painChance: 180, radius: 30, height: 56, flags: MONSTER, seeSound: "SGTSIT", painSound: "DMPAIN", deathSound: "SGTDTH", activeSound: "DMACT" }),
    mob({ id: "CACODEMON", doomednum: 3005, sprite: "HEAD", health: 400, speed: 8, painChance: 128, radius: 31, height: 56, flags: MONSTER | MF.FLOAT | MF.NOGRAVITY, seeSound: "CACSIT", painSound: "DMPAIN", deathSound: "CACDTH", activeSound: "DMACT" }),
    mob({ id: "BARON", doomednum: 3003, sprite: "BOSS", health: 1000, speed: 8, painChance: 50, radius: 24, height: 64, flags: MONSTER, seeSound: "BRSSIT", painSound: "DMPAIN", deathSound: "BRSDTH", activeSound: "DMACT" }),
    mob({ id: "LOSTSOUL", doomednum: 3006, sprite: "SKUL", health: 100, speed: 8, painChance: 256, radius: 16, height: 56, fullbright: true, flags: MF.SOLID | MF.SHOOTABLE | MF.FLOAT | MF.NOGRAVITY, painSound: "DMPAIN", deathSound: "FIRXPL", activeSound: "DMACT" }),

    // ── Projectiles / spawn-only actors ─────────────────────────────────
    mob({ id: "IMPBALL", doomednum: -1, sprite: "BAL1", fullbright: true, radius: 6, height: 8, health: 1000, speed: 10, flags: MF.MISSILE | MF.NOGRAVITY | MF.DROPOFF, deathSound: "FIRXPL" }),
    mob({ id: "CACOBALL", doomednum: -1, sprite: "BAL2", fullbright: true, radius: 6, height: 8, health: 1000, speed: 10, flags: MF.MISSILE | MF.NOGRAVITY | MF.DROPOFF, deathSound: "FIRXPL" }),
    mob({ id: "BARONBALL", doomednum: -1, sprite: "BAL7", fullbright: true, radius: 6, height: 8, health: 1000, speed: 15, flags: MF.MISSILE | MF.NOGRAVITY | MF.DROPOFF, deathSound: "FIRXPL" }),
    mob({ id: "PUFF", doomednum: -1, sprite: "PUFF", spawnFrame: 0, fullbright: true, radius: 0, height: 0, flags: MF.NOBLOCKMAP | MF.NOGRAVITY }),
    mob({ id: "BLOOD", doomednum: -1, sprite: "BLUD", radius: 0, height: 0, flags: MF.NOBLOCKMAP | MF.NOGRAVITY }),

    // ── Pickups: health & armor ─────────────────────────────────────────
    mob({ id: "HEALTHBONUS", doomednum: 2014, sprite: "BON1", flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.HEALTH_BONUS, pickupMsg: "Picked up a health bonus." }),
    mob({ id: "ARMORBONUS", doomednum: 2015, sprite: "BON2", flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.ARMOR_BONUS, pickupMsg: "Picked up an armor bonus." }),
    mob({ id: "STIMPACK", doomednum: 2011, sprite: "STIM", flags: MF.SPECIAL, pickup: Pickup.STIMPACK, pickupMsg: "Picked up a stimpack." }),
    mob({ id: "MEDIKIT", doomednum: 2012, sprite: "MEDI", flags: MF.SPECIAL, pickup: Pickup.MEDIKIT, pickupMsg: "Picked up a medikit." }),
    mob({ id: "SOULSPHERE", doomednum: 2013, sprite: "SOUL", fullbright: true, flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.SOULSPHERE, pickupMsg: "Supercharge!" }),
    mob({ id: "GREENARMOR", doomednum: 2018, sprite: "ARM1", flags: MF.SPECIAL, pickup: Pickup.GREEN_ARMOR, pickupMsg: "Picked up the armor." }),
    mob({ id: "BLUEARMOR", doomednum: 2019, sprite: "ARM2", flags: MF.SPECIAL, pickup: Pickup.BLUE_ARMOR, pickupMsg: "Picked up the MegaArmor!" }),

    // ── Pickups: ammo ───────────────────────────────────────────────────
    mob({ id: "CLIP", doomednum: 2007, sprite: "CLIP", flags: MF.SPECIAL, pickup: Pickup.CLIP, pickupMsg: "Picked up a clip." }),
    mob({ id: "AMMOBOX", doomednum: 2048, sprite: "AMMO", flags: MF.SPECIAL, pickup: Pickup.AMMO_BOX, pickupMsg: "Picked up a box of bullets." }),
    mob({ id: "SHELLS", doomednum: 2008, sprite: "SHEL", flags: MF.SPECIAL, pickup: Pickup.SHELLS, pickupMsg: "Picked up 4 shotgun shells." }),
    mob({ id: "SHELLBOX", doomednum: 2049, sprite: "SBOX", flags: MF.SPECIAL, pickup: Pickup.SHELL_BOX, pickupMsg: "Picked up a box of shells." }),
    mob({ id: "ROCKET", doomednum: 2010, sprite: "ROCK", flags: MF.SPECIAL, pickup: Pickup.ROCKET, pickupMsg: "Picked up a rocket." }),
    mob({ id: "ROCKETBOX", doomednum: 2046, sprite: "BROK", flags: MF.SPECIAL, pickup: Pickup.ROCKET_BOX, pickupMsg: "Picked up a box of rockets." }),
    mob({ id: "CELL", doomednum: 2047, sprite: "CELL", flags: MF.SPECIAL, pickup: Pickup.CELL, pickupMsg: "Picked up an energy cell." }),
    mob({ id: "CELLPACK", doomednum: 17, sprite: "CELP", flags: MF.SPECIAL, pickup: Pickup.CELL_PACK, pickupMsg: "Picked up an energy cell pack." }),
    mob({ id: "BACKPACK", doomednum: 8, sprite: "BPAK", flags: MF.SPECIAL, pickup: Pickup.BACKPACK, pickupMsg: "Picked up a backpack full of ammo!" }),

    // ── Pickups: weapons ────────────────────────────────────────────────
    mob({ id: "SHOTGUN", doomednum: 2001, sprite: "SHOT", flags: MF.SPECIAL, pickup: Pickup.WEAPON_SHOTGUN, pickupMsg: "You got the shotgun!" }),
    mob({ id: "CHAINGUN", doomednum: 2002, sprite: "MGUN", flags: MF.SPECIAL, pickup: Pickup.WEAPON_CHAINGUN, pickupMsg: "You got the chaingun!" }),
    mob({ id: "ROCKETLAUNCHER", doomednum: 2003, sprite: "LAUN", flags: MF.SPECIAL, pickup: Pickup.WEAPON_ROCKET, pickupMsg: "You got the rocket launcher!" }),
    mob({ id: "PLASMA", doomednum: 2004, sprite: "PLAS", flags: MF.SPECIAL, pickup: Pickup.WEAPON_PLASMA, pickupMsg: "You got the plasma gun!" }),
    mob({ id: "CHAINSAW", doomednum: 2005, sprite: "CSAW", flags: MF.SPECIAL, pickup: Pickup.WEAPON_CHAINSAW, pickupMsg: "A chainsaw!" }),
    mob({ id: "BFG", doomednum: 2006, sprite: "BFUG", flags: MF.SPECIAL, pickup: Pickup.WEAPON_BFG, pickupMsg: "You got the BFG9000!" }),

    // ── Keys ────────────────────────────────────────────────────────────
    mob({ id: "BLUECARD", doomednum: 5, sprite: "BKEY", flags: MF.SPECIAL, pickup: Pickup.KEY_BLUE, pickupMsg: "Picked up a blue keycard." }),
    mob({ id: "YELLOWCARD", doomednum: 6, sprite: "YKEY", flags: MF.SPECIAL, pickup: Pickup.KEY_YELLOW, pickupMsg: "Picked up a yellow keycard." }),
    mob({ id: "REDCARD", doomednum: 13, sprite: "RKEY", flags: MF.SPECIAL, pickup: Pickup.KEY_RED, pickupMsg: "Picked up a red keycard." }),
    mob({ id: "BLUESKULL", doomednum: 40, sprite: "BSKU", flags: MF.SPECIAL, pickup: Pickup.KEY_BLUE_SKULL, pickupMsg: "Picked up a blue skull key." }),
    mob({ id: "YELLOWSKULL", doomednum: 39, sprite: "YSKU", flags: MF.SPECIAL, pickup: Pickup.KEY_YELLOW_SKULL, pickupMsg: "Picked up a yellow skull key." }),
    mob({ id: "REDSKULL", doomednum: 38, sprite: "RSKU", flags: MF.SPECIAL, pickup: Pickup.KEY_RED_SKULL, pickupMsg: "Picked up a red skull key." }),

    // ── Powerups ────────────────────────────────────────────────────────
    mob({ id: "BERSERK", doomednum: 2023, sprite: "PSTR", flags: MF.SPECIAL, pickup: Pickup.NONE, pickupMsg: "Berserk!" }),
    mob({ id: "INVULN", doomednum: 2022, sprite: "PINV", fullbright: true, flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.NONE }),
    mob({ id: "INVIS", doomednum: 2024, sprite: "PINS", flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.NONE }),
    mob({ id: "RADSUIT", doomednum: 2025, sprite: "SUIT", flags: MF.SPECIAL, pickup: Pickup.NONE }),
    mob({ id: "MAP", doomednum: 2026, sprite: "PMAP", fullbright: true, flags: MF.SPECIAL | MF.COUNTITEM, pickup: Pickup.NONE }),
    mob({ id: "LITEAMP", doomednum: 2045, sprite: "PVIS", fullbright: true, flags: MF.SPECIAL, pickup: Pickup.NONE }),

    // ── Obstacles / decorations (solid where appropriate) ───────────────
    mob({ id: "BARREL", doomednum: 2035, sprite: "BAR1", health: 20, radius: 10, height: 42, flags: MF.SOLID | MF.SHOOTABLE }),
    mob({ id: "TECHLAMP", doomednum: 85, sprite: "TLMP", fullbright: true, radius: 16, height: 80, flags: MF.SOLID }),
    mob({ id: "TECHLAMP2", doomednum: 86, sprite: "TLP2", fullbright: true, radius: 16, height: 60, flags: MF.SOLID }),
    mob({ id: "COLUMN", doomednum: 2028, sprite: "COLU", fullbright: true, radius: 16, height: 48, flags: MF.SOLID }),
    mob({ id: "TALLGREENCOL", doomednum: 30, sprite: "COL1", radius: 16, height: 52, flags: MF.SOLID }),
    mob({ id: "SHORTGREENCOL", doomednum: 31, sprite: "COL2", radius: 16, height: 40, flags: MF.SOLID }),
    mob({ id: "TALLREDCOL", doomednum: 32, sprite: "COL3", radius: 16, height: 52, flags: MF.SOLID }),
    mob({ id: "SHORTREDCOL", doomednum: 33, sprite: "COL4", radius: 16, height: 40, flags: MF.SOLID }),
    mob({ id: "CANDLE", doomednum: 34, sprite: "CAND", fullbright: true, radius: 0, height: 0, flags: 0 }),
    mob({ id: "CANDELABRA", doomednum: 35, sprite: "CBRA", fullbright: true, radius: 16, height: 60, flags: MF.SOLID }),
    mob({ id: "EYEINSYMBOL", doomednum: 41, sprite: "CEYE", fullbright: true, radius: 16, height: 56, flags: MF.SOLID }),
    mob({ id: "GREYTREE", doomednum: 43, sprite: "TRE1", radius: 16, height: 80, flags: MF.SOLID }),
    mob({ id: "BIGTREE", doomednum: 54, sprite: "TRE2", radius: 32, height: 108, flags: MF.SOLID }),
    mob({ id: "BLUETORCH", doomednum: 44, sprite: "TBLU", fullbright: true, radius: 16, height: 68, flags: MF.SOLID }),
    mob({ id: "GREENTORCH", doomednum: 45, sprite: "TGRN", fullbright: true, radius: 16, height: 68, flags: MF.SOLID }),
    mob({ id: "REDTORCH", doomednum: 46, sprite: "TRED", fullbright: true, radius: 16, height: 68, flags: MF.SOLID }),
    mob({ id: "SHORTBLUETORCH", doomednum: 55, sprite: "SMBT", fullbright: true, radius: 16, height: 37, flags: MF.SOLID }),
    mob({ id: "SHORTGREENTORCH", doomednum: 56, sprite: "SMGT", fullbright: true, radius: 16, height: 37, flags: MF.SOLID }),
    mob({ id: "SHORTREDTORCH", doomednum: 57, sprite: "SMRT", fullbright: true, radius: 16, height: 37, flags: MF.SOLID }),
    mob({ id: "GIBBEDPLAYER", doomednum: 10, sprite: "PLAY", spawnFrame: 22, flags: 0 }),
    mob({ id: "DEADPLAYER", doomednum: 15, sprite: "PLAY", spawnFrame: 13, flags: 0 }),
    mob({ id: "DEADZOMBIE", doomednum: 18, sprite: "POSS", spawnFrame: 11, flags: 0 }),
    mob({ id: "DEADIMP", doomednum: 20, sprite: "TROO", spawnFrame: 16, flags: 0 }),
    mob({ id: "DEADDEMON", doomednum: 21, sprite: "SARG", spawnFrame: 13, flags: 0 }),
    mob({ id: "GUTS", doomednum: 24, sprite: "POL5", flags: 0 }),
    mob({ id: "HANGING1", doomednum: 49, sprite: "GOR1", radius: 16, height: 68, flags: MF.SOLID }),
    mob({ id: "IMPALEDBODY", doomednum: 25, sprite: "POL1", radius: 16, height: 80, flags: MF.SOLID }),
    mob({ id: "SKULLPILE", doomednum: 28, sprite: "POL2", radius: 16, height: 80, flags: MF.SOLID }),
];

const BY_DOOMEDNUM = new Map<number, MobjInfo>();
const BY_ID = new Map<string, MobjInfo>();
for (const m of MOBJ_LIST) {
    if (m.doomednum >= 0) BY_DOOMEDNUM.set(m.doomednum, m);
    BY_ID.set(m.id, m);
}

export function infoForDoomednum(num: number): MobjInfo | undefined {
    return BY_DOOMEDNUM.get(num);
}

export function infoById(id: string): MobjInfo | undefined {
    return BY_ID.get(id);
}

/** All unique sprite names referenced, for atlas pre-decode. */
export function allSpriteNames(): Set<string> {
    const set = new Set<string>();
    for (const m of MOBJ_LIST) {
        if (m.sprite && m.sprite !== "----") set.add(m.sprite);
    }
    return set;
}
