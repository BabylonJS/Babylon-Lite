// Clean-room Quake monster + combat system for the E1M1 demo. Renders enemies as
// animated MDL alias models, drives a small AI state machine (idle → chase →
// attack → die) against the BSP collision hulls, and resolves the player's
// hitscan shotgun. No GPL game code copied — behaviour is reimplemented from the
// publicly documented monster stats.
//
// Vertex animation is done by streaming each keyframe's positions into the mesh's
// GPU vertex buffer (the Quake world material is unlit, so normals are ignored).

import {
    addToScene,
    createMeshFromData,
    createTexture2DFromPixels,
    type EngineContext,
    type Mesh,
    type SceneContext,
    type Texture2D,
} from "babylon-lite";

import { parseMdl, expandFrame, type MdlModel } from "../render/mdl.js";
import { createQuakeMaterial } from "../render/quake-material.js";
import { quakeToEngine } from "../geometry/build-geometry.js";
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
    alive: [number, number]; // looping animation frame range
    death: [number, number]; // one-shot death frame range
    animFps: number;
}

const DEFS: Record<string, MonsterDef> = {
    monster_army: { classname: "monster_army", url: "/librequake/progs/soldier.mdl", health: 30, speed: 70, sightRange: 1200, attackRange: 600, attackDamage: 5, attackInterval: 1.0, alive: [2, 9], death: [104, 113], animFps: 8 },
    monster_dog: { classname: "monster_dog", url: "/librequake/progs/dog.mdl", health: 25, speed: 150, sightRange: 1000, attackRange: 64, attackDamage: 6, attackInterval: 0.6, alive: [0, 11], death: [76, 85], animFps: 12 },
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
    frame: number;
    frameTime: number;
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
}

export class MonsterSystem {
    private readonly monsters: Monster[] = [];
    private readonly models = new Map<string, MdlModel>();
    private readonly device: GPUDevice;
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
    ) {
        this.device = (engine as unknown as { device: GPUDevice }).device;
    }

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
        expandFrame(model, def.alive[0], scratch);
        const uv2 = new Float32Array(corners * 2);
        for (let i = 0; i < corners; i++) {
            uv2[i * 2] = this.whiteUV[0];
            uv2[i * 2 + 1] = this.whiteUV[1];
        }
        const mesh = createMeshFromData(this.engine, `mon_${def.classname}_${this.total}`, scratch.slice(), new Float32Array(corners * 3), model.indices.slice(), model.uvs.slice(), uv2);
        const skinTex = createTexture2DFromPixels(this.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            minFilter: "linear",
            magFilter: "linear",
        });
        mesh.material = createQuakeMaterial(`monMat_${def.classname}_${this.total}`, skinTex, this.lightTex);
        addToScene(this.scene, mesh);

        const m: Monster = { def, model, mesh, scratch, origin: [origin[0], origin[1], origin[2]], yaw, health: def.health, state: "idle", frame: def.alive[0], frameTime: 0, attackTimer: 0, deathDone: false };
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

    update(dt: number, playerOrigin: V3): void {
        for (const m of this.monsters) {
            if (m.state === "dead") {
                this.animateDeath(m, dt);
                continue;
            }
            const dx = playerOrigin[0] - m.origin[0];
            const dy = playerOrigin[1] - m.origin[1];
            const dz = playerOrigin[2] - m.origin[2];
            const dist = Math.hypot(dx, dy, dz);

            if (m.state === "idle") {
                if (dist < m.def.sightRange && this.canSee(m, playerOrigin)) m.state = "chase";
            }

            if (m.state === "chase") {
                m.yaw = Math.atan2(dy, dx);
                if (dist > m.def.attackRange * 0.6) this.moveToward(m, dx, dy, dt);
                m.attackTimer -= dt;
                if (dist < m.def.attackRange && m.attackTimer <= 0 && this.canSee(m, playerOrigin)) {
                    m.attackTimer = m.def.attackInterval;
                    this.hooks.damage(m.def.attackDamage);
                }
            }

            this.placeMesh(m);
            this.animateAlive(m, dt);
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
        const tr = this.physics.castMove(eye, target);
        return tr.fraction > 0.95;
    }

    private animateAlive(m: Monster, dt: number): void {
        m.frameTime += dt;
        const span = m.def.alive[1] - m.def.alive[0] + 1;
        const idx = m.def.alive[0] + (Math.floor(m.frameTime * m.def.animFps) % span);
        if (idx !== m.frame) {
            m.frame = idx;
            this.writeFrame(m, idx);
        }
    }

    private animateDeath(m: Monster, dt: number): void {
        if (m.deathDone) return;
        m.frameTime += dt;
        const span = m.def.death[1] - m.def.death[0];
        const step = Math.floor(m.frameTime * m.def.animFps);
        const idx = Math.min(m.def.death[0] + step, m.def.death[1]);
        if (idx !== m.frame) {
            m.frame = idx;
            this.writeFrame(m, idx);
        }
        if (step >= span) m.deathDone = true;
    }

    private writeFrame(m: Monster, frameIndex: number): void {
        expandFrame(m.model, frameIndex, m.scratch);
        const gpu = (m.mesh as unknown as { _gpu: { positionBuffer: GPUBuffer } })._gpu;
        this.device.queue.writeBuffer(gpu.positionBuffer, 0, m.scratch.buffer, m.scratch.byteOffset, m.scratch.byteLength);
    }

    /**
     * Resolve a hitscan shot. Returns true if a live monster was hit.
     * origin/dir are in Quake space; dir must be normalized.
     */
    hitscan(origin: V3, dir: V3, range: number, damage: number): boolean {
        let best: Monster | null = null;
        let bestT = range;
        for (const m of this.monsters) {
            if (m.state === "dead") continue;
            const t = rayAabb(origin, dir, [m.origin[0] + MON_MINS[0], m.origin[1] + MON_MINS[1], m.origin[2] + MON_MINS[2]], [m.origin[0] + MON_MAXS[0], m.origin[1] + MON_MAXS[1], m.origin[2] + MON_MAXS[2]]);
            if (t !== null && t < bestT) {
                const hit: V3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
                const wall = this.physics.castMove(origin, hit);
                if (wall.fraction >= 0.99) {
                    best = m;
                    bestT = t;
                }
            }
        }
        if (!best) return false;
        this.damageMonster(best, damage);
        return true;
    }

    private damageMonster(m: Monster, amount: number): void {
        if (m.state === "dead") return;
        m.health -= amount;
        if (m.health <= 0) {
            m.state = "dead";
            m.frameTime = 0;
            m.frame = m.def.death[0];
            this.writeFrame(m, m.def.death[0]);
            this.kills++;
            this.hooks.message?.(`${this.kills}/${this.total} enemies down`);
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
        const da = d[a];
        if (Math.abs(da) < 1e-8) {
            if (o[a] < mn[a] || o[a] > mx[a]) return null;
        } else {
            const inv = 1 / da;
            let t1 = (mn[a] - o[a]) * inv;
            let t2 = (mx[a] - o[a]) * inv;
            if (t1 > t2) [t1, t2] = [t2, t1];
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        }
    }
    return tmin;
}
