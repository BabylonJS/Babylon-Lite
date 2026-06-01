// Clean-room Quake entity logic: brush-model movers (doors, buttons, plats),
// the trigger/target activation graph (trigger_once/multiple/relay/counter,
// teleport, changelevel, push, secret) and item pickups. Pure logic — no engine
// dependency — so it can be simulated and tested headlessly. A separate render
// layer syncs meshes to the offsets/visibility this system computes.
//
// Reimplemented from the publicly documented QuakeC entity behaviours; no GPL
// source copied. All math is in Quake space (X fwd, Y left, Z up).

import type { BspData } from "../bsp/parse-bsp.js";
import type { QuakeEntity } from "./parse-entities.js";
import { parseVec3 } from "./parse-entities.js";
import type { QuakePhysics } from "../physics/collision.js";

type V3 = [number, number, number];

const PLAYER_MINS: V3 = [-16, -16, -24];
const PLAYER_MAXS: V3 = [16, 16, 32];
const DOOR_TRIGGER_PAD = 60; // Quake expands touch-open doors by 60 units.

// spawnflags
const DOOR_START_OPEN = 1;

const SOLID_BRUSH = new Set(["func_wall", "func_door", "func_door_secret", "func_button", "func_plat"]);
const TRIGGER_VOLUMES = new Set(["trigger_once", "trigger_multiple", "trigger_changelevel", "trigger_teleport", "trigger_push", "trigger_secret"]);
const ITEM_CLASSES = /^(item_|weapon_)/;
const CONTENTS_EMPTY = -1; // killed brush hulls are retargeted here so traces pass through.

export interface WorldHooks {
    message?: (text: string) => void;
    complete?: (map: string) => void;
    teleport?: (yawRadians: number) => void;
    /** Play a positional sound at a mover's Quake-space center. */
    sound?: (path: string, origin: V3) => void;
    /** A brush entity was removed via killtarget — hide its mesh(es). */
    kill?: (ent: WorldEnt) => void;
}

type MoverKind = "none" | "door" | "button" | "plat" | "secret";

export interface WorldEnt {
    cls: string;
    kv: QuakeEntity;
    targetname?: string;
    target?: string;
    killtarget?: string;
    modelIndex: number; // -1 for point entities
    bmins: V3; // world-space model bounds at rest
    bmaxs: V3;
    hullIndex: number; // index into physics.brushHulls, or -1
    offset: V3; // current translation (shared with physics.brushHulls[hullIndex].offset)

    // mover state
    kind: MoverKind;
    pos1: V3; // closed/rest offset
    pos2: V3; // open/active offset
    dest: V3; // current target offset
    speed: number;
    wait: number;
    moving: boolean;
    state: "rest" | "active" | "moving";
    waitTimer: number;

    // trigger / counter / item
    delay: number;
    count: number;
    countGoal: number;
    fired: boolean;
    killed: boolean;
    nextTouch: number;
    isItem: boolean;
    origin: V3;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Direction vector from a Quake "angle" key (-1 = up, -2 = down). */
function angleToDir(angle: number): V3 {
    if (angle === -1) return [0, 0, 1];
    if (angle === -2) return [0, 0, -1];
    const r = (angle * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), 0];
}

export class MoverSystem {
    readonly ents: WorldEnt[] = [];
    private readonly byName = new Map<string, WorldEnt[]>();
    private readonly scheduled: { time: number; ent: WorldEnt }[] = [];
    private time = 0;
    secrets = 0;

