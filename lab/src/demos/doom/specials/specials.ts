// Clean-room DOOM linedef/sector "specials" runtime: doors, lifts, floors,
// switches and the level exit. Behaviour is reproduced from publicly documented
// DOOM facts; no GPL DOOM source is used or copied.
//
// Sectors mutated by a special (its floor/ceiling heights move) are "dynamic":
// their wall + flat geometry is excluded from the static mesh and rebuilt each
// frame they change. Switch lines are also dynamic so their texture swap shows.

import type { DoomMap } from "../wad/map.js";
import { sectorIndexOfSubsector } from "../geometry/build-level-geometry.js";
import { getSpecial } from "./special-types.js";
import type { SpecialDef } from "./special-types.js";

const USE_RANGE = 64;
const PLAYER_CLEARANCE = 56; // min head room before a closing door reverses

type MoverState = "opening" | "closing" | "waiting" | "lowering" | "raising";

interface Mover {
    sector: number;
    kind: "door" | "lift" | "floor";
    /** Doors only reverse on re-use when manually (push) triggered. */
    manual: boolean;
    state: MoverState;
    speed: number;
    wait: number;
    timer: number;
    /** Door: open ceiling target. Lift: original floor (raise target). */
    high: number;
    /** Door: closed ceiling (== floor). Lift/floor: low floor target. */
    low: number;
    done: boolean;
}

export interface SpecialsCallbacks {
    onExit?: () => void;
    /** Returns the sector index the player currently stands in, or -1. */
    playerSector?: () => number;
}

export class SpecialsManager {
    readonly dynamicLines = new Set<number>();
    readonly dynamicSubsectors = new Set<number>();

    private readonly map: DoomMap;
    private readonly cb: SpecialsCallbacks;
    private readonly dynamicSectors = new Set<number>();
    private readonly neighbors: number[][];
    private readonly movers = new Map<number, Mover>();
    private readonly triggeredLines = new Set<number>();
    private dirty = false;

    constructor(map: DoomMap, cb: SpecialsCallbacks = {}) {
        this.map = map;
        this.cb = cb;
        this.neighbors = buildSectorAdjacency(map);
        this.computeDynamicSets();
    }

    /** True (and resets) when dynamic geometry must be rebuilt this frame. */
    consumeDirty(): boolean {
        const d = this.dirty;
        this.dirty = false;
        return d;
    }

    /** Advance all active movers by one 35Hz tic. */
    tic(): void {
        for (const [sec, m] of this.movers) {
            this.stepMover(m);
            if (m.done) this.movers.delete(sec);
        }
    }

    /** USE (Space): activate the nearest usable line in front of the player,
     *  but stop the use-trace at the first solid wall in the way. */
    tryUse(x: number, y: number, yaw: number): void {
        const dx = Math.cos(yaw);
        const dy = Math.sin(yaw);
        const ex = x + dx * USE_RANGE;
        const ey = y + dy * USE_RANGE;

        let bestT = Infinity;
        let bestLine = -1;
        for (let i = 0; i < this.map.linedefs.length; i++) {
            const ld = this.map.linedefs[i]!;
            const a = this.map.vertices[ld.start];
            const b = this.map.vertices[ld.end];
            if (!a || !b) continue;
            const t = raySegT(x, y, ex, ey, a.x, a.y, b.x, b.y);
            if (t < 0 || t >= bestT) continue;

            const def = getSpecial(ld.special);
            const usable = !!def && (def.trigger === "push" || def.trigger === "switch");
            // A usable line is the candidate; a solid wall blocks the trace.
            if (usable || this.useBlocked(ld)) {
                bestT = t;
                bestLine = usable ? i : -1;
            }
        }
        if (bestLine >= 0) this.activate(bestLine, false);
    }

    // A line stops the use-trace if it is one-sided, explicitly blocking, or a
    // two-sided line whose current opening is too small to reach past.
    private useBlocked(ld: DoomMap["linedefs"][number]): boolean {
        if (ld.back < 0) return true;
        const front = this.map.sectors[this.map.sidedefs[ld.front]!.sector];
        const back = this.map.sectors[this.map.sidedefs[ld.back]!.sector];
        if (!front || !back) return true;
        return Math.min(front.ceilHeight, back.ceilHeight) - Math.max(front.floorHeight, back.floorHeight) < PLAYER_CLEARANCE;
    }

    /** Trigger WALK specials crossed by the player's movement segment. */
    crossLines(x0: number, y0: number, x1: number, y1: number): void {
        for (let i = 0; i < this.map.linedefs.length; i++) {
            const ld = this.map.linedefs[i]!;
            const def = getSpecial(ld.special);
            if (!def || def.trigger !== "walk") continue;
            if (!def.repeatable && this.triggeredLines.has(i)) continue;
            const a = this.map.vertices[ld.start];
            const b = this.map.vertices[ld.end];
            if (!a || !b) continue;
            if (segmentsIntersect(x0, y0, x1, y1, a.x, a.y, b.x, b.y)) {
                this.activate(i, true);
            }
        }
    }

