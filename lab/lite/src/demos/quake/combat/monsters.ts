// Clean-room Quake monster + combat system for the E1M1 demo. Renders enemies as
// animated MDL alias models, drives a small AI state machine (idle → chase →
// attack → die) against the BSP collision hulls, and resolves the player's
// hitscan shotgun. No GPL game code copied — behaviour is reimplemented from the
// publicly documented monster stats.
//
// Vertex animation is done by streaming each keyframe's positions into the mesh's
// GPU vertex buffer (the Quake world material is unlit, so normals are ignored).

import { addToScene, createMeshFromData, createTexture2DFromPixels, updateMeshPositions, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "babylon-lite";

import { parseMdl, expandFrame, type MdlModel } from "../render/mdl.js";
import { createQuakeMaterial } from "../render/quake-material.js";
import { quakeToEngine } from "../geometry/build-geometry.js";
import { demoAssetUrl } from "../../demo-asset-url.js";
import type { QuakePhysics } from "../physics/collision.js";
import type { Palette } from "../palette.js";

type V3 = [number, number, number];

interface MonsterDef {
    classname: string;
    url: string;
    health: number;
    speed: number; // units / second when chasing
    sightRange: number;
    attackRange: number;
    attackDamage: number;
    attackInterval: number;
    stand: [number, number]; // looping idle frames
    run: [number, number]; // looping locomotion frames
    attack: [number, number]; // one-shot attack frames (muzzle flash mid-sequence)
    death: [number, number]; // one-shot death frames
    standFps: number;
    runFps: number;
    attackFps: number;
    deathFps: number;
    sightSnd: string;
    attackSnd: string;
    painSnds: string[];
    deathSnd: string;
}

// Frame ranges follow the id1 alias-model layout (LibreQuake keeps it intact):
//   soldier: stand 0-7, deathc 18-28, run 73-80, shoot 81-89 (flash ~85)
//   dog:     attack 0-7, death 8-16, run 48-59, stand 69-77
const DEFS: Record<string, MonsterDef> = {
    monster_army: {
        classname: "monster_army",
        url: demoAssetUrl("./librequake/progs/soldier.mdl", import.meta.url),
        health: 30,
        speed: 70,
        sightRange: 1200,
        attackRange: 600,
        attackDamage: 5,
        attackInterval: 1.0,
        stand: [0, 7],
        run: [73, 80],
        attack: [81, 89],
        death: [18, 28],
        standFps: 5,
        runFps: 10,
        attackFps: 10,
        deathFps: 8,
        sightSnd: "soldier/sight1.wav",
        attackSnd: "soldier/sattck1.wav",
        painSnds: ["soldier/pain1.wav", "soldier/pain2.wav"],
        deathSnd: "soldier/death1.wav",
    },
    monster_dog: {
        classname: "monster_dog",
        url: demoAssetUrl("./librequake/progs/dog.mdl", import.meta.url),
        health: 25,
        speed: 150,
        sightRange: 1000,
        attackRange: 80,
        attackDamage: 6,
        attackInterval: 0.6,
        stand: [69, 77],
        run: [48, 59],
        attack: [0, 7],
        death: [8, 16],
        standFps: 6,
        runFps: 14,
        attackFps: 12,
        deathFps: 10,
        sightSnd: "dog/dsight.wav",
        attackSnd: "dog/dattack1.wav",
        painSnds: ["dog/dpain1.wav"],
        deathSnd: "dog/ddeath.wav",
    },
};

const MON_MINS: V3 = [-16, -16, -24];
const MON_MAXS: V3 = [16, 16, 40];

interface Monster {
    def: MonsterDef;
    model: MdlModel;
    mesh: Mesh;
    scratch: Float32Array;
    origin: V3; // quake space
    yaw: number; // radians, quake yaw about +Z
    health: number;
    state: "idle" | "chase" | "dead";
    anim: "stand" | "run" | "attack";
    frame: number;
    animTime: number;
    attackTimer: number;
    deathDone: boolean;
}

interface SpawnEnt {
    classname?: string;
    origin?: string;
    angle?: string;
}

export interface MonsterHooks {
    damage: (amount: number) => void;
    message?: (text: string) => void;
    /** Play a positional sound at a monster's Quake-space origin. */
    sound?: (path: string, origin: V3) => void;
}

export class MonsterSystem {
    private readonly monsters: Monster[] = [];
    private readonly models = new Map<string, MdlModel>();
    kills = 0;
    total = 0;

    constructor(
        private readonly engine: EngineContext,
        private readonly scene: SceneContext,
        private readonly physics: QuakePhysics,
        private readonly lightTex: Texture2D,
        private readonly whiteUV: [number, number],
        private readonly palette: Palette,
        private readonly hooks: MonsterHooks
    ) {}

    /** Fetch + parse the MDL models needed for the given entity classes. */
    async load(classes: Iterable<string>): Promise<void> {
        const urls = new Set<string>();
        for (const c of classes) {
            const def = DEFS[c];
            if (def) urls.add(def.url);
        }
        await Promise.all(
            [...urls].map(async (url) => {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
                this.models.set(url, parseMdl(await res.arrayBuffer(), this.palette));
            })
        );
    }

    /** Debug: origin of the monster nearest to `from` (Quake space), after floor-drop. */
    nearestOrigin(from: V3): V3 | null {
        let best: Monster | null = null;
        let bestD = Infinity;
        for (const m of this.monsters) {
            const dx = m.origin[0] - from[0];
            const dy = m.origin[1] - from[1];
            const dz = m.origin[2] - from[2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = m;
            }
        }
        return best ? [best.origin[0], best.origin[1], best.origin[2]] : null;
    }

    spawn(ents: SpawnEnt[]): void {
        for (const ent of ents) {
            const def = ent.classname ? DEFS[ent.classname] : undefined;
            if (!def) continue;
            const model = this.models.get(def.url);
            if (!model) continue;
            const origin = parseVec3(ent.origin);
            const yaw = ((ent.angle ? Number(ent.angle) : 0) * Math.PI) / 180;
            this.monsters.push(this.createMonster(def, model, origin, yaw));
            this.total++;
        }
    }

    private createMonster(def: MonsterDef, model: MdlModel, origin: V3, yaw: number): Monster {
        const corners = model.indices.length;
        const scratch = new Float32Array(corners * 3);
        expandFrame(model, def.stand[0], scratch);
        const uv2 = new Float32Array(corners * 2);
        for (let i = 0; i < corners; i++) {
            uv2[i * 2] = this.whiteUV[0];
            uv2[i * 2 + 1] = this.whiteUV[1];
        }
        const mesh = createMeshFromData(
            this.engine,
            `mon_${def.classname}_${this.total}`,
            scratch.slice(),
            new Float32Array(corners * 3),
            model.indices.slice(),
            model.uvs.slice(),
            uv2
        );
        const skinTex = createTexture2DFromPixels(this.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            minFilter: "linear",
            magFilter: "linear",
        });
        mesh.material = createQuakeMaterial(`monMat_${def.classname}_${this.total}`, skinTex, this.lightTex);
        addToScene(this.scene, mesh);

        const m: Monster = {
            def,
            model,
            mesh,
            scratch,
            origin: [origin[0], origin[1], origin[2]],
            yaw,
            health: def.health,
            state: "idle",
            anim: "stand",
            frame: def.stand[0],
            animTime: Math.random() * 2,
            attackTimer: 0,
            deathDone: false,
        };
        this.dropToFloor(m);
        this.placeMesh(m);
        return m;
    }

    private placeMesh(m: Monster): void {
        const [ex, ey, ez] = quakeToEngine(m.origin[0], m.origin[1], m.origin[2]);
        m.mesh.position.set(ex, ey, ez);
        // MDL faces +X in Quake; the Y/Z axis swap flips handedness, so negate yaw.
        m.mesh.rotation.set(0, -m.yaw, 0);
    }

    private dropToFloor(m: Monster): void {
        const tr = this.physics.castMove(m.origin, [m.origin[0], m.origin[1], m.origin[2] - 1024]);
        if (tr.fraction < 1) m.origin[2] = tr.endpos[2];
    }

    update(dt: number, playerOrigin: V3, playerDead = false): void {
        for (const m of this.monsters) {
            if (m.state === "dead") {
                this.animateDeath(m, dt);
                continue;
            }
            // Player is dead: enemies stop firing and chasing — stand down.
            if (playerDead) {
                if (m.state === "chase") m.anim = "stand";
                this.placeMesh(m);
                this.animateAlive(m, dt);
                continue;
            }
            const dx = playerOrigin[0] - m.origin[0];
            const dy = playerOrigin[1] - m.origin[1];
            const dz = playerOrigin[2] - m.origin[2];
            const dist = Math.hypot(dx, dy, dz);

            if (m.state === "idle") {
                if (dist < m.def.sightRange && this.canSee(m, playerOrigin)) {
                    m.state = "chase";
                    this.hooks.sound?.(m.def.sightSnd, m.origin);
                }
            }

            if (m.state === "chase") {
                m.yaw = Math.atan2(dy, dx);
                m.attackTimer -= dt;
                if (m.anim === "attack") {
                    // Mid-attack: stand and finish the shoot animation before moving again.
                } else if (dist < m.def.attackRange && m.attackTimer <= 0 && this.canSee(m, playerOrigin)) {
                    m.attackTimer = m.def.attackInterval;
                    m.anim = "attack";
                    m.animTime = 0;
                    this.hooks.sound?.(m.def.attackSnd, m.origin);
                    this.hooks.damage(m.def.attackDamage);
                } else {
                    const moving = dist > m.def.attackRange * 0.6;
                    if (moving) this.moveToward(m, dx, dy, dt);
                    m.anim = moving ? "run" : "stand";
                }
            }

            this.placeMesh(m);
            this.animateAlive(m, dt);
        }
    }

    private setFrame(m: Monster, idx: number): void {
        if (idx !== m.frame) {
            m.frame = idx;
            this.writeFrame(m, idx);
        }
    }

    private moveToward(m: Monster, dx: number, dy: number, dt: number): void {
        const len = Math.hypot(dx, dy) || 1;
        const step = m.def.speed * dt;
        const want: V3 = [m.origin[0] + (dx / len) * step, m.origin[1] + (dy / len) * step, m.origin[2]];
        const tr = this.physics.castMove(m.origin, want);
        m.origin[0] = tr.endpos[0];
        m.origin[1] = tr.endpos[1];
        m.origin[2] = tr.endpos[2];
        this.dropToFloor(m);
    }

    private canSee(m: Monster, playerOrigin: V3): boolean {
        const eye: V3 = [m.origin[0], m.origin[1], m.origin[2] + 24];
        const target: V3 = [playerOrigin[0], playerOrigin[1], playerOrigin[2] + 16];
        return this.physics.visible(eye, target);
    }

    private animateAlive(m: Monster, dt: number): void {
        m.animTime += dt;
        if (m.anim === "attack") {
            const [a, b] = m.def.attack;
            const span = b - a + 1;
            const step = Math.floor(m.animTime * m.def.attackFps);
            if (step >= span) {
                // Attack sequence finished — drop back to idle; chase() re-picks run/stand.
                m.anim = "stand";
                m.animTime = 0;
                return;
            }
            this.setFrame(m, a + step);
            return;
        }
        const [a, b] = m.anim === "run" ? m.def.run : m.def.stand;
        const fps = m.anim === "run" ? m.def.runFps : m.def.standFps;
        const span = b - a + 1;
        this.setFrame(m, a + (Math.floor(m.animTime * fps) % span));
    }

    private animateDeath(m: Monster, dt: number): void {
        if (m.deathDone) return;
        m.animTime += dt;
        const span = m.def.death[1] - m.def.death[0];
        const step = Math.floor(m.animTime * m.def.deathFps);
        const idx = Math.min(m.def.death[0] + step, m.def.death[1]);
        this.setFrame(m, idx);
        if (step >= span) m.deathDone = true;
    }

    private writeFrame(m: Monster, frameIndex: number): void {
        expandFrame(m.model, frameIndex, m.scratch);
        updateMeshPositions(this.engine, m.mesh, m.scratch);
    }

    /**
     * Resolve a hitscan shot. Returns the impact point on the hit monster
     * (Quake space), or null if no live monster was hit.
     * origin/dir are in Quake space; dir must be normalized.
     */
    hitscan(origin: V3, dir: V3, range: number, damage: number): V3 | null {
        let best: Monster | null = null;
        let bestT = range;
        for (const m of this.monsters) {
            if (m.state === "dead") continue;
            const t = rayAabb(
                origin,
                dir,
                [m.origin[0] + MON_MINS[0], m.origin[1] + MON_MINS[1], m.origin[2] + MON_MINS[2]],
                [m.origin[0] + MON_MAXS[0], m.origin[1] + MON_MAXS[1], m.origin[2] + MON_MAXS[2]]
            );
            if (t !== null && t < bestT) {
                const hit: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
                if (this.physics.visible(origin, hit)) {
                    best = m;
                    bestT = t;
                }
            }
        }
        if (!best) return null;
        this.damageMonster(best, damage);
        return [origin[0] + dir[0] * bestT, origin[1] + dir[1] * bestT, origin[2] + dir[2] * bestT];
    }

    /** Squared distance from a point to a live monster's AABB (0 if inside). */
    private aabbDistSq(m: Monster, p: V3): number {
        let d = 0;
        for (let i = 0; i < 3; i++) {
            const pi = p[i]!;
            const lo = m.origin[i]! + MON_MINS[i]!;
            const hi = m.origin[i]! + MON_MAXS[i]!;
            const v = pi < lo ? lo - pi : pi > hi ? pi - hi : 0;
            d += v * v;
        }
        return d;
    }

    /** Body centre of a monster (origin + half-bbox) — used as a LOS/aim target. */
    private bodyCenter(m: Monster): V3 {
        return [m.origin[0], m.origin[1], m.origin[2] + (MON_MINS[2] + MON_MAXS[2]) / 2];
    }

    /** True if any live monster's AABB is within `radius` of `point` (grenade touch). */
    hasLiveMonsterWithin(point: V3, radius: number): boolean {
        const r2 = radius * radius;
        for (const m of this.monsters) {
            if (m.state === "dead") continue;
            if (this.aabbDistSq(m, point) <= r2) return true;
        }
        return false;
    }

    /**
     * Quake-style splash damage: every live monster within `radius` of `center`
     * takes `maxDamage` falling off linearly to zero at the edge, gated by a
     * line-of-sight check so explosions don't damage through walls. Returns the
     * number of monsters killed so callers can refresh the HUD.
     */
    radiusDamage(center: V3, radius: number, maxDamage: number): number {
        const before = this.kills;
        for (const m of this.monsters) {
            if (m.state === "dead") continue;
            const d2 = this.aabbDistSq(m, center);
            if (d2 >= radius * radius) continue;
            const body = this.bodyCenter(m);
            const dir: V3 = [body[0] - center[0], body[1] - center[1], body[2] - center[2]];
            const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
            // Nudge the LOS trace start a touch toward the target so a grenade
            // resting against a wall doesn't immediately self-occlude.
            const start: V3 = [center[0] + (dir[0] / len) * 4, center[1] + (dir[1] / len) * 4, center[2] + (dir[2] / len) * 4];
            if (!this.physics.visible(start, body)) continue;
            const points = maxDamage * (1 - Math.sqrt(d2) / radius);
            if (points > 0) this.damageMonster(m, points);
        }
        return this.kills - before;
    }

    private damageMonster(m: Monster, amount: number): void {
        if (m.state === "dead") return;
        m.health -= amount;
        if (m.health <= 0) {
            m.state = "dead";
            m.animTime = 0;
            m.frame = m.def.death[0];
            this.writeFrame(m, m.def.death[0]);
            this.kills++;
            this.hooks.sound?.(m.def.deathSnd, m.origin);
            this.hooks.message?.(`${this.kills}/${this.total} enemies down`);
        } else {
            // Woke a dormant monster (e.g. shot from behind) and hurt it.
            if (m.state === "idle") m.state = "chase";
            this.hooks.sound?.(m.def.painSnds[(Math.random() * m.def.painSnds.length) | 0]!, m.origin);
        }
    }
}

function parseVec3(s: string | undefined): V3 {
    if (!s) return [0, 0, 0];
    const p = s.trim().split(/\s+/).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0];
}

/** Ray vs axis-aligned box; returns the near entry distance, or null if missed. */
function rayAabb(o: V3, d: V3, mn: V3, mx: V3): number | null {
    let tmin = 0;
    let tmax = Infinity;
    for (let a = 0; a < 3; a++) {
        const da = d[a]!;
        const oa = o[a]!;
        const mna = mn[a]!;
        const mxa = mx[a]!;
        if (Math.abs(da) < 1e-8) {
            if (oa < mna || oa > mxa) return null;
        } else {
            const inv = 1 / da;
            let t1 = (mna - oa) * inv;
            let t2 = (mxa - oa) * inv;
            if (t1 > t2) [t1, t2] = [t2, t1];
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
    }
    return tmin;
}
