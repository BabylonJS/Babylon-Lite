// Clean-room DOOM player state: health, armor, ammo, weapons and keys, plus the
// weapon-firing logic. Values are reproduced from public Doom documentation and
// authored as original TypeScript.

import type { DoomWorld } from "../mobj/world.js";
import { Pickup } from "../mobj/info.js";
import { lineAttack, MISSILE_RANGE } from "../combat/attack.js";

export const enum Ammo {
    BULLETS = 0,
    SHELLS,
    CELLS,
    ROCKETS,
    NONE,
}

export const enum Weapon {
    FIST = 0,
    PISTOL,
    SHOTGUN,
    CHAINGUN,
    ROCKET,
    PLASMA,
    BFG,
    CHAINSAW,
}

interface WeaponDef {
    ammo: Ammo;
    name: string;
    /** Min tics between shots. */
    refire: number;
    sound: string;
}

const WEAPONS: Record<Weapon, WeaponDef> = {
    [Weapon.FIST]: { ammo: Ammo.NONE, name: "Fist", refire: 12, sound: "PUNCH" },
    [Weapon.PISTOL]: { ammo: Ammo.BULLETS, name: "Pistol", refire: 12, sound: "PISTOL" },
    [Weapon.SHOTGUN]: { ammo: Ammo.SHELLS, name: "Shotgun", refire: 28, sound: "SHOTGN" },
    [Weapon.CHAINGUN]: { ammo: Ammo.BULLETS, name: "Chaingun", refire: 4, sound: "PISTOL" },
    [Weapon.ROCKET]: { ammo: Ammo.ROCKETS, name: "Rocket Launcher", refire: 18, sound: "RLAUNC" },
    [Weapon.PLASMA]: { ammo: Ammo.CELLS, name: "Plasma Gun", refire: 3, sound: "PLASMA" },
    [Weapon.BFG]: { ammo: Ammo.CELLS, name: "BFG9000", refire: 40, sound: "BFG" },
    [Weapon.CHAINSAW]: { ammo: Ammo.NONE, name: "Chainsaw", refire: 4, sound: "SAWFUL" },
};

const MAX_AMMO = [200, 50, 300, 50];
const BACKPACK_AMMO = [400, 100, 600, 100];

export class Player {
    health = 100;
    armor = 0;
    armorFactor = 0; // 0 = none, 1/3 green, 1/2 blue
    ammo = [50, 0, 0, 0];
    maxAmmo = [...MAX_AMMO];
    weaponsOwned = new Set<Weapon>([Weapon.FIST, Weapon.PISTOL]);
    weapon: Weapon = Weapon.PISTOL;
    pendingWeapon: Weapon | null = null;
    keys = new Set<Pickup>();
    refireDelay = 0;
    message = "";
    messageTics = 0;
    /** Damage tint feedback for the HUD (0..1). */
    painFlash = 0;
    bonusFlash = 0;

    constructor(private readonly world: DoomWorld) {}

    setMessage(text: string): void {
        this.message = text;
        this.messageTics = 35 * 3;
    }

    /** Called each tic to decrement timers. */
    tic(): void {
        if (this.refireDelay > 0) this.refireDelay--;
        if (this.messageTics > 0) this.messageTics--;
        if (this.painFlash > 0) this.painFlash = Math.max(0, this.painFlash - 0.08);
        if (this.bonusFlash > 0) this.bonusFlash = Math.max(0, this.bonusFlash - 0.04);
        if (this.pendingWeapon !== null) {
            this.weapon = this.pendingWeapon;
            this.pendingWeapon = null;
        }
    }

    takeDamage(amount: number): void {
        if (this.health <= 0) return;
        let dmg = amount;
        if (this.armor > 0 && this.armorFactor > 0) {
            const saved = Math.min(this.armor, Math.floor(dmg * this.armorFactor));
            this.armor -= saved;
            dmg -= saved;
            if (this.armor === 0) this.armorFactor = 0;
        }
        this.health = Math.max(0, this.health - dmg);
        // A kill triggers Doom's heavy red death flash; otherwise scale with hurt.
        this.painFlash = this.health <= 0 ? 1 : Math.min(1, this.painFlash + dmg / 100 + 0.1);
    }