    private activate(lineIndex: number, fromWalk: boolean): void {
        const ld = this.map.linedefs[lineIndex]!;
        const def = getSpecial(ld.special);
        if (!def) return;

        if (!def.repeatable) {
            if (this.triggeredLines.has(lineIndex)) return;
            this.triggeredLines.add(lineIndex);
        }

        // Switch lines swap their SW1<->SW2 texture for visual feedback.
        if (def.trigger === "switch") this.swapSwitchTexture(lineIndex);

        if (def.action === "exit") {
            this.cb.onExit?.();
            return;
        }

        const targets = def.manual ? this.manualTargetSectors(ld) : this.taggedSectors(ld.tag);
        for (const sec of targets) this.applyAction(def, sec);

        if (def.trigger === "switch" || (fromWalk && targets.length > 0)) this.dirty = true;
    }

    private applyAction(def: SpecialDef, sec: number): void {
        const existing = this.movers.get(sec);
        if (existing) {
            // Re-use of a *manual* (push) door reverses its current direction;
            // remote/tagged doors ignore re-triggering while already moving.
            if (existing.kind === "door" && existing.manual && def.manual) {
                existing.state = existing.state === "closing" ? "opening" : "closing";
            }
            return;
        }

        const s = this.map.sectors[sec];
        if (!s) return;

        switch (def.action) {
            case "doorOpenWaitClose":
            case "doorOpenStay": {
                const open = this.lowestNeighborCeiling(sec) - 4;
                this.movers.set(sec, {
                    sector: sec,
                    kind: "door",
                    manual: def.manual,
                    state: "opening",
                    speed: def.speed,
                    wait: def.action === "doorOpenStay" ? -1 : def.wait,
                    timer: 0,
                    high: open,
                    low: s.floorHeight,
                    done: false,
                });
                break;
            }
            case "lift": {
                const low = this.lowestNeighborFloor(sec);
                this.movers.set(sec, {
                    sector: sec,
                    kind: "lift",
                    manual: false,
                    state: "lowering",
                    speed: def.speed,
                    wait: def.wait,
                    timer: 0,
                    high: s.floorHeight,
                    low,
                    done: false,
                });
                break;
            }
            case "floorLowerToLowest": {
                const low = this.lowestNeighborFloor(sec);
                this.movers.set(sec, {
                    sector: sec,
                    kind: "floor",
                    manual: false,
                    state: "lowering",
                    speed: def.speed,
                    wait: 0,
                    timer: 0,
                    high: s.floorHeight,
                    low,
                    done: false,
                });
                break;
            }
        }
    }

    private stepMover(m: Mover): void {
        const s = this.map.sectors[m.sector];
        if (!s) {
            m.done = true;
            return;
        }
        switch (m.kind) {
            case "door":
                this.stepDoor(m, s);
                break;
            case "lift":
                this.stepLift(m, s);
                break;
            case "floor":
                this.stepFloor(m, s);
                break;
        }
    }

    private stepDoor(m: Mover, s: { ceilHeight: number }): void {
        if (m.state === "opening") {
            s.ceilHeight = Math.min(m.high, s.ceilHeight + m.speed);
            this.dirty = true;
            if (s.ceilHeight >= m.high) {
                if (m.wait < 0)
                    m.done = true; // open-stay
                else {
                    m.state = "waiting";
                    m.timer = m.wait;
                }
            }
        } else if (m.state === "waiting") {
            if (--m.timer <= 0) m.state = "closing";
        } else if (m.state === "closing") {
            // A door closing onto the player reverses instead of crushing.
            if (this.cb.playerSector?.() === m.sector && s.ceilHeight - m.low - m.speed < PLAYER_CLEARANCE) {
                m.state = "opening";
                return;
            }
            s.ceilHeight = Math.max(m.low, s.ceilHeight - m.speed);
            this.dirty = true;
            if (s.ceilHeight <= m.low) m.done = true;
        }
    }

    private stepLift(m: Mover, s: { floorHeight: number }): void {
        if (m.state === "lowering") {
            s.floorHeight = Math.max(m.low, s.floorHeight - m.speed);
            this.dirty = true;
            if (s.floorHeight <= m.low) {
                m.state = "waiting";
                m.timer = m.wait;
            }
        } else if (m.state === "waiting") {
            if (--m.timer <= 0) m.state = "raising";
        } else if (m.state === "raising") {
            s.floorHeight = Math.min(m.high, s.floorHeight + m.speed);
            this.dirty = true;
            if (s.floorHeight >= m.high) m.done = true;
        }
    }

