// Weapon definitions for the LibreQuake E1M1 demo. Clean-room data tables only
// (factual Quake values: ammo use, pellet spread, fire rate, HUD slots) — no GPL
// code copied. The demo ships three working weapons: the starting Shotgun, the
// Super Shotgun and the Grenade Launcher, all of which spawn in lq_e1m1.

export type WeaponId = "shotgun" | "supershotgun" | "grenade";
export type AmmoType = "shells" | "rockets";

export interface WeaponDef {
    id: WeaponId;
    /** Inventory slot / number key (1-based): shotgun=1, supershotgun=2, grenade=3. */
    slot: number;
    name: string;
    ammo: AmmoType;
    ammoPerShot: number;
    /** Seconds between shots. */
    refire: number;
    /** True for projectile weapons (grenade launcher); false for hitscan. */
    projectile: boolean;
    // Hitscan parameters (ignored when projectile).
    pellets: number;
    spreadX: number;
    spreadY: number;
    dmgPerPellet: number;
    range: number;
    fireSound: string;
    /** First-person viewmodel: alias model + muzzle animation range. */
    viewModel: { file: string; fireFrames: number; fireFps: number };
    /** HUD: ibar weapon-icon base (INV_/INV2_ prefix) + ibar slot x (px). */
    invIcon: string;
    ibarSlotX: number;
    /** HUD: sbar ammo-count icon lump. */
    ammoIcon: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
    shotgun: {
        id: "shotgun",
        slot: 1,
        name: "Shotgun",
        ammo: "shells",
        ammoPerShot: 1,
        refire: 0.5,
        projectile: false,
        pellets: 6,
        spreadX: 0.04,
        spreadY: 0.04,
        dmgPerPellet: 4,
        range: 2048,
        fireSound: "weapons/guncock.wav",
        viewModel: { file: "progs/v_shot.mdl", fireFrames: 6, fireFps: 20 },
        invIcon: "SHOTGUN",
        ibarSlotX: 0,
        ammoIcon: "SB_SHELLS",
    },
    supershotgun: {
        id: "supershotgun",
        slot: 2,
        name: "Super Shotgun",
        ammo: "shells",
        ammoPerShot: 2,
        refire: 0.7,
        projectile: false,
        pellets: 14,
        spreadX: 0.14,
        spreadY: 0.08,
        dmgPerPellet: 4,
        range: 2048,
        fireSound: "weapons/shotgn2.wav",
        viewModel: { file: "progs/v_shot2.mdl", fireFrames: 6, fireFps: 20 },
        invIcon: "SSHOTGUN",
        ibarSlotX: 24,
        ammoIcon: "SB_SHELLS",
    },
    grenade: {
        id: "grenade",
        slot: 3,
        name: "Grenade Launcher",
        ammo: "rockets",
        ammoPerShot: 1,
        refire: 0.6,
        projectile: true,
        pellets: 0,
        spreadX: 0,
        spreadY: 0,
        dmgPerPellet: 0,
        range: 0,
        fireSound: "weapons/grenade.wav",
        // Grenade launcher uses the v_rock viewmodel; its HUD icon is "rlaunch".
        viewModel: { file: "progs/v_rock.mdl", fireFrames: 6, fireFps: 20 },
        invIcon: "RLAUNCH",
        ibarSlotX: 96,
        ammoIcon: "SB_ROCKET",
    },
};

/** Weapon classnames in the map → the weapon they grant. */
export const WEAPON_PICKUPS: Record<string, WeaponId> = {
    weapon_supershotgun: "supershotgun",
    weapon_grenadelauncher: "grenade",
};

export const WEAPON_ORDER: WeaponId[] = ["shotgun", "supershotgun", "grenade"];