    constructor(
        _bsp: BspData,
        rawEntities: QuakeEntity[],
        private readonly physics: QuakePhysics,
        private readonly hooks: WorldHooks = {}
    ) {
        for (const kv of rawEntities) {
            const cls = kv.classname ?? "";
            if (!cls || cls === "worldspawn") continue;
            const modelRef = kv.model;
            const modelIndex = modelRef && modelRef.startsWith("*") ? Number(modelRef.slice(1)) : -1;
            const model = modelIndex >= 0 ? _bsp.models[modelIndex] : undefined;
            const ent: WorldEnt = {
                cls,
                kv,
                targetname: kv.targetname,
                target: kv.target,
                killtarget: kv.killtarget,
                modelIndex,
                bmins: model ? [...model.mins] : [0, 0, 0],
                bmaxs: model ? [...model.maxs] : [0, 0, 0],
                hullIndex: -1,
                offset: [0, 0, 0],
                kind: "none",
                pos1: [0, 0, 0],
                pos2: [0, 0, 0],
                dest: [0, 0, 0],
                speed: Number(kv.speed) || 100,
                wait: kv.wait !== undefined ? Number(kv.wait) : 3,
                moving: false,
                state: "rest",
                waitTimer: 0,
                delay: Number(kv.delay) || 0,
                count: 0,
                countGoal: Number(kv.count) || 0,
                fired: false,
                killed: false,
                nextTouch: 0,
                isItem: ITEM_CLASSES.test(cls),
                origin: parseVec3(kv.origin),
            };

            if (modelIndex >= 0 && SOLID_BRUSH.has(cls)) {
                ent.hullIndex = physics.brushHulls.length;
                physics.brushHulls.push({ headNode: model!.headNode[1], offset: ent.offset });
            }
            this.configureMover(ent, model ? ([model.maxs[0] - model.mins[0], model.maxs[1] - model.mins[1], model.maxs[2] - model.mins[2]] as V3) : [0, 0, 0]);

            this.ents.push(ent);
            if (ent.targetname) {
                const list = this.byName.get(ent.targetname) ?? [];
                list.push(ent);
                this.byName.set(ent.targetname, list);
            }
        }
    }

    private configureMover(ent: WorldEnt, size: V3): void {
        const flags = Number(ent.kv.spawnflags) || 0;
        if (ent.cls === "func_door" || ent.cls === "func_door_secret") {
            ent.kind = ent.cls === "func_door_secret" ? "secret" : "door";
            const lip = ent.kv.lip !== undefined ? Number(ent.kv.lip) : 8;
            const dir = angleToDir(ent.kv.angle !== undefined ? Number(ent.kv.angle) : 0);
            const travel = Math.abs(dir[0] * size[0]) + Math.abs(dir[1] * size[1]) + Math.abs(dir[2] * size[2]) - lip;
            const moved = scale(dir, travel);
            const startOpen = (flags & DOOR_START_OPEN) !== 0;
            ent.pos1 = startOpen ? moved : [0, 0, 0]; // closed
            ent.pos2 = startOpen ? [0, 0, 0] : moved; // open
            ent.offset[0] = ent.pos1[0];
            ent.offset[1] = ent.pos1[1];
            ent.offset[2] = ent.pos1[2];
            ent.dest = [...ent.pos1];
            ent.wait = ent.kv.wait !== undefined ? Number(ent.kv.wait) : 3;
            ent.speed = Number(ent.kv.speed) || 100;
        } else if (ent.cls === "func_button") {
            ent.kind = "button";
            const lip = ent.kv.lip !== undefined ? Number(ent.kv.lip) : 4;
            const dir = angleToDir(ent.kv.angle !== undefined ? Number(ent.kv.angle) : 0);
            const travel = Math.abs(dir[0] * size[0]) + Math.abs(dir[1] * size[1]) + Math.abs(dir[2] * size[2]) - lip;
            ent.pos1 = [0, 0, 0];
            ent.pos2 = scale(dir, travel);
            ent.dest = [0, 0, 0];
            ent.wait = ent.kv.wait !== undefined ? Number(ent.kv.wait) : 1;
            ent.speed = Number(ent.kv.speed) || 40;
        } else if (ent.cls === "func_plat") {
            ent.kind = "plat";
            const lip = ent.kv.lip !== undefined ? Number(ent.kv.lip) : 8;
            const height = ent.kv.height !== undefined ? Number(ent.kv.height) : size[2] - lip;
            // Start raised (top). pos2 lowers by height.
            ent.pos1 = [0, 0, 0];
            ent.pos2 = [0, 0, -Math.abs(height)];
            ent.dest = [0, 0, 0];
            ent.speed = Number(ent.kv.speed) || 150;
            ent.wait = 3;
            // Plats begin lowered so the player can ride them up.
            ent.offset[2] = ent.pos2[2];
            ent.dest = [...ent.pos2];
            ent.state = "rest";
        }
    }