    private stepFloor(m: Mover, s: { floorHeight: number }): void {
        s.floorHeight = Math.max(m.low, s.floorHeight - m.speed);
        this.dirty = true;
        if (s.floorHeight <= m.low) m.done = true;
    }

    private manualTargetSectors(ld: DoomMap["linedefs"][number]): number[] {
        // Manual (push) doors act on the back sector (the door interior).
        if (ld.back < 0) return [];
        const side = this.map.sidedefs[ld.back];
        return side ? [side.sector] : [];
    }

    private taggedSectors(tag: number): number[] {
        if (tag === 0) return [];
        const out: number[] = [];
        for (let i = 0; i < this.map.sectors.length; i++) {
            if (this.map.sectors[i]!.tag === tag) out.push(i);
        }
        return out;
    }

    private lowestNeighborCeiling(sec: number): number {
        let min = Infinity;
        for (const n of this.neighbors[sec]!) min = Math.min(min, this.map.sectors[n]!.ceilHeight);
        return min === Infinity ? this.map.sectors[sec]!.ceilHeight : min;
    }

    private lowestNeighborFloor(sec: number): number {
        let min = Infinity;
        for (const n of this.neighbors[sec]!) min = Math.min(min, this.map.sectors[n]!.floorHeight);
        return min === Infinity ? this.map.sectors[sec]!.floorHeight : min;
    }

    private swapSwitchTexture(lineIndex: number): void {
        const ld = this.map.linedefs[lineIndex]!;
        if (ld.front < 0) return;
        const side = this.map.sidedefs[ld.front]!;
        for (const slot of ["upper", "middle", "lower"] as const) {
            const name = side[slot];
            const swapped = swapSwitchName(name);
            if (swapped) {
                side[slot] = swapped;
                this.dirty = true;
                return;
            }
        }
    }

    private computeDynamicSets(): void {
        // Sectors whose heights can move.
        for (const ld of this.map.linedefs) {
            const def = getSpecial(ld.special);
            if (!def) continue;
            if (def.action === "exit") continue;
            if (def.manual) {
                for (const s of this.manualTargetSectors(ld)) this.dynamicSectors.add(s);
            } else {
                for (const s of this.taggedSectors(ld.tag)) this.dynamicSectors.add(s);
            }
        }

        // Lines: any wall touching a dynamic sector, plus all switch lines.
        for (let i = 0; i < this.map.linedefs.length; i++) {
            const ld = this.map.linedefs[i]!;
            const fSec = ld.front >= 0 ? this.map.sidedefs[ld.front]!.sector : -1;
            const bSec = ld.back >= 0 ? this.map.sidedefs[ld.back]!.sector : -1;
            const def = getSpecial(ld.special);
            const isSwitch = def?.trigger === "switch";
            if (isSwitch || this.dynamicSectors.has(fSec) || this.dynamicSectors.has(bSec)) {
                this.dynamicLines.add(i);
            }
        }

        // Subsectors whose sector is dynamic (their flats move).
        for (let i = 0; i < this.map.subsectors.length; i++) {
            const sec = sectorIndexOfSubsector(this.map, i);
            if (sec >= 0 && this.dynamicSectors.has(sec)) this.dynamicSubsectors.add(i);
        }
    }
}

function buildSectorAdjacency(map: DoomMap): number[][] {
    const sets: Set<number>[] = map.sectors.map(() => new Set<number>());
    for (const ld of map.linedefs) {
        if (ld.front < 0 || ld.back < 0) continue;
        const a = map.sidedefs[ld.front]!.sector;
        const b = map.sidedefs[ld.back]!.sector;
        if (a === b) continue;
        if (sets[a] && sets[b]) {
            sets[a].add(b);
            sets[b].add(a);
        }
    }
    return sets.map((s) => [...s]);
}

function swapSwitchName(name: string): string | null {
    if (name.startsWith("SW1")) return "SW2" + name.slice(3);
    if (name.startsWith("SW2")) return "SW1" + name.slice(3);
    return null;
}

/** Parametric distance along ray P->E where it first hits segment AB, or -1. */
function raySegT(px: number, py: number, ex: number, ey: number, ax: number, ay: number, bx: number, by: number): number {
    const rdx = ex - px;
    const rdy = ey - py;
    const sdx = bx - ax;
    const sdy = by - ay;
    const denom = rdx * sdy - rdy * sdx;
    if (Math.abs(denom) < 1e-9) return -1;
    const t = ((ax - px) * sdy - (ay - py) * sdx) / denom;
    const u = ((ax - px) * rdy - (ay - py) * rdx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
    return t;
}

function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const d1 = cross(cx, cy, dx, dy, ax, ay);
    const d2 = cross(cx, cy, dx, dy, bx, by);
    const d3 = cross(ax, ay, bx, by, cx, cy);
    const d4 = cross(ax, ay, bx, by, dx, dy);
    return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}
