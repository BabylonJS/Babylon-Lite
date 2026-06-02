// Passive blocky mobs (cow, pig, sheep, chicken) for the creative sandbox.
//
// Each mob is assembled from axis-aligned boxes — exactly the Minecraft mob recipe:
// a body, a head, and legs — but built entirely procedurally so we ship ZERO animal
// art (the CC0 voxel pack has none). Parts are separate meshes parented to a root
// TransformNode; the root is positioned/yawed to place and face the mob, while the
// leg meshes rotate about their hip pivots for a walk cycle and the body bobs. Solid
// colours come from a per-vertex-albedo mob material (see mob-material.ts), lit by
// the same day-night sun as the terrain.
//
// Pure public-API: createTransformNode + createMeshFromData + addToScene /
// removeFromScene, the same surface used by falling-blocks. No engine internals.

import { addToScene, createMeshFromData, createTransformNode, removeFromScene, type EngineContext, type Mesh, type SceneContext, type ShaderMaterial, type TransformNode } from "babylon-lite";

import { Block, blockDef } from "./blocks.js";
import { WORLD_H } from "./constants.js";
import { createMobMaterial, setMobLighting, type MobMaterialOptions } from "./mob-material.js";
import type { World } from "./world.js";

type Vec3 = [number, number, number];

// ─── Mob model description ───────────────────────────────────────────────────

type Joint = "body" | "head" | "legFL" | "legFR" | "legBL" | "legBR" | "legL" | "legR" | "wing";

interface BoxDef {
    min: Vec3;
    max: Vec3;
    color: Vec3;
}

interface PartDef {
    joint: Joint;
    /** Pivot (joint) position in the mob's local frame, feet on the ground at y=0,
     *  facing +Z. Part geometry is given relative to this pivot. */
    pivot: Vec3;
    boxes: BoxDef[];
}

interface SpeciesDef {
    name: string;
    parts: PartDef[];
    /** Walk speed in blocks/sec. */
    speed: number;
    /** Leg-swing amplitude (radians) at full walk. */
    swing: number;
    /** Vertical bob amplitude while walking (blocks). */
    bob: number;
}

// ─── Geometry helper ─────────────────────────────────────────────────────────

const FACE_N: Vec3[] = [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
];
// Four corners of each face as (min/max picks) — listed so winding faces outward.
const FACE_CORNERS: number[][][] = [
    // +Y
    [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
    // -Y
    [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
    // +X
    [[1, 0, 1], [1, 1, 1], [1, 1, 0], [1, 0, 0]],
    // -X
    [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]],
    // +Z
    [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]],
    // -Z
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
];

interface MeshArrays {
    pos: number[];
    nrm: number[];
    col: number[];
    idx: number[];
}

