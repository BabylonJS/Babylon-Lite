// Grenade-launcher projectiles for the LibreQuake E1M1 demo. Clean-room
// reimplementation of Quake's MOVETYPE_BOUNCE grenade: launched with an upward
// arc, falls under gravity, bounces off world geometry (player clip hull) and
// detonates on a fuse timer or when it touches a live monster, dealing splash
// damage. No GPL code copied.

import { addToScene, createMeshFromData, createTexture2DFromPixels, setMeshVisible, type EngineContext, type Mesh, type SceneContext, type Texture2D } from "babylon-lite";

import { parseMdl, expandFrame } from "../render/mdl.js";
import { createQuakeMaterial } from "../render/quake-material.js";
import { quakeToEngine } from "../geometry/build-geometry.js";
import type { QuakePhysics } from "../physics/collision.js";
import type { MonsterSystem } from "./monsters.js";
import type { Palette } from "../palette.js";
import { demoAssetUrl } from "../../demo-asset-url.js";

type V3 = [number, number, number];

const MODEL_URL = demoAssetUrl("./librequake/progs/grenade.mdl", import.meta.url);
const POOL = 8;
const GRAVITY = 800; // Quake sv_gravity (units/s²)
const LAUNCH_SPEED = 600; // forward muzzle velocity
const LAUNCH_UP = 200; // upward kick (Quake adds +200 to velocity_z)
const FUSE = 2.5; // seconds before detonation
const BOUNCE = 1.5; // ClipVelocity overbounce (keeps ~0.5 of incoming)
const EXPLODE_RADIUS = 160;
const EXPLODE_DAMAGE = 120;
const TOUCH_RADIUS = 20; // detonate when this close to a live monster's box

export interface GrenadeHooks {
    /** Positional sound (Quake-space point). */
    sound: (name: string, at: V3) => void;
    /** Spawn explosion particles at a Quake-space point. */
    explosion: (at: V3) => void;
    /** Apply splash damage to the player from an explosion centre. */
    playerSplash: (center: V3, radius: number, maxDamage: number) => void;
    /** Called after an explosion may have changed kill count, to refresh the HUD. */
    onChange: () => void;
}

export interface GrenadeDeps {
    engine: EngineContext;
    scene: SceneContext;
    physics: QuakePhysics;
    monsters: MonsterSystem;
    palette: Palette;
    lightTex: Texture2D;
    whiteUV: [number, number];
}

interface Grenade {
    active: boolean;
    pos: V3;
    vel: V3;
    fuse: number;
    spin: number;
    bounceCd: number; // throttle bounce sfx
    mesh: Mesh;
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class GrenadeSystem {
    private readonly grenades: Grenade[] = [];

    constructor(
        private readonly deps: GrenadeDeps,
        private readonly hooks: GrenadeHooks
    ) {}

    async load(): Promise<void> {
        const res = await fetch(MODEL_URL);
        if (!res.ok) throw new Error(`Failed to fetch ${MODEL_URL}: ${res.status}`);
        const model = parseMdl(await res.arrayBuffer(), this.deps.palette);
        const corners = model.indices.length;
        const pos = new Float32Array(corners * 3);
        expandFrame(model, 0, pos);
        const uv2 = new Float32Array(corners * 2);
        for (let i = 0; i < corners; i++) {
            uv2[i * 2] = this.deps.whiteUV[0];
            uv2[i * 2 + 1] = this.deps.whiteUV[1];
        }
        const skinTex = createTexture2DFromPixels(this.deps.engine, model.skinRgba, model.skinWidth, model.skinHeight, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            minFilter: "linear",
            magFilter: "linear",
        });
        // One shared material; each pooled grenade gets its own mesh (own transform).
        for (let i = 0; i < POOL; i++) {
            const mesh = createMeshFromData(this.deps.engine, `grenade_${i}`, pos.slice(), new Float32Array(corners * 3), model.indices.slice(), model.uvs.slice(), uv2.slice());
            mesh.material = createQuakeMaterial(`grenadeMat_${i}`, skinTex, this.deps.lightTex);
            addToScene(this.deps.scene, mesh);
            setMeshVisible(mesh, false);
            this.grenades.push({ active: false, pos: [0, 0, 0], vel: [0, 0, 0], fuse: 0, spin: 0, bounceCd: 0, mesh });
        }
    }

    /** Launch a grenade from the eye along `dir` (unit, Quake space). Returns
     *  false if the pool is exhausted so the caller can skip ammo deduction. */
    launch(eye: V3, dir: V3): boolean {
        const g = this.grenades.find((x) => !x.active);
        if (!g) return false;
        g.active = true;
        g.pos = [eye[0], eye[1], eye[2]];
        g.vel = [dir[0] * LAUNCH_SPEED, dir[1] * LAUNCH_SPEED, dir[2] * LAUNCH_SPEED + LAUNCH_UP];
        g.fuse = FUSE;
        g.spin = 0;
        g.bounceCd = 0;
        setMeshVisible(g.mesh, true);
        this.place(g);
        return true;
    }

    private place(g: Grenade): void {
        const [ex, ey, ez] = quakeToEngine(g.pos[0], g.pos[1], g.pos[2]);
        g.mesh.position.set(ex, ey, ez);
        g.mesh.rotation.set(g.spin, g.spin * 0.7, 0);
    }

    update(dt: number): void {
        let exploded = false;
        for (const g of this.grenades) {
            if (!g.active) continue;
            g.vel[2] -= GRAVITY * dt;
            g.bounceCd = Math.max(0, g.bounceCd - dt);

            // Sub-stepped bounce trace: move the remaining frame time, reflecting
            // off each surface, up to a few bounces per frame.
            let remaining = dt;
            for (let iter = 0; iter < 4 && remaining > 1e-4; iter++) {
                const end: V3 = [g.pos[0] + g.vel[0] * remaining, g.pos[1] + g.vel[1] * remaining, g.pos[2] + g.vel[2] * remaining];
                const tr = this.deps.physics.castMove(g.pos, end);
                g.pos = [tr.endpos[0], tr.endpos[1], tr.endpos[2]];
                if (tr.fraction >= 1 || !tr.normal) break;
                const n = tr.normal;
                // Nudge off the surface, then reflect velocity (Quake ClipVelocity).
                g.pos = [g.pos[0] + n[0] * 0.1, g.pos[1] + n[1] * 0.1, g.pos[2] + n[2] * 0.1];
                const backoff = dot(g.vel, n) * BOUNCE;
                g.vel = [g.vel[0] - n[0] * backoff, g.vel[1] - n[1] * backoff, g.vel[2] - n[2] * backoff];
                if (g.bounceCd <= 0) {
                    this.hooks.sound("weapons/bounce.wav", g.pos);
                    g.bounceCd = 0.1;
                }
                remaining *= 1 - tr.fraction;
            }

            g.spin += dt * 12;
            this.place(g);

            g.fuse -= dt;
            if (g.fuse <= 0 || this.deps.monsters.hasLiveMonsterWithin(g.pos, TOUCH_RADIUS)) {
                this.explode(g);
                exploded = true;
            }
        }
        if (exploded) this.hooks.onChange();
    }

    private explode(g: Grenade): void {
        g.active = false;
        setMeshVisible(g.mesh, false);
        this.deps.monsters.radiusDamage(g.pos, EXPLODE_RADIUS, EXPLODE_DAMAGE);
        this.hooks.playerSplash(g.pos, EXPLODE_RADIUS, EXPLODE_DAMAGE);
        this.hooks.explosion(g.pos);
        this.hooks.sound("weapons/r_exp3.wav", g.pos);
    }
}