    // ─── Activation graph ────────────────────────────────────────────────────
    private fire(targetName: string | undefined): void {
        if (!targetName) return;
        const list = this.byName.get(targetName);
        if (!list) return;
        for (const ent of list) {
            if (ent.delay > 0) this.scheduled.push({ time: this.time + ent.delay, ent });
            else this.use(ent);
        }
    }

    private use(ent: WorldEnt): void {
        switch (ent.cls) {
            case "func_door":
            case "func_door_secret":
                this.openDoor(ent);
                break;
            case "func_button":
                this.pressButton(ent);
                break;
            case "func_plat":
                this.platGo(ent, "up");
                break;
            case "trigger_relay":
                this.fire(ent.target);
                if (ent.kv.message) this.hooks.message?.(ent.kv.message);
                break;
            case "trigger_counter": {
                ent.count++;
                const goal = ent.countGoal || 2;
                if (ent.count < goal) {
                    this.hooks.message?.(`${goal - ent.count} more to go...`);
                } else {
                    if (ent.kv.message) this.hooks.message?.(ent.kv.message);
                    this.fire(ent.target);
                }
                break;
            }
            case "trigger_changelevel":
                this.hooks.complete?.(ent.kv.map ?? "");
                break;
            default:
                // Generic relay: anything else just passes its target along.
                this.fire(ent.target);
                break;
        }
        if (ent.killtarget) this.killTargets(ent.killtarget);
    }

    private killTargets(name: string): void {
        const list = this.byName.get(name);
        if (!list) return;
        for (const e of list) {
            e.fired = true; // disable trigger logic
            if (e.killed) continue;
            e.killed = true;
            // Remove the brush from collision so the player can pass through
            // (Quake removes the entity entirely). Retarget its clip hull to an
            // empty leaf so world + mover traces ignore it.
            if (e.hullIndex >= 0) this.physics.brushHulls[e.hullIndex]!.headNode = CONTENTS_EMPTY;
            this.hooks.kill?.(e);
        }
    }

    private openDoor(ent: WorldEnt): void {
        if (ent.state === "active" || ent.moving) {
            if (ent.state === "active") ent.waitTimer = this.time + (ent.wait >= 0 ? ent.wait : Infinity);
            return;
        }
        ent.dest = [...ent.pos2];
        ent.moving = true;
        ent.state = "moving";
        ent.fired = true;
        this.hooks.sound?.("doors/doormv1.wav", this.moverCenter(ent));
        if (ent.kv.message) this.hooks.message?.(ent.kv.message);
        this.fire(ent.target);
    }

    private closeDoor(ent: WorldEnt): void {
        ent.dest = [...ent.pos1];
        ent.moving = true;
        ent.state = "moving";
        this.hooks.sound?.("doors/doormv1.wav", this.moverCenter(ent));
    }

    private pressButton(ent: WorldEnt): void {
        if (ent.state !== "rest" || ent.moving) return;
        ent.dest = [...ent.pos2];
        ent.moving = true;
        ent.state = "moving";
        this.hooks.sound?.("doors/baseuse.wav", this.moverCenter(ent));
        this.fire(ent.target);
        if (ent.kv.message) this.hooks.message?.(ent.kv.message);
    }

    private platGo(ent: WorldEnt, dir: "up" | "down"): void {
        if (ent.moving) return;
        ent.dest = dir === "up" ? [...ent.pos1] : [...ent.pos2];
        ent.moving = true;
        ent.state = "moving";
        this.hooks.sound?.("doors/doormv1.wav", this.moverCenter(ent));
    }