    /** True once the player has been killed. */
    get dead(): boolean {
        return this.health <= 0;
    }

    /** Reset to the pistol-start loadout for a fresh life after death. */
    respawn(): void {
        this.health = 100;
        this.armor = 0;
        this.armorFactor = 0;
        this.ammo = [50, 0, 0, 0];
        this.maxAmmo = [...MAX_AMMO];
        this.weaponsOwned = new Set<Weapon>([Weapon.FIST, Weapon.PISTOL]);
        this.weapon = Weapon.PISTOL;
        this.pendingWeapon = null;
        this.keys.clear();
        this.refireDelay = 0;
        this.painFlash = 0;
        this.bonusFlash = 0;
        this.message = "";
        this.messageTics = 0;
    }

    selectWeapon(w: Weapon): void {
        if (!this.weaponsOwned.has(w)) return;
        if (WEAPONS[w].ammo !== Ammo.NONE && this.ammo[WEAPONS[w].ammo]! <= 0) return;
        this.pendingWeapon = w;
    }

    /** Fires the current weapon if able. Returns true if it fired. */
    fire(): boolean {
        if (this.health <= 0 || this.refireDelay > 0) return false;
        const def = WEAPONS[this.weapon];
        if (def.ammo !== Ammo.NONE && this.ammo[def.ammo]! <= 0) {
            // Auto-switch down when out of ammo.
            this.selectWeapon(this.ammo[Ammo.BULLETS]! > 0 ? Weapon.PISTOL : Weapon.FIST);
            return false;
        }
        this.refireDelay = def.refire;
        this.world.events.sound?.(def.sound);
        const p = this.world.player;

        switch (this.weapon) {
            case Weapon.FIST:
            case Weapon.CHAINSAW:
                lineAttack(this.world, p, p.angle, 64, (1 + Math.floor(Math.random() * 10)) * 2);
                break;
            case Weapon.PISTOL:
            case Weapon.CHAINGUN:
                this.ammo[Ammo.BULLETS] = this.ammo[Ammo.BULLETS]! - 1;
                lineAttack(this.world, p, p.angle + (Math.random() - Math.random()) * 0.04, MISSILE_RANGE, (1 + Math.floor(Math.random() * 3)) * 5);
                break;
            case Weapon.SHOTGUN:
                this.ammo[Ammo.SHELLS] = this.ammo[Ammo.SHELLS]! - 1;
                for (let i = 0; i < 7; i++) {
                    lineAttack(this.world, p, p.angle + (Math.random() - Math.random()) * 0.18, MISSILE_RANGE, (1 + Math.floor(Math.random() * 3)) * 5);
                }
                break;
            case Weapon.ROCKET:
            case Weapon.PLASMA:
            case Weapon.BFG:
                // Treated as hitscan placeholders for v1 (no rocket mobj yet).
                this.ammo[def.ammo] = this.ammo[def.ammo]! - 1;
                lineAttack(this.world, p, p.angle, MISSILE_RANGE, (1 + Math.floor(Math.random() * 5)) * 10);
                break;
        }
        return true;
    }