function addBox(a: MeshArrays, b: BoxDef): void {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    for (let f = 0; f < 6; f++) {
        const base = a.pos.length / 3;
        const n = FACE_N[f]!;
        for (const c of FACE_CORNERS[f]!) {
            a.pos.push(c[0] ? x1 : x0, c[1] ? y1 : y0, c[2] ? z1 : z0);
            a.nrm.push(n[0], n[1], n[2]);
            a.col.push(b.color[0], b.color[1], b.color[2], 1);
        }
        a.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

// ─── Species ─────────────────────────────────────────────────────────────────

/** Build a generic quadruped (cow/pig/sheep) from tunable proportions + palette. */
function quadruped(
    name: string,
    dims: { legLen: number; legW: number; bodyW: number; bodyH: number; bodyL: number; headSize: number },
    palette: { body: Vec3; head: Vec3; leg: Vec3; snout?: Vec3; snoutColor?: Vec3; belly?: Vec3 },
    motion: { speed: number; swing: number; bob: number }
): SpeciesDef {
    const { legLen, legW, bodyW, bodyH, bodyL, headSize } = dims;
    const bodyY = legLen + bodyH / 2;
    const hx = bodyW / 2 - legW / 2;
    const hz = bodyL / 2 - legW / 2;
    const hs = headSize;

    const bodyBoxes: BoxDef[] = [
        { min: [-bodyW / 2, -bodyH / 2, -bodyL / 2], max: [bodyW / 2, bodyH / 2, bodyL / 2], color: palette.body },
    ];
    if (palette.belly) {
        bodyBoxes.push({ min: [-bodyW / 2 + 0.02, -bodyH / 2 - 0.01, -bodyL / 2 + 0.1], max: [bodyW / 2 - 0.02, -bodyH / 2 + 0.12, bodyL / 2 - 0.1], color: palette.belly });
    }
    // Small tail nub at the back-top.
    bodyBoxes.push({ min: [-0.05, bodyH / 2 - 0.18, -bodyL / 2 - 0.1], max: [0.05, bodyH / 2 - 0.02, -bodyL / 2], color: palette.leg });

    const headBoxes: BoxDef[] = [{ min: [-hs / 2, -hs * 0.45, 0], max: [hs / 2, hs * 0.55, hs], color: palette.head }];
    if (palette.snout && palette.snoutColor) {
        headBoxes.push({ min: [-hs * 0.32, -hs * 0.35, hs - 0.02], max: [hs * 0.32, hs * 0.18, hs + palette.snout[2]], color: palette.snoutColor });
    }
    // Ears.
    headBoxes.push({ min: [-hs / 2 - 0.05, hs * 0.4, hs * 0.2], max: [-hs / 2 + 0.04, hs * 0.62, hs * 0.45], color: palette.head });
    headBoxes.push({ min: [hs / 2 - 0.04, hs * 0.4, hs * 0.2], max: [hs / 2 + 0.05, hs * 0.62, hs * 0.45], color: palette.head });

    const legBox: BoxDef = { min: [-legW / 2, -legLen, -legW / 2], max: [legW / 2, 0, legW / 2], color: palette.leg };

    return {
        name,
        speed: motion.speed,
        swing: motion.swing,
        bob: motion.bob,
        parts: [
            { joint: "body", pivot: [0, bodyY, 0], boxes: bodyBoxes },
            { joint: "head", pivot: [0, bodyY + bodyH * 0.15, bodyL / 2], boxes: headBoxes },
            { joint: "legFL", pivot: [hx, legLen, hz], boxes: [legBox] },
            { joint: "legFR", pivot: [-hx, legLen, hz], boxes: [legBox] },
            { joint: "legBL", pivot: [hx, legLen, -hz], boxes: [legBox] },
            { joint: "legBR", pivot: [-hx, legLen, -hz], boxes: [legBox] },
        ],
    };
}

function chicken(): SpeciesDef {
    const white: Vec3 = [0.95, 0.95, 0.92];
    const beak: Vec3 = [0.95, 0.66, 0.18];
    const legCol: Vec3 = [0.9, 0.62, 0.15];
    const red: Vec3 = [0.82, 0.18, 0.16];
    const legLen = 0.22;
    const bodyY = legLen + 0.16;
    const headBoxes: BoxDef[] = [
        { min: [-0.12, -0.1, 0], max: [0.12, 0.14, 0.2], color: white }, // head
        { min: [-0.05, -0.02, 0.2], max: [0.05, 0.06, 0.31], color: beak }, // beak
        { min: [-0.05, 0.14, 0.04], max: [0.05, 0.22, 0.12], color: red }, // comb
        { min: [-0.05, -0.14, 0.05], max: [0.05, -0.06, 0.12], color: red }, // wattle
    ];
    return {
        name: "chicken",
        speed: 1.3,
        swing: 0.7,
        bob: 0.05,
        parts: [
            { joint: "body", pivot: [0, bodyY, 0], boxes: [{ min: [-0.16, -0.16, -0.2], max: [0.16, 0.18, 0.18], color: white }] },
            { joint: "wing", pivot: [0.16, bodyY + 0.02, 0], boxes: [{ min: [0, -0.13, -0.16], max: [0.05, 0.12, 0.12], color: white }] },
            { joint: "wing", pivot: [-0.16, bodyY + 0.02, 0], boxes: [{ min: [-0.05, -0.13, -0.16], max: [0, 0.12, 0.12], color: white }] },
            { joint: "head", pivot: [0, bodyY + 0.16, 0.06], boxes: headBoxes },
            { joint: "legL", pivot: [0.07, legLen, 0], boxes: [{ min: [-0.025, -legLen, -0.025], max: [0.025, 0, 0.025], color: legCol }] },
            { joint: "legR", pivot: [-0.07, legLen, 0], boxes: [{ min: [-0.025, -legLen, -0.025], max: [0.025, 0, 0.025], color: legCol }] },
        ],
    };
}

function speciesList(): SpeciesDef[] {
    return [
        quadruped(
            "cow",
            { legLen: 0.55, legW: 0.17, bodyW: 0.56, bodyH: 0.5, bodyL: 0.95, headSize: 0.42 },
            { body: [0.4, 0.27, 0.17], head: [0.32, 0.21, 0.13], leg: [0.21, 0.15, 0.1], snout: [0, 0, 0.08], snoutColor: [0.83, 0.66, 0.64], belly: [0.86, 0.83, 0.75] },
            { speed: 1.0, swing: 0.55, bob: 0.05 }
        ),
        quadruped(
            "pig",
            { legLen: 0.4, legW: 0.17, bodyW: 0.52, bodyH: 0.46, bodyL: 0.85, headSize: 0.4 },
            { body: [0.92, 0.59, 0.61], head: [0.9, 0.56, 0.58], leg: [0.82, 0.48, 0.5], snout: [0, 0, 0.07], snoutColor: [0.76, 0.4, 0.44] },
            { speed: 1.1, swing: 0.5, bob: 0.045 }
        ),
        quadruped(
            "sheep",
            { legLen: 0.5, legW: 0.16, bodyW: 0.62, bodyH: 0.62, bodyL: 0.92, headSize: 0.34 },
            { body: [0.92, 0.92, 0.88], head: [0.34, 0.29, 0.27], leg: [0.31, 0.27, 0.25] },
            { speed: 0.95, swing: 0.45, bob: 0.04 }
        ),
        chicken(),
    ];
}

// ─── Runtime mob ─────────────────────────────────────────────────────────────

interface Part {
    joint: Joint;
    mesh: Mesh;
}

interface Mob {
    species: SpeciesDef;
    root: TransformNode;
    parts: Part[];
    x: number;
    y: number; // feet (ground) world Y
    z: number;
    yaw: number;
    vy: number;
    onGround: boolean;
    state: "idle" | "walk";
    stateT: number;
    gait: number; // walk-cycle phase
    amp: number; // eased swing amplitude (0..1)
    turnTo: number; // target yaw
}

const GRAVITY = 24;
const MAX_FALL = 40;
const MAX_MOBS = 10;
const INITIAL_MOBS = 6;
const SPAWN_MIN = 10;
const SPAWN_MAX = 44;
const DESPAWN_DIST = 96;
const SPAWN_INTERVAL = 1.4; // seconds between spawn attempts

export class Mobs {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly world: World;
    private readonly material: ShaderMaterial;
    private readonly species = speciesList();
    private readonly mobs: Mob[] = [];
    private counter = 0;
    private spawnT = 0;
    private seeded = false;

    constructor(engine: EngineContext, scene: SceneContext, world: World, matOpts: MobMaterialOptions = {}) {
        this.engine = engine;
        this.scene = scene;
        this.world = world;
        this.material = createMobMaterial("mc_mob", matOpts);
    }

    /** Number of live mobs (exposed for the F3 debug HUD). */
    get count(): number {
        return this.mobs.length;
    }

    /** Push the day-night lighting (called once per frame). */
    setLighting(sunDir: Vec3, sunColor: Vec3, ambient: Vec3, fog: Vec3): void {
        setMobLighting(this.material, sunDir, sunColor, ambient, fog);
    }

    private collidable(x: number, y: number, z: number): boolean {
        if (y < 0) return true;
        if (y >= WORLD_H) return false;
        const d = blockDef(this.world.getBlock(Math.floor(x), y, Math.floor(z)));
        return !!d && d.collidable;
    }

    /** Y of the standable surface (top face) at column (x,z) near height fromY. */
    private groundY(x: number, z: number, fromY: number): number {
        let c = Math.floor(fromY + 0.001);
        if (c >= WORLD_H) c = WORLD_H - 1;
        // Rise out of any solid we're embedded in.
        while (c < WORLD_H && this.collidable(x, c, z)) c++;
        // Fall to the first solid below.
        while (c > 0 && !this.collidable(x, c - 1, z)) c--;
        return c;
    }

    /** Build a mob's meshes parented to a root and add it to the scene. */
    private build(species: SpeciesDef, x: number, y: number, z: number, yaw: number): Mob {
        const root = createTransformNode(`mc_mob_${this.counter++}`);
        const parts: Part[] = [];
        for (const pd of species.parts) {
            const a: MeshArrays = { pos: [], nrm: [], col: [], idx: [] };
            for (const b of pd.boxes) addBox(a, b);
            const mesh = createMeshFromData(
                this.engine,
                `${root.name}_${pd.joint}`,
                new Float32Array(a.pos),
                new Float32Array(a.nrm),
                new Uint32Array(a.idx),
                undefined,
                undefined,
                undefined,
                new Float32Array(a.col)
            );
            mesh.material = this.material;
            mesh.position.x = pd.pivot[0];
            mesh.position.y = pd.pivot[1];
            mesh.position.z = pd.pivot[2];
            mesh.parent = root;
            root.children.push(mesh);
            parts.push({ joint: pd.joint, mesh });
        }
        addToScene(this.scene, root);
        const mob: Mob = { species, root, parts, x, y, z, yaw, vy: 0, onGround: false, state: "idle", stateT: 1 + Math.random() * 2, gait: 0, amp: 0, turnTo: yaw };
        this.writeTransforms(mob, 0);
        return mob;
    }

    /** True if (wx,wz) is a clear grazing surface (solid ground, 2 air above). */
    private spawnSpot(wx: number, wz: number): number | null {
        const top = this.world.surfaceY(wx, wz);
        if (top < 1) return null;
        const ground = this.world.getBlock(wx, top, wz);
        if (ground !== Block.GRASS && ground !== Block.SAND && ground !== Block.SNOW && ground !== Block.DIRT) return null;
        if (this.world.getBlock(wx, top + 1, wz) !== Block.AIR) return null;
        if (this.world.getBlock(wx, top + 2, wz) !== Block.AIR) return null;
        return top + 1;
    }

    private trySpawn(px: number, pz: number): void {
        const ang = Math.random() * Math.PI * 2;
        const r = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
        const wx = Math.floor(px + Math.cos(ang) * r);
        const wz = Math.floor(pz + Math.sin(ang) * r);
        const feetY = this.spawnSpot(wx, wz);
        if (feetY === null) return;
        const species = this.species[Math.floor(Math.random() * this.species.length)]!;
        this.mobs.push(this.build(species, wx + 0.5, feetY, wz + 0.5, Math.random() * Math.PI * 2));
    }

    private despawn(mob: Mob): void {
        for (const p of mob.parts) removeFromScene(this.scene, p.mesh);
    }

    /** Despawn every mob and re-seed near the player on the next update (used when
     *  reloading the world). */
    reset(): void {
        for (const mob of this.mobs) this.despawn(mob);
        this.mobs.length = 0;
        this.seeded = false;
        this.spawnT = 0;
    }

    update(dt: number, playerPos: Vec3): void {
        const [px, , pz] = playerPos;

        // Seed an initial herd near the player on the first frame so the world feels
        // alive immediately instead of waiting for the trickle spawner to catch up.
        if (!this.seeded) {
            this.seeded = true;
            for (let tries = 0; tries < 40 && this.mobs.length < INITIAL_MOBS; tries++) this.trySpawn(px, pz);
        }

        // Spawn budget: keep a small population around the player.
        this.spawnT -= dt;
        if (this.spawnT <= 0) {
            this.spawnT = SPAWN_INTERVAL;
            if (this.mobs.length < MAX_MOBS) this.trySpawn(px, pz);
        }

        for (let i = this.mobs.length - 1; i >= 0; i--) {
            const mob = this.mobs[i]!;
            const dx = mob.x - px;
            const dz = mob.z - pz;
            if (Math.hypot(dx, dz) > DESPAWN_DIST) {
                this.despawn(mob);
                this.mobs.splice(i, 1);
                continue;
            }
            this.stepMob(mob, dt);
        }
    }

    private stepMob(mob: Mob, dt: number): void {
        // ── AI: alternate idle / walk, choosing a new heading when entering walk. ──
        mob.stateT -= dt;
        if (mob.stateT <= 0) {
            if (mob.state === "idle") {
                mob.state = "walk";
                mob.stateT = 2 + Math.random() * 4;
                mob.turnTo = Math.random() * Math.PI * 2;
            } else {
                mob.state = "idle";
                mob.stateT = 1.5 + Math.random() * 3;
            }
        }

        // Ease yaw toward the target heading.
        let dyaw = mob.turnTo - mob.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        mob.yaw += dyaw * Math.min(1, dt * 6);

        const walking = mob.state === "walk";
        // Ease swing amplitude so starts/stops aren't snappy.
        mob.amp += ((walking ? 1 : 0) - mob.amp) * Math.min(1, dt * 8);

        if (walking) {
            const dirX = Math.sin(mob.yaw);
            const dirZ = Math.cos(mob.yaw);
            const step = mob.species.speed * dt;
            const nx = mob.x + dirX * step;
            const nz = mob.z + dirZ * step;
            if (this.canStand(nx, nz, mob)) {
                mob.x = nx;
                mob.z = nz;
            } else {
                // Blocked / ledge / water ahead: turn and idle briefly.
                mob.turnTo = mob.yaw + (Math.random() < 0.5 ? 1 : -1) * (Math.PI * 0.4 + Math.random() * Math.PI * 0.4);
                mob.state = "idle";
                mob.stateT = 0.4 + Math.random();
            }
            mob.gait += dt * 8;
        } else {
            mob.gait += dt * 1.5; // gentle idle breathing
        }

        // ── Physics: gravity + ground snap (with 1-block step-up handled in canStand). ──
        const rest = this.groundY(mob.x, mob.z, mob.y);
        mob.vy = Math.max(mob.vy - GRAVITY * dt, -MAX_FALL);
        let ny = mob.y + mob.vy * dt;
        if (ny <= rest) {
            ny = rest;
            mob.vy = 0;
            mob.onGround = true;
        } else {
            mob.onGround = false;
        }
        mob.y = Math.max(1, Math.min(WORLD_H - 1, ny));

        this.writeTransforms(mob, dt);
    }

    /** Can the mob stand at (nx,nz)? Allows a 1-block step up, rejects >1 drops,
     *  walls, and water/lava so animals graze on dry land. */
    private canStand(nx: number, nz: number, mob: Mob): boolean {
        const surf = this.groundY(nx, nz, mob.y + 1.1);
        if (surf - mob.y > 1.01) return false; // wall / too-high step
        if (mob.y - surf > 1.6) return false; // ledge / cliff
        // Two blocks of clear space above the destination surface (body room).
        if (this.collidable(nx, surf, nz) || this.collidable(nx, surf + 1, nz)) return false;
        // Refuse to wade into liquids.
        const fx = Math.floor(nx);
        const fz = Math.floor(nz);
        if (this.world.getBlock(fx, surf, fz) === Block.WATER) return false;
        if (this.world.getBlock(fx, surf - 1, fz) === Block.WATER) return false;
        return true;
    }

    /** Place the root + animate the parts for the current frame. */
    private writeTransforms(mob: Mob, dt: number): void {
        void dt;
        const s = mob.species;
        const bob = mob.amp * Math.abs(Math.sin(mob.gait)) * s.bob;
        mob.root.position.x = mob.x;
        mob.root.position.y = mob.y + bob;
        mob.root.position.z = mob.z;
        mob.root.rotation.set(0, mob.yaw, 0);

        const swing = mob.amp * s.swing;
        const a = Math.sin(mob.gait) * swing;
        const b = Math.sin(mob.gait + Math.PI) * swing;
        for (const p of mob.parts) {
            switch (p.joint) {
                case "legFL":
                case "legBR":
                case "legL":
                    p.mesh.rotation.set(a, 0, 0);
                    break;
                case "legFR":
                case "legBL":
                case "legR":
                    p.mesh.rotation.set(b, 0, 0);
                    break;
                case "head":
                    p.mesh.rotation.set(Math.sin(mob.gait * 0.5) * 0.05 * (mob.amp + 0.3), 0, 0);
                    break;
                case "wing":
                    p.mesh.rotation.set(0, 0, Math.sin(mob.gait * 1.5) * 0.3 * mob.amp);
                    break;
                default:
                    break;
            }
        }
    }
}