    /** World-space center of a mover at its current offset (Quake space). */
    private moverCenter(ent: WorldEnt): V3 {
        return [(ent.bmins[0] + ent.bmaxs[0]) / 2 + ent.offset[0], (ent.bmins[1] + ent.bmaxs[1]) / 2 + ent.offset[1], (ent.bmins[2] + ent.bmaxs[2]) / 2 + ent.offset[2]];
    }

    // ─── Per-frame update ────────────────────────────────────────────────────
    update(dt: number): void {
        this.time += dt;

        // Scheduled (delayed) activations.
        for (let i = this.scheduled.length - 1; i >= 0; i--) {
            const s = this.scheduled[i]!;
            if (this.time >= s.time) {
                this.scheduled.splice(i, 1);
                this.use(s.ent);
            }
        }

        const pmin = add(this.physics.origin, PLAYER_MINS);
        const pmax = add(this.physics.origin, PLAYER_MAXS);

        this.handleTouch(pmin, pmax);
        this.advanceMovers(dt);
    }

    private handleTouch(pmin: V3, pmax: V3): void {
        for (const ent of this.ents) {
            if (ent.modelIndex < 0 && !TRIGGER_VOLUMES.has(ent.cls)) continue;

            // Touch-open doors (no targetname) and touch buttons.
            if ((ent.cls === "func_door" || ent.cls === "func_door_secret") && !ent.targetname) {
                if (this.overlap(pmin, pmax, add(ent.bmins, [-DOOR_TRIGGER_PAD, -DOOR_TRIGGER_PAD, -DOOR_TRIGGER_PAD]), add(ent.bmaxs, [DOOR_TRIGGER_PAD, DOOR_TRIGGER_PAD, DOOR_TRIGGER_PAD]))) {
                    this.openDoor(ent);
                }
                continue;
            }
            if (ent.cls === "func_button") {
                if (this.overlap(pmin, pmax, add(ent.bmins, [-8, -8, -8]), add(ent.bmaxs, [8, 8, 8]))) this.pressButton(ent);
                continue;
            }
            if (!TRIGGER_VOLUMES.has(ent.cls)) continue;

            const touching = this.overlap(pmin, pmax, ent.bmins, ent.bmaxs);
            if (!touching) continue;
            switch (ent.cls) {
                case "trigger_once":
                    if (ent.fired) break;
                    ent.fired = true;
                    if (ent.kv.message) this.hooks.message?.(ent.kv.message);
                    this.fire(ent.target);
                    break;
                case "trigger_multiple":
                    if (this.time < ent.nextTouch) break;
                    ent.nextTouch = this.time + (ent.wait > 0 ? ent.wait : 0.2);
                    if (ent.kv.message) this.hooks.message?.(ent.kv.message);
                    this.fire(ent.target);
                    break;
                case "trigger_secret":
                    if (ent.fired) break;
                    ent.fired = true;
                    this.secrets++;
                    this.hooks.message?.("You found a secret area!");
                    this.fire(ent.target);
                    break;
                case "trigger_changelevel":
                    this.hooks.complete?.(ent.kv.map ?? "");
                    break;
                case "trigger_teleport":
                    this.teleport(ent);
                    break;
                case "trigger_push":
                    this.push(ent);
                    break;
            }
        }
    }

    private teleport(ent: WorldEnt): void {
        const destEnt = this.ents.find((e) => e.cls === "info_teleport_destination" && e.targetname === ent.target);
        if (!destEnt) return;
        this.physics.origin[0] = destEnt.origin[0];
        this.physics.origin[1] = destEnt.origin[1];
        this.physics.origin[2] = destEnt.origin[2];
        this.physics.velocity[0] = 0;
        this.physics.velocity[1] = 0;
        this.physics.velocity[2] = 0;
        const yaw = ((Number(destEnt.kv.angle) || 0) * Math.PI) / 180;
        this.hooks.teleport?.(yaw);
    }