    /** Applies a pickup; returns true if it was consumed. */
    pickup(kind: Pickup): boolean {
        switch (kind) {
            case Pickup.HEALTH_BONUS:
                if (this.health >= 200) return false;
                this.health = Math.min(200, this.health + 1);
                this.bonusFlash = 0.5;
                return true;
            case Pickup.STIMPACK:
                return this.giveHealth(10, 100);
            case Pickup.MEDIKIT:
                return this.giveHealth(25, 100);
            case Pickup.SOULSPHERE:
                this.health = Math.min(200, this.health + 100);
                this.bonusFlash = 0.7;
                return true;
            case Pickup.ARMOR_BONUS:
                if (this.armor >= 200) return false;
                this.armor = Math.min(200, this.armor + 1);
                if (this.armorFactor === 0) this.armorFactor = 1 / 3;
                this.bonusFlash = 0.5;
                return true;
            case Pickup.GREEN_ARMOR:
                if (this.armor >= 100) return false;
                this.armor = 100;
                this.armorFactor = 1 / 3;
                return true;
            case Pickup.BLUE_ARMOR:
                if (this.armor >= 200) return false;
                this.armor = 200;
                this.armorFactor = 1 / 2;
                return true;
            case Pickup.CLIP: return this.giveAmmo(Ammo.BULLETS, 10);
            case Pickup.AMMO_BOX: return this.giveAmmo(Ammo.BULLETS, 50);
            case Pickup.SHELLS: return this.giveAmmo(Ammo.SHELLS, 4);
            case Pickup.SHELL_BOX: return this.giveAmmo(Ammo.SHELLS, 20);
            case Pickup.ROCKET: return this.giveAmmo(Ammo.ROCKETS, 1);
            case Pickup.ROCKET_BOX: return this.giveAmmo(Ammo.ROCKETS, 5);
            case Pickup.CELL: return this.giveAmmo(Ammo.CELLS, 20);
            case Pickup.CELL_PACK: return this.giveAmmo(Ammo.CELLS, 100);
            case Pickup.BACKPACK:
                this.maxAmmo = [...BACKPACK_AMMO];
                this.giveAmmo(Ammo.BULLETS, 10);
                this.giveAmmo(Ammo.SHELLS, 4);
                this.giveAmmo(Ammo.ROCKETS, 1);
                this.giveAmmo(Ammo.CELLS, 20);
                return true;
            case Pickup.WEAPON_SHOTGUN: return this.giveWeapon(Weapon.SHOTGUN, Ammo.SHELLS, 8);
            case Pickup.WEAPON_CHAINGUN: return this.giveWeapon(Weapon.CHAINGUN, Ammo.BULLETS, 20);
            case Pickup.WEAPON_ROCKET: return this.giveWeapon(Weapon.ROCKET, Ammo.ROCKETS, 2);
            case Pickup.WEAPON_PLASMA: return this.giveWeapon(Weapon.PLASMA, Ammo.CELLS, 40);
            case Pickup.WEAPON_BFG: return this.giveWeapon(Weapon.BFG, Ammo.CELLS, 40);
            case Pickup.WEAPON_CHAINSAW: return this.giveWeapon(Weapon.CHAINSAW, Ammo.NONE, 0);
            case Pickup.KEY_BLUE:
            case Pickup.KEY_YELLOW:
            case Pickup.KEY_RED:
            case Pickup.KEY_BLUE_SKULL:
            case Pickup.KEY_YELLOW_SKULL:
            case Pickup.KEY_RED_SKULL:
                if (this.keys.has(kind)) return false;
                this.keys.add(kind);
                return true;
            case Pickup.NONE:
            default:
                return true; // powerups: acknowledged, effect not modeled in v1
        }
    }

    private giveHealth(amount: number, max: number): boolean {
        if (this.health >= max) return false;
        this.health = Math.min(max, this.health + amount);
        return true;
    }

    private giveAmmo(type: Ammo, amount: number): boolean {
        if (type === Ammo.NONE) return false;
        if (this.ammo[type]! >= this.maxAmmo[type]!) return false;
        this.ammo[type] = Math.min(this.maxAmmo[type]!, this.ammo[type]! + amount);
        return true;
    }

    private giveWeapon(w: Weapon, ammo: Ammo, amount: number): boolean {
        const hadWeapon = this.weaponsOwned.has(w);
        this.weaponsOwned.add(w);
        const gotAmmo = ammo !== Ammo.NONE ? this.giveAmmo(ammo, amount) : false;
        if (!hadWeapon) {
            this.pendingWeapon = w;
            return true;
        }
        return gotAmmo;
    }

    weaponName(): string {
        return WEAPONS[this.weapon].name;
    }

    currentAmmo(): number {
        const a = WEAPONS[this.weapon].ammo;
        return a === Ammo.NONE ? -1 : this.ammo[a]!;
    }
}
