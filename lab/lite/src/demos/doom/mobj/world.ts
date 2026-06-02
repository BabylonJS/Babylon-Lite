// The mobj world: spawns map THINGS into mobjs, runs the per-tic combat/AI
// simulation, and produces the per-frame list of billboards to draw.

import type { DoomMap, Sector } from "../wad/map.js";
import { sectorIndexAt, floorHeightAt, ceilingHeightAt } from "../wad/bsp-query.js";
import { infoForDoomednum, infoById, MF } from "./info.js";
import type { MobjInfo } from "./info.js";
import type { Mobj } from "./mobj.js";
import { Dir } from "./mobj.js";
import { STATE_SETS } from "./states.js";
import { setMobjState, tickMobj } from "./think.js";
import { buildCollisionLines } from "../physics/collision.js";
import type { CollLine } from "../physics/collision.js";
import type { SpriteStore } from "../render/sprites.js";
import type { RenderSprite } from "../render/sprite-render.js";

// THING flag bits (documented Doom map format).
const MTF_NORMAL = 2; // present on skill 3 (the skill we simulate)
const MTF_NOTSINGLE = 16; // multiplayer-only

// Logic things that must never spawn a visible mobj (excluding player start 1).
const LOGIC_DOOMEDNUMS = new Set<number>([2, 3, 4, 11, 14, 87, 88, 89]);

/** Emitted player-facing events (HUD messages, sounds), consumed by doom-level. */
export interface WorldEvents {
    message?(text: string): void;
    sound?(name: string): void;
    pickup?(pickup: number): boolean; // return true if consumed (player took it)
    damagePlayer?(amount: number): void;
}

export class DoomWorld {
    readonly mobjs: Mobj[] = [];
    readonly collLines: CollLine[];
    /** The player's mobj (target for monsters, source for attacks). */
    player: Mobj;
    events: WorldEvents = {};

    constructor(
        readonly map: DoomMap,
        readonly store: SpriteStore
    ) {
        this.collLines = buildCollisionLines(map);
        this.player = this.makePlayer();
    }

    get sectors(): Sector[] {
        return this.map.sectors;
    }

    private makePlayer(): Mobj {
        const info = infoById("PLAYER")!;
        return {
            info,
            x: 0,
            y: 0,
            z: 0,
            angle: 0,
            momx: 0,
            momy: 0,
            momz: 0,
            radius: info.radius,
            height: info.height,
            health: info.health,
            flags: info.flags,
            sprite: info.sprite,
            frame: info.spawnFrame,
            fullbright: false,
            stateId: -1,
            tics: -1,
            target: null,
            moveDir: Dir.NONE,
            moveCount: 0,
            reactionTime: 0,
            threshold: 0,
            sectorIndex: -1,
            removed: false,
        };
    }

    /** Spawns all single-player skill-3 things, returns the set of sprite names used. */
    spawnFromMap(): Set<string> {
        const used = new Set<string>();
        for (const thing of this.map.things) {
            if (thing.type === 1) {
                // Player 1 start — position the player mobj here.
                this.player.x = thing.x;
                this.player.y = thing.y;
                this.player.z = floorHeightAt(this.map, thing.x, thing.y);
                this.player.angle = (thing.angle * Math.PI) / 180;
                this.player.sectorIndex = sectorIndexAt(this.map, thing.x, thing.y);
                continue;
            }
            if (LOGIC_DOOMEDNUMS.has(thing.type)) continue;
            if ((thing.flags & MTF_NORMAL) === 0) continue;
            if (thing.flags & MTF_NOTSINGLE) continue;
            const info = infoForDoomednum(thing.type);
            if (!info || info.sprite === "----") continue;
            if (!this.store.has(info.sprite)) continue;

            const angle = (thing.angle * Math.PI) / 180;
            const m = this.spawnMobj(info, thing.x, thing.y, floorHeightAt(this.map, thing.x, thing.y), angle);
            used.add(m.sprite);
        }
        return used;
    }

    /** Creates a mobj of the given kind and starts it in its spawn state. */
    spawnMobj(info: MobjInfo, x: number, y: number, z: number, angle: number): Mobj {
        const m: Mobj = {
            info,
            x,
            y,
            z,
            angle,
            momx: 0,
            momy: 0,
            momz: 0,
            radius: info.radius,
            height: info.height,
            health: info.health,
            flags: info.flags,
            sprite: info.sprite,
            frame: info.spawnFrame,
            fullbright: info.fullbright,
            stateId: -1,
            tics: -1,
            target: null,
            moveDir: Dir.NONE,
            moveCount: 0,
            reactionTime: info.flags & MF.COUNTKILL ? 8 : 0,
            threshold: 0,
            sectorIndex: sectorIndexAt(this.map, x, y),
            removed: false,
        };
        const set = STATE_SETS.get(info.id);
        if (set) setMobjState(this, m, set.spawn);
        this.mobjs.push(m);
        return m;
    }

    /** Spawns a kind by its internal id (projectiles, puffs, blood). */
    spawnById(id: string, x: number, y: number, z: number, angle: number): Mobj | null {
        const info = infoById(id);
        if (!info) return null;
        return this.spawnMobj(info, x, y, z, angle);
    }

    floorAt(x: number, y: number): number {
        return floorHeightAt(this.map, x, y);
    }

    ceilingAt(x: number, y: number): number {
        return ceilingHeightAt(this.map, x, y);
    }

    /** Advances the simulation by one 35 Hz tic. */
    tic(): void {
        for (const m of this.mobjs) {
            if (!m.removed) tickMobj(this, m);
        }
        this.handlePickups();
        if (this.mobjs.some((m) => m.removed)) {
            for (let i = this.mobjs.length - 1; i >= 0; i--) {
                if (this.mobjs[i]!.removed) this.mobjs.splice(i, 1);
            }
        }
    }

    private handlePickups(): void {
        const p = this.player;
        for (const m of this.mobjs) {
            if (m.removed || (m.flags & MF.SPECIAL) === 0) continue;
            const dx = m.x - p.x;
            const dy = m.y - p.y;
            const reach = m.radius + p.radius;
            if (dx * dx + dy * dy > reach * reach) continue;
            const consumed = this.events.pickup ? this.events.pickup(m.info.pickup) : true;
            if (!consumed) continue;
            if (m.info.pickupMsg && this.events.message) this.events.message(m.info.pickupMsg);
            this.events.sound?.("ITEMUP");
            m.removed = true;
        }
    }

    /** Builds the list of billboards to draw this frame from the viewer position. */
    collectSprites(viewX: number, viewY: number): RenderSprite[] {
        const out: RenderSprite[] = [];
        for (const m of this.mobjs) {
            if (m.removed) continue;
            const img = this.store.pick(m.sprite, m.frame, m.angle, m.x, m.y, viewX, viewY);
            if (!img) continue;
            const sec = m.sectorIndex >= 0 ? this.map.sectors[m.sectorIndex] : undefined;
            const light = sec ? sec.light : 255;
            out.push({ x: m.x, y: m.y, z: m.z, image: img, light, fullbright: m.fullbright });
        }
        return out;
    }
}