    private push(ent: WorldEnt): void {
        const dir = angleToDir(ent.kv.angle !== undefined ? Number(ent.kv.angle) : -1);
        const speed = (Number(ent.kv.speed) || 1000) * 10;
        this.physics.velocity[0] = dir[0] * speed * 0.1;
        this.physics.velocity[1] = dir[1] * speed * 0.1;
        this.physics.velocity[2] = dir[2] * speed * 0.1;
    }

    private advanceMovers(dt: number): void {
        for (const ent of this.ents) {
            // Plat auto-ride: rise when the player stands on it, return when clear.
            if (ent.kind === "plat" && !ent.moving) {
                const riding = this.physics.groundBrush === ent.hullIndex;
                const atBottom = Math.abs(ent.offset[2] - ent.pos2[2]) < 1;
                const atTop = Math.abs(ent.offset[2] - ent.pos1[2]) < 1;
                if (riding && atBottom) this.platGo(ent, "up");
                else if (!riding && atTop) {
                    if (ent.waitTimer === 0) ent.waitTimer = this.time + ent.wait;
                    else if (this.time >= ent.waitTimer) {
                        ent.waitTimer = 0;
                        this.platGo(ent, "down");
                    }
                } else if (riding && atTop) {
                    ent.waitTimer = 0;
                }
            }

            if (!ent.moving) {
                // Door auto-close after wait.
                if ((ent.kind === "door" || ent.kind === "secret") && ent.state === "active" && ent.wait >= 0 && this.time >= ent.waitTimer) {
                    this.closeDoor(ent);
                }
                if (ent.kind === "button" && ent.state === "active" && ent.wait >= 0 && this.time >= ent.waitTimer) {
                    ent.dest = [...ent.pos1];
                    ent.moving = true;
                    ent.state = "moving";
                    this.hooks.sound?.("doors/doormv1.wav", this.moverCenter(ent));
                }
                continue;
            }

            const delta: V3 = [ent.dest[0] - ent.offset[0], ent.dest[1] - ent.offset[1], ent.dest[2] - ent.offset[2]];
            const d = len(delta);
            const step = ent.speed * dt;
            if (d <= step || d === 0) {
                ent.offset[0] = ent.dest[0];
                ent.offset[1] = ent.dest[1];
                ent.offset[2] = ent.dest[2];
                ent.moving = false;
                this.onArrive(ent);
            } else {
                ent.offset[0] += (delta[0] / d) * step;
                ent.offset[1] += (delta[1] / d) * step;
                ent.offset[2] += (delta[2] / d) * step;
            }
        }
    }

    private onArrive(ent: WorldEnt): void {
        this.hooks.sound?.("doors/drclos4.wav", this.moverCenter(ent));
        const atPos2 = len([ent.offset[0] - ent.pos2[0], ent.offset[1] - ent.pos2[1], ent.offset[2] - ent.pos2[2]]) < 1;
        if (ent.kind === "door" || ent.kind === "secret") {
            if (atPos2) {
                ent.state = "active"; // open
                ent.waitTimer = this.time + (ent.wait >= 0 ? ent.wait : Infinity);
            } else {
                ent.state = "rest"; // closed
            }
        } else if (ent.kind === "button") {
            if (atPos2) {
                ent.state = "active";
                ent.waitTimer = this.time + (ent.wait >= 0 ? ent.wait : Infinity);
            } else {
                ent.state = "rest";
            }
        } else if (ent.kind === "plat") {
            ent.state = "rest";
            ent.waitTimer = 0;
        }
    }

    private overlap(amin: V3, amax: V3, bmin: V3, bmax: V3): boolean {
        return amin[0] <= bmax[0] && amax[0] >= bmin[0] && amin[1] <= bmax[1] && amax[1] >= bmin[1] && amin[2] <= bmax[2] && amax[2] >= bmin[2];
    }
}
