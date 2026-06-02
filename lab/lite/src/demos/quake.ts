/**
 * LibreQuake demo — E1M1, playable.
 *
 * Fetches the LibreQuake first-level BSP (BSD-3-Clause free game data, lazy-loaded
 * as a static asset — never bundled into JS), parses it clean-room from the
 * publicly documented Quake BSP v29 format, rebuilds the level geometry with
 * embedded textures and grayscale BSP lightmaps, simulates Quake player physics
 * against the BSP collision hulls, and runs a clean-room reimplementation of the
 * map entity logic (doors, buttons, lifts, triggers, teleporters, item pickups).
 *
 * Controls: WASD / arrows to move, mouse-drag to look, Space to jump.
 *
 * Asset license: LibreQuake (https://github.com/lavenderdotpet/LibreQuake), BSD-3-Clause.
 * Run `pnpm fetch:librequake` to download the data into lab/public/librequake/.
 */

import {
    addToScene,
    createBox,
    createEngine,
    createFreeCamera,
    createMeshFromData,
    createSceneContext,
    createStandardMaterial,
    createTexture2DFromPixels,
    onBeforeRender,
    registerScene,
    setMeshVisible,
    setShaderUniform,
    startEngine,
    type Mesh,
    type ShaderMaterial,
} from "babylon-lite";

import { parseBsp } from "./quake/bsp/parse-bsp.js";
import { parsePalette, type Palette } from "./quake/palette.js";
import { parseEntities, parseVec3, filterEntitiesBySkill } from "./quake/entities/parse-entities.js";
import { buildLevelGeometry, buildModelGeometry, quakeToEngine, type GeometryBatch } from "./quake/geometry/build-geometry.js";
import { QuakeTextureCache } from "./quake/render/texture-cache.js";
import { createQuakeMaterial } from "./quake/render/quake-material.js";
import { createSkyMaterial, createSkyTexture } from "./quake/render/sky-material.js";
import { QuakePhysics, type MoveInput } from "./quake/physics/collision.js";
import { MoverSystem, type WorldEnt } from "./quake/entities/mover-system.js";
import { MonsterSystem } from "./quake/combat/monsters.js";
import { Viewmodel } from "./quake/render/viewmodel.js";
import { GrenadeSystem } from "./quake/combat/grenades.js";
import { WEAPONS, WEAPON_ORDER, WEAPON_PICKUPS, type WeaponId, type AmmoType } from "./quake/combat/weapons.js";
import { spawnItemModels, type SpawnedItem } from "./quake/render/items.js";
import { QuakeSound } from "./quake/audio/sound.js";
import { SbarHud } from "./quake/hud/sbar.js";
import { demoAssetUrl } from "./demo-asset-url.js";

const BSP_URL = demoAssetUrl("./librequake/lq_e1m1.bsp", import.meta.url);
const PALETTE_URL = demoAssetUrl("./librequake/palette.lmp", import.meta.url);
const MOVE_SPEED = 320; // Quake units / second
const LOOK_SENS = 0.0022;
const MAX_FRAME = 0.05;

const MOVER_KINDS = new Set(["door", "secret", "button", "plat"]);

// Quake doors are authored as a func_wall backing plus two sliding func_door
// leaves, all roughly coplanar — and the two leaves themselves overlap in the
// closed position. Coplanar faces at equal depth z-fight, so we push each brush
// model out along its face normals by a per-model amount with two properties:
//  1. Role tiers — movers (visible door leaves) sit proud of static brush
//     (func_wall backing), which sits proud of the world. Order: mover>brush>world.
//  2. A hashed per-model jitter inside each tier so coplanar siblings (the two
//     leaves, or a leaf vs its backing) never share a depth. A door's models are
//     authored with consecutive indices, and (idx*7)%16 maps consecutive indices
//     ~0.28 units apart — maximal separation exactly where it's needed. The only
//     collision (indices 16 apart) cannot occur for a door set, whose models are
//     adjacent, so same-tier siblings are always separated.
// All offsets are a couple of units at most — sub-pixel at gameplay distances and
// well inside the door's own thickness, so collision (BSP hulls) is unaffected.
const BRUSH_BASE_NUDGE = 0.4;
const brushNudge = (modelIndex: number): number => BRUSH_BASE_NUDGE + ((modelIndex * 7) % 16) * 0.04;

// Movers render solid (zero geometry nudge) and instead win coplanar depth ties
// via a per-model depth pull toward the camera. Unlike the geometric brushNudge,
// the pull is applied in clip space by the quake material as `DEPTH_BIAS / w`,
// which (see quake-material.ts) yields a CONSTANT view-space pull of
// `DEPTH_BIAS / near` world units at every distance — so the value below is the
// pull in world units multiplied by the camera near plane (fixed at 1 for this
// demo). The base keeps leaves in front of the world / func_wall backing (whose
// geometric nudge tops out at ~1 unit); the per-model jitter separates coplanar
// sibling leaves so they don't z-fight each other. Kept comfortably below the
// recess depth of inset buttons/torches so those stay correctly behind the wall.
const MOVER_CAMERA_NEAR = 1; // matches cam.nearPlane; pull(world) = bias / near.
const MOVER_PULL_BASE = 1.1; // world units of toward-camera pull for a closed leaf.
const moverDepthBias = (modelIndex: number): number => (MOVER_PULL_BASE + ((modelIndex * 7) % 16) * 0.02) * MOVER_CAMERA_NEAR;

const START_SHELLS = 25;
const START_NAILS = 0;
const START_ROCKETS = 0;
const START_HEALTH = 100;
const ITEM_PICKUP_RADIUS = 48; // Quake item touch range (player half-width + item).
const ITEM_PICKUP_HEIGHT = 56; // vertical reach: player box + item height overlap.
const ITEM_SPIN_SPEED = 1.6; // radians/sec — Quake-3-style pickup rotation.

const STEPSIZE = 18; // Quake STEPSIZE — must match physics; used for view-Z stair smoothing.
const STAIR_SMOOTH_SPEED = 180; // units/sec the smoothed eye catches up after a step-up.

// Liquid leaf contents (Quake): water=-3, slime=-4, lava=-5.
const CONTENTS_SLIME = -4;
const CONTENTS_LAVA = -5;
const ENVIROSUIT_TIME = 30; // seconds of liquid immunity from the environment suit.

type Engine = Awaited<ReturnType<typeof createEngine>>;

interface View {
    yaw: number;
    pitch: number;
}

interface Player {
    health: number;
    armor: number;
    shells: number;
    nails: number;
    rockets: number;
    weapon: WeaponId;
    owned: Set<WeaponId>;
    dead: boolean;
    godmode: boolean;
    suitTime: number;
}

async function fetchBytes(url: string, hint: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}. ${hint}`);
    return res.arrayBuffer();
}

/** Append one model's per-texture batches into a shared batch map, rebasing indices. */
function mergeBatches(dest: Map<number, GeometryBatch>, src: Map<number, GeometryBatch>): void {
    for (const [miptex, b] of src) {
        let d = dest.get(miptex);
        if (!d) {
            d = { miptex, pos: [], uv: [], uv2: [], idx: [] };
            dest.set(miptex, d);
        }
        const base = d.pos.length / 3;
        for (const v of b.pos) d.pos.push(v);
        for (const v of b.uv) d.uv.push(v);
        for (const v of b.uv2) d.uv2.push(v);
        for (const idx of b.idx) d.idx.push(idx + base);
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.05, b: 0.07, a: 1 };

    const hint = "Run `pnpm fetch:librequake`.";
    const [bspBytes, palBytes] = await Promise.all([fetchBytes(BSP_URL, hint), fetchBytes(PALETTE_URL, hint)]);

    const bsp = parseBsp(bspBytes);
    const palette = parsePalette(palBytes);
    const params = new URLSearchParams(location.search);
    // Apply Quake's skill/deathmatch entity culling (default skill 1 = Normal).
    // Without this, deathmatch-only brushes seal the single-player spawn.
    const skillParam = Number(params.get("skill"));
    const skill = Number.isFinite(skillParam) && params.get("skill") !== null ? skillParam : 1;
    const entities = filterEntitiesBySkill(parseEntities(bsp.entities), skill);

    const textures = new QuakeTextureCache(engine, bsp.mipTextures, palette);

    // World geometry (model 0) seeds the shared lightmap atlas.
    const { batches: worldBatches, atlas } = buildLevelGeometry(bsp);

    // Player physics + clean-room entity logic. Constructing the mover system
    // registers solid brush hulls into the physics world.
    const start = entities.find((e) => e.classname === "info_player_start") ?? entities.find((e) => e.classname?.startsWith("info_player"));
    const origin = parseVec3(start?.origin);
    const view: View = { yaw: ((start?.angle ? Number(start.angle) : 0) * Math.PI) / 180, pitch: 0 };
    // Optional dev override: ?spawn=x,y,z&yaw=deg
    const spawnParam = params.get("spawn");
    if (spawnParam) {
        const p = spawnParam.split(",").map(Number);
        if (p.length === 3 && p.every((n) => Number.isFinite(n))) {
            origin[0] = p[0]!;
            origin[1] = p[1]!;
            origin[2] = p[2]!;
        }
    }
    const yawParam = params.get("yaw");
    if (yawParam && Number.isFinite(Number(yawParam))) view.yaw = (Number(yawParam) * Math.PI) / 180;
    const physics = new QuakePhysics(bsp, [origin[0], origin[1], origin[2]]);

    const hud = await createHud(palette);
    const sound = new QuakeSound();
    sound.preload([
        "weapons/guncock.wav",
        "weapons/shotgn2.wav",
        "weapons/grenade.wav",
        "weapons/bounce.wav",
        "weapons/r_exp3.wav",
        "weapons/lock4.wav",
        "weapons/pkup.wav",
        "items/health1.wav",
        "items/armor1.wav",
        "player/pain1.wav",
        "player/pain2.wav",
        "soldier/sight1.wav",
    ]);
    // Brush entities removed via killtarget (forcefields, hidden walls) must be
    // hideable, so collect every killtarget name up-front and render those brush
    // models as their own meshes instead of baking them into the static world.
    const killTargetNames = new Set<string>();
    for (const e of entities) if (e.killtarget) killTargetNames.add(e.killtarget);
    const moverMeshes = new Map<WorldEnt, Mesh[]>();
    const killableMeshes = new Map<WorldEnt, Mesh[]>();

    const movers = new MoverSystem(bsp, entities, physics, {
        message: (m) => hud.message(m),
        complete: (map) => hud.complete(map),
        teleport: (yaw) => {
            view.yaw = yaw;
        },
        sound: (path, origin) => sound.play(path, { origin }),
        kill: (ent) => {
            for (const m of moverMeshes.get(ent) ?? []) setMeshVisible(m, false);
            for (const m of killableMeshes.get(ent) ?? []) setMeshVisible(m, false);
        },
    });

    // Brush-entity geometry. Movers (doors/buttons/lifts) and killable brushes get
    // their own meshes so we can translate or hide them; every other brush model
    // (func_wall, func_illusionary, func_detail …) is merged into the static world.
    const moverBatches: { ent: WorldEnt; batches: Map<number, GeometryBatch> }[] = [];
    const killableBatches: { ent: WorldEnt; batches: Map<number, GeometryBatch> }[] = [];
    for (const ent of movers.ents) {
        if (ent.modelIndex < 0) continue;
        const model = bsp.models[ent.modelIndex];
        if (!model) continue;
        const isMover = MOVER_KINDS.has(ent.kind);
        const isKillable = !isMover && !!ent.targetname && killTargetNames.has(ent.targetname);
        const nudge = isMover ? 0 : brushNudge(ent.modelIndex);
        const batches = buildModelGeometry(bsp, atlas, model.firstFace, model.numFaces, nudge);
        if (isMover) moverBatches.push({ ent, batches });
        else if (isKillable) killableBatches.push({ ent, batches });
        else mergeBatches(worldBatches, batches);
    }

    // All atlas allocations are done — upload the lightmap once.
    const lightTex = createTexture2DFromPixels(engine, atlas.pixels, atlas.width, atlas.height, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        minFilter: "linear",
        magFilter: "linear",
    });

    // Sky surfaces (texture name "sky*") get the animated Quake dome shader instead
    // of a flat-mapped texture; build its texture once and collect the materials so
    // their scroll time can be advanced each frame.
    const skyMipIndex = bsp.mipTextures.findIndex((m) => m && m.name.toLowerCase().startsWith("sky") && m.indices);
    const skyTex = skyMipIndex >= 0 ? createSkyTexture(engine, bsp.mipTextures[skyMipIndex]!, palette) : null;
    const skyMaterials: ShaderMaterial[] = [];

    let matId = 0;
    let drawn = 0;
    const makeMeshes = (batches: Map<number, GeometryBatch>, tag: string, depthBias = 0): Mesh[] => {
        const meshes: Mesh[] = [];
        for (const [miptex, batch] of batches) {
            if (batch.idx.length === 0) continue;
            const mesh = createMeshFromData(
                engine,
                `quake_${tag}_${matId}`,
                new Float32Array(batch.pos),
                new Float32Array(batch.pos.length),
                new Uint32Array(batch.idx),
                new Float32Array(batch.uv),
                new Float32Array(batch.uv2)
            );
            const mtName = bsp.mipTextures[miptex]?.name?.toLowerCase() ?? "";
            if (skyTex && mtName.startsWith("sky")) {
                const skyMat = createSkyMaterial(`quakeSky_${matId}`, skyTex);
                skyMaterials.push(skyMat);
                mesh.material = skyMat;
            } else {
                mesh.material = createQuakeMaterial(`quakeMat_${matId}`, textures.get(miptex).texture, lightTex, depthBias);
            }
            addToScene(scene, mesh);
            meshes.push(mesh);
            drawn++;
            matId++;
        }
        return meshes;
    };

    makeMeshes(worldBatches, "world");
    for (const { ent, batches } of moverBatches) {
        const meshes = makeMeshes(batches, "mover", moverDepthBias(ent.modelIndex));
        const [ex, ey, ez] = quakeToEngine(ent.offset[0], ent.offset[1], ent.offset[2]);
        for (const m of meshes) m.position.set(ex, ey, ez);
        moverMeshes.set(ent, meshes);
    }
    for (const { ent, batches } of killableBatches) {
        const meshes = makeMeshes(batches, "killable");
        killableMeshes.set(ent, meshes);
        if (ent.killed) for (const m of meshes) setMeshVisible(m, false);
    }

    // Pickup items rendered as their real Quake models (inert decorations).
    const items = await spawnItemModels({ engine, scene, palette, lightTex, whiteUV: atlas.whiteUV, physics }, movers.ents);

    // Enemies + combat.
    const godmode = params.get("godmode") !== null && params.get("godmode") !== "0";
    const player: Player = {
        health: START_HEALTH,
        armor: 0,
        shells: START_SHELLS,
        nails: START_NAILS,
        rockets: START_ROCKETS,
        weapon: "shotgun",
        owned: new Set<WeaponId>(["shotgun"]),
        dead: false,
        godmode,
        suitTime: 0,
    };
    const monsters = new MonsterSystem(engine, scene, physics, lightTex, atlas.whiteUV, palette, {
        damage: (amount) => {
            hurtPlayer(player, amount, hud, sound);
            hud.setStats(player, monsters.kills, monsters.total);
        },
        message: (m) => hud.message(m),
        sound: (path, origin) => sound.play(path, { origin }),
    });
    const monsterClasses = new Set<string>();
    for (const e of entities) if (e.classname) monsterClasses.add(e.classname);
    await monsters.load(monsterClasses);
    monsters.spawn(entities);
    hud.setStats(player, monsters.kills, monsters.total);

    // Optional dev override: ?goto=monster teleports the player just in front of
    // the nearest monster and faces it (handy for verifying monster rendering).
    if (params.get("goto") === "monster") {
        const target = monsters.nearestOrigin([origin[0], origin[1], origin[2]]);
        if (target) {
            const eye: [number, number, number] = [target[0], target[1], target[2] + 22];
            const dirs: [number, number][] = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ];
            let px = target[0];
            let py = target[1];
            for (const [dx, dy] of dirs) {
                const to: [number, number, number] = [target[0] + dx * 112, target[1] + dy * 112, eye[2]];
                const tr = physics.castMove(eye, to);
                if (tr.fraction > 0.6) {
                    px = eye[0] + dx * 112 * tr.fraction * 0.9;
                    py = eye[1] + dy * 112 * tr.fraction * 0.9;
                    break;
                }
            }
            physics.origin[0] = px;
            physics.origin[1] = py;
            physics.origin[2] = target[2];
            view.yaw = Math.atan2(target[1] - py, target[0] - px);
        }
    }

    // Optional dev override: ?goto=item[:classfilter] teleports the player to
    // stand facing the nearest matching pickup (mirrors ?goto=monster).
    const gotoItem = params.get("goto");
    if (gotoItem && gotoItem.startsWith("item")) {
        const want = gotoItem.includes(":") ? gotoItem.split(":")[1] : "";
        const cand = movers.ents.filter((e) => e.isItem && (!want || e.cls.includes(want)));
        let best: WorldEnt | undefined;
        let bestD = Infinity;
        for (const e of cand) {
            const d = (e.origin[0] - origin[0]) ** 2 + (e.origin[1] - origin[1]) ** 2 + (e.origin[2] - origin[2]) ** 2;
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        if (best) {
            const drop = physics.castMove([best.origin[0], best.origin[1], best.origin[2]], [best.origin[0], best.origin[1], best.origin[2] - 256]);
            const floorZ = drop.fraction < 1 ? drop.endpos[2] : best.origin[2];
            const aim: [number, number, number] = [best.origin[0], best.origin[1], floorZ + 12];
            const eye: [number, number, number] = [best.origin[0], best.origin[1], floorZ + 40];
            const s = Math.SQRT1_2;
            const dirs: [number, number][] = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
                [s, s],
                [s, -s],
                [-s, s],
                [-s, -s],
            ];
            let px = best.origin[0];
            let py = best.origin[1];
            let bestClear = -1;
            for (const [dx, dy] of dirs) {
                const tr = physics.castMove(eye, [best.origin[0] + dx * 120, best.origin[1] + dy * 120, eye[2]]);
                const clear = 120 * tr.fraction;
                if (clear > bestClear) {
                    bestClear = clear;
                    const stand = Math.max(60, Math.min(110, clear * 0.85));
                    px = best.origin[0] + dx * stand;
                    py = best.origin[1] + dy * stand;
                }
            }
            physics.origin[0] = px;
            physics.origin[1] = py;
            physics.origin[2] = floorZ + 24;
            const eyeZ = floorZ + 24 + 22;
            const horiz = Math.hypot(aim[0] - px, aim[1] - py);
            view.yaw = Math.atan2(aim[1] - py, aim[0] - px);
            view.pitch = Math.atan2(aim[2] - eyeZ, horiz);
            console.log("[goto-item]", best.cls, "@", best.origin.join(","), "floorZ", floorZ, "stand", Math.round(horiz));
        }
    }

    // First-person weapon viewmodels (all three weapons preloaded; only the
    // active one is shown).
    const viewmodel = new Viewmodel(engine, scene, lightTex, palette, atlas.whiteUV);
    await viewmodel.load(WEAPON_ORDER.map((id) => WEAPONS[id]));
    viewmodel.select(player.weapon);

    const impacts = new ImpactFx(engine, scene);

    // Grenade-launcher projectiles. Splash damage hurts the player too (authentic
    // Quake self-damage), scaled by closest-point distance to the blast.
    const grenades = new GrenadeSystem(
        { engine, scene, physics, monsters, palette, lightTex, whiteUV: atlas.whiteUV },
        {
            sound: (name, at) => sound.play(name, { origin: at }),
            explosion: (at) => impacts.explosion(at),
            playerSplash: (center, radius, maxDamage) => {
                const p = physics.origin;
                const dx = p[0] - center[0];
                const dy = p[1] - center[1];
                const dz = p[2] + 24 - center[2];
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist >= radius) return;
                const dmg = maxDamage * (1 - dist / radius) * 0.5;
                if (dmg > 0) {
                    hurtPlayer(player, dmg, hud, sound);
                    hud.setStats(player, monsters.kills, monsters.total);
                }
            },
            onChange: () => hud.setStats(player, monsters.kills, monsters.total),
        }
    );
    await grenades.load();

    // Camera spawned at the player eye.
    const [cx, cy, cz] = quakeToEngine(physics.eye[0], physics.eye[1], physics.eye[2]);
    const cam = createFreeCamera({ x: cx, y: cy, z: cz }, { x: cx + Math.cos(view.yaw), y: cy, z: cz + Math.sin(view.yaw) });
    cam.nearPlane = 1;
    cam.farPlane = 20000;
    scene.camera = cam;

    installPlayerControls(scene, canvas, physics, cam, view, movers, moverMeshes, items, monsters, viewmodel, grenades, player, hud, impacts, sound);

    // Advance the sky scroll clock each frame.
    if (skyMaterials.length > 0) {
        let skyTime = 0;
        onBeforeRender(scene, (deltaMs) => {
            skyTime += deltaMs / 1000;
            for (const m of skyMaterials) setShaderUniform(m, "sky", [skyTime, 0, 0, 0]);
        });
    }

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(drawn);
    canvas.dataset.ready = "true";
    hud.message("WASD move  ·  mouse look  ·  LMB fire  ·  1-5 / wheel switch weapon");
}

/** First-person controls + the per-frame game loop (physics, movers, sync). */
function installPlayerControls(
    scene: ReturnType<typeof createSceneContext>,
    canvas: HTMLCanvasElement,
    physics: QuakePhysics,
    cam: ReturnType<typeof createFreeCamera>,
    view: View,
    movers: MoverSystem,
    moverMeshes: Map<WorldEnt, Mesh[]>,
    items: SpawnedItem[],
    monsters: MonsterSystem,
    viewmodel: Viewmodel,
    grenades: GrenadeSystem,
    player: Player,
    hud: Hud,
    impacts: ImpactFx,
    sound: QuakeSound
): void {
    const keys = new Set<string>();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    // Track raw button bitmask so we can detect a left-button press even while the
    // right button is held. Pointer Events only emit `pointerdown` on the 0->nonzero
    // buttons transition; a second button pressed afterwards arrives as `pointermove`,
    // so firing must be edge-detected from `e.buttons`, not bound to `pointerdown`.
    const LEFT_BUTTON = 1;
    const RIGHT_BUTTON = 2;
    let prevButtons = 0;
    let locked = false;
    const requestLock = (): void => {
        if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
    };
    const exitLock = (): void => {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
    document.addEventListener("pointerlockchange", () => {
        locked = document.pointerLockElement === canvas;
        if (!locked) dragging = false;
    });
    const maxPitch = Math.PI / 2 - 0.01;

    let lastFire = 0; // global refire timestamp (seconds)

    const switchWeapon = (id: WeaponId): void => {
        if (player.dead || !player.owned.has(id) || player.weapon === id) return;
        player.weapon = id;
        viewmodel.select(id);
        hud.setStats(player, monsters.kills, monsters.total);
    };

    // Cycle to the next/previous owned weapon in slot order (mouse wheel).
    const cycleWeapon = (dir: number): void => {
        if (player.dead) return;
        const owned = WEAPON_ORDER.filter((id) => player.owned.has(id));
        if (owned.length < 2) return;
        const i = owned.indexOf(player.weapon);
        switchWeapon(owned[(i + dir + owned.length) % owned.length]!);
    };

    // Read/spend the ammo pool backing a weapon's ammo type.
    const ammoOf = (t: AmmoType): number => (t === "shells" ? player.shells : t === "nails" ? player.nails : player.rockets);
    const spendAmmo = (t: AmmoType, n: number): void => {
        if (t === "shells") player.shells -= n;
        else if (t === "nails") player.nails -= n;
        else player.rockets -= n;
    };

    const fire = (): void => {
        if (player.dead) return;
        const def = WEAPONS[player.weapon];
        const now = performance.now() / 1000;
        if (now - lastFire < def.refire) return;
        const have = ammoOf(def.ammo);
        if (have < def.ammoPerShot) return;

        // Quake view direction from yaw/pitch (X fwd, Y left, Z up).
        const cp = Math.cos(view.pitch);
        const eye: [number, number, number] = [physics.eye[0], physics.eye[1], physics.eye[2]];
        const dir: [number, number, number] = [Math.cos(view.yaw) * cp, Math.sin(view.yaw) * cp, Math.sin(view.pitch)];

        if (def.projectile) {
            // Grenade launcher: launch a bouncing projectile. Only spend ammo and
            // play effects if the pool wasn't exhausted.
            if (!grenades.launch(eye, dir)) return;
        } else {
            // Hitscan pellets with a spread basis derived from yaw (stays stable at
            // steep pitch, unlike a forward-derived right vector).
            const rightX = Math.sin(view.yaw);
            const rightY = -Math.cos(view.yaw);
            // up = cross(right, forward)
            const upX = rightY * dir[2] - 0 * dir[1];
            const upY = 0 * dir[0] - rightX * dir[2];
            const upZ = rightX * dir[1] - rightY * dir[0];
            for (let i = 0; i < def.pellets; i++) {
                const sx = (Math.random() * 2 - 1) * def.spreadX;
                const sy = (Math.random() * 2 - 1) * def.spreadY;
                const pd: [number, number, number] = [dir[0] + rightX * sx + upX * sy, dir[1] + rightY * sx + upY * sy, dir[2] + upZ * sy];
                const monPoint = monsters.hitscan(eye, pd, def.range, def.dmgPerPellet);
                if (monPoint) {
                    impacts.spawn([monPoint[0] - pd[0] * 6, monPoint[1] - pd[1] * 6, monPoint[2] - pd[2] * 6], true);
                } else {
                    const end: [number, number, number] = [eye[0] + pd[0] * def.range, eye[1] + pd[1] * def.range, eye[2] + pd[2] * def.range];
                    const wall = physics.castMove(eye, end);
                    if (wall.fraction < 1) {
                        const n = wall.normal ?? [0, 0, 0];
                        impacts.spawn([wall.endpos[0] + n[0] * 4, wall.endpos[1] + n[1] * 4, wall.endpos[2] + n[2] * 4], false);
                    }
                }
            }
        }

        lastFire = now;
        spendAmmo(def.ammo, def.ammoPerShot);
        hud.muzzle();
        viewmodel.fire();
        sound.play(def.fireSound);
        hud.setStats(player, monsters.kills, monsters.total);
    };

    if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => {
        sound.resume();
        keys.add(e.code);
        if (e.code === "Digit1") switchWeapon("shotgun");
        else if (e.code === "Digit2") switchWeapon("supershotgun");
        else if (e.code === "Digit3") switchWeapon("nailgun");
        else if (e.code === "Digit4") switchWeapon("supernailgun");
        else if (e.code === "Digit5") switchWeapon("grenade");
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    });
    canvas.addEventListener("keyup", (e) => keys.delete(e.code));
    // Mouse wheel cycles weapons, like most modern FPS controls.
    canvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            cycleWeapon(e.deltaY > 0 ? 1 : -1);
        },
        { passive: false }
    );
    // Fire on the rising edge of the left button; grab/release the mouse (pointer
    // lock) on the rising/falling edge of the right button so look is free-cursor.
    const handleButtons = (buttons: number): void => {
        if (buttons & LEFT_BUTTON && !(prevButtons & LEFT_BUTTON)) fire();
        if (buttons & RIGHT_BUTTON && !(prevButtons & RIGHT_BUTTON)) requestLock();
        if (!(buttons & RIGHT_BUTTON) && prevButtons & RIGHT_BUTTON) exitLock();
        prevButtons = buttons;
    };
    canvas.addEventListener("pointerdown", (e) => {
        sound.resume();
        canvas.setPointerCapture(e.pointerId);
        canvas.focus();
        if (!dragging) {
            lastX = e.clientX;
            lastY = e.clientY;
        }
        dragging = e.buttons !== 0;
        handleButtons(e.buttons);
    });
    canvas.addEventListener("pointerup", (e) => {
        handleButtons(e.buttons);
        if (e.buttons === 0) {
            canvas.releasePointerCapture(e.pointerId);
            dragging = false;
        }
    });
    canvas.addEventListener("pointercancel", () => {
        prevButtons = 0;
        dragging = false;
        exitLock();
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointermove", (e) => {
        // A button pressed while another is held arrives here, not as pointerdown.
        handleButtons(e.buttons);
        // While the mouse is captured (right button held), look comes from raw
        // movement deltas with no cursor; otherwise fall back to drag-look.
        if (locked) {
            view.yaw -= e.movementX * LOOK_SENS;
            view.pitch -= e.movementY * LOOK_SENS;
            view.pitch = Math.max(-maxPitch, Math.min(maxPitch, view.pitch));
            return;
        }
        if (e.buttons === 0) {
            dragging = false;
            return;
        }
        if (!dragging) {
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            return;
        }
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        view.yaw -= dx * LOOK_SENS;
        view.pitch -= dy * LOOK_SENS;
        view.pitch = Math.max(-maxPitch, Math.min(maxPitch, view.pitch));
    });

    // Previous mover offsets — used to carry the player when riding a lift.
    const prevOffset = new Map<WorldEnt, [number, number, number]>();
    for (const ent of moverMeshes.keys()) prevOffset.set(ent, [ent.offset[0], ent.offset[1], ent.offset[2]]);
    const ridingEnt = (): WorldEnt | undefined => {
        if (physics.groundBrush < 0) return undefined;
        for (const ent of moverMeshes.keys()) if (ent.hullIndex === physics.groundBrush) return ent;
        return undefined;
    };

    let smoothEyeZ = physics.eye[2];
    let itemSpin = 0;
    let liquidDmgTimer = 0;

    // FPS counter (top-left), averaged over a short window using the raw frame delta.
    const fpsEl = document.createElement("div");
    fpsEl.style.cssText = "position:fixed;right:8px;top:6px;color:#ff0;font:bold 14px monospace;text-shadow:0 0 3px #000,0 1px 2px #000;pointer-events:none;z-index:9999;";
    document.body.appendChild(fpsEl);
    let fpsAccum = 0;
    let fpsFrames = 0;
    onBeforeRender(scene, (deltaMs) => {
        const dt = Math.min(deltaMs / 1000, MAX_FRAME);
        fpsAccum += deltaMs;
        fpsFrames++;
        if (fpsAccum >= 250) {
            fpsEl.textContent = `${Math.round(1000 / (fpsAccum / fpsFrames))} FPS`;
            fpsAccum = 0;
            fpsFrames = 0;
        }
        let forward = 0;
        let side = 0;
        if (!player.dead) {
            if (keys.has("KeyW") || keys.has("ArrowUp")) forward += MOVE_SPEED;
            if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= MOVE_SPEED;
            if (keys.has("KeyD") || keys.has("ArrowRight")) side += MOVE_SPEED;
            if (keys.has("KeyA") || keys.has("ArrowLeft")) side -= MOVE_SPEED;
        }
        const input: MoveInput = { forward, side, jump: !player.dead && keys.has("Space") };
        physics.update(dt, input, view.yaw, view.pitch);
        sound.setListener([physics.eye[0], physics.eye[1], physics.eye[2]], view.yaw);
        // Underwater view blend while the eyes are submerged.
        hud.underwater(physics.waterLevel >= 3 ? physics.waterType : 0);

        // Slime/lava burn: jumping into a goo/lava pool hurts (and kills) the
        // player on a Quake-style damage tick, unless the environment suit is
        // active. Slime is fully blocked by the suit; lava is only slowed.
        if (player.suitTime > 0) player.suitTime = Math.max(0, player.suitTime - dt);
        if (!player.dead && physics.waterLevel >= 1 && (physics.waterType === CONTENTS_SLIME || physics.waterType === CONTENTS_LAVA)) {
            liquidDmgTimer -= dt;
            if (liquidDmgTimer <= 0) {
                const suited = player.suitTime > 0;
                if (physics.waterType === CONTENTS_LAVA) {
                    liquidDmgTimer = suited ? 1 : 0.2;
                    hurtPlayer(player, 10 * physics.waterLevel, hud, sound);
                    hud.setStats(player, monsters.kills, monsters.total);
                } else if (!suited) {
                    liquidDmgTimer = 1;
                    hurtPlayer(player, 4 * physics.waterLevel, hud, sound);
                    hud.setStats(player, monsters.kills, monsters.total);
                }
            }
        } else {
            liquidDmgTimer = 0; // out of liquid — first contact next time hurts immediately
        }

        const riding = ridingEnt();
        movers.update(dt);
        monsters.update(dt, [physics.origin[0], physics.origin[1], physics.origin[2]], player.dead);
        grenades.update(dt);

        // Sync mover meshes; carry the player along with whatever lift they ride.
        for (const [ent, meshes] of moverMeshes) {
            const [ex, ey, ez] = quakeToEngine(ent.offset[0], ent.offset[1], ent.offset[2]);
            for (const m of meshes) m.position.set(ex, ey, ez);
            const prev = prevOffset.get(ent)!;
            if (ent === riding) {
                physics.origin[0] += ent.offset[0] - prev[0];
                physics.origin[1] += ent.offset[1] - prev[1];
                physics.origin[2] += ent.offset[2] - prev[2];
            }
            prev[0] = ent.offset[0];
            prev[1] = ent.offset[1];
            prev[2] = ent.offset[2];
        }

        // Spin live items (Quake-3 style) and grant pickups on touch. physics.origin
        // is the player centre (feet + 24); items rest on the floor at qpos. Use a
        // box-overlap-style test: generous horizontally, lenient vertically so items
        // on low pedestals or steps still register.
        itemSpin += dt * ITEM_SPIN_SPEED;
        const pOrigin = physics.origin;
        for (const item of items) {
            if (item.picked) continue;
            for (const m of item.meshes) m.rotation.set(0, itemSpin, 0);
            const dx = item.qpos[0] - pOrigin[0];
            const dy = item.qpos[1] - pOrigin[1];
            const dz = item.qpos[2] - pOrigin[2];
            if (dx * dx + dy * dy <= ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS && Math.abs(dz) <= ITEM_PICKUP_HEIGHT) {
                item.picked = true;
                for (const m of item.meshes) setMeshVisible(m, false);
                const pickup = grantPickup(player, item.cls, item.flags);
                viewmodel.select(player.weapon);
                sound.play(pickup.sound);
                hud.message(pickup.label);
                hud.setStats(player, monsters.kills, monsters.total);
            }
        }

        impacts.update();

        // Stair-step view smoothing: ease the eye height up to its true value after
        // a step-up so climbing stairs doesn't jolt the camera; snap otherwise.
        const eyeQ = physics.eye;
        if (physics.onGround && eyeQ[2] > smoothEyeZ) {
            smoothEyeZ = Math.min(eyeQ[2], smoothEyeZ + dt * STAIR_SMOOTH_SPEED);
            if (eyeQ[2] - smoothEyeZ > STEPSIZE) smoothEyeZ = eyeQ[2] - STEPSIZE;
        } else {
            smoothEyeZ = eyeQ[2];
        }
        const [px, py, pz] = quakeToEngine(eyeQ[0], eyeQ[1], smoothEyeZ);
        cam.position.set(px, py, pz);
        const cp = Math.cos(view.pitch);
        cam.target.set(px + Math.cos(view.yaw) * cp, py + Math.sin(view.pitch), pz + Math.sin(view.yaw) * cp);

        if (player.dead) viewmodel.hide();
        else viewmodel.update([px, py, pz], view.yaw, view.pitch, dt);
    });
}

/**
 * Apply a touched item's effect to the player and return a short pickup label
 * for the HUD. Mirrors Quake's pickup amounts: health heals (mega overheals),
 * armour raises the armour ceiling, ammo boxes top up the matching ammo pool,
 * and weapon pickups grant the weapon (auto-switching to it) plus a little ammo.
 * Powerup artifacts are collected (labelled) but grant no persistent stat.
 */
function grantPickup(player: Player, cls: string, flags: number): { label: string; sound: string } {
    if (cls === "item_health") {
        if (flags & 2) {
            player.health = Math.min(250, player.health + 100); // megahealth
            return { label: "You got the megahealth!", sound: "items/r_item2.wav" };
        }
        if (flags & 1) {
            player.health = Math.min(100, player.health + 15); // rotten
            return { label: "You got 15 health", sound: "items/health1.wav" };
        }
        player.health = Math.min(100, player.health + 25);
        return { label: "You got 25 health", sound: "items/health1.wav" };
    }
    if (cls === "item_armor1") {
        player.armor = Math.max(player.armor, 100);
        return { label: "You got armor", sound: "items/armor1.wav" };
    }
    if (cls === "item_armor2") {
        player.armor = Math.max(player.armor, 150);
        return { label: "You got combat armor", sound: "items/armor1.wav" };
    }
    if (cls === "item_armorInv") {
        player.armor = Math.max(player.armor, 200);
        return { label: "You got red armor", sound: "items/armor1.wav" };
    }
    if (cls === "item_artifact_envirosuit") {
        player.suitTime = ENVIROSUIT_TIME;
        return { label: "You got the environment suit", sound: "items/suit.wav" };
    }
    const artifacts: Record<string, { label: string; sound: string }> = {
        item_artifact_super_damage: { label: "Quad Damage!", sound: "items/damage.wav" },
        item_artifact_envirosuit: { label: "You got the environment suit", sound: "items/suit.wav" },
        item_artifact_invulnerability: { label: "You got the Pentagram of Protection", sound: "items/protect.wav" },
        item_artifact_invisibility: { label: "You got the Ring of Shadows", sound: "items/inv1.wav" },
    };
    if (artifacts[cls]) return artifacts[cls];

    // Weapon pickups: grant the weapon, give a little ammo of its type, auto-switch.
    const weaponId = WEAPON_PICKUPS[cls];
    if (weaponId) {
        player.owned.add(weaponId);
        const def = WEAPONS[weaponId];
        if (def.ammo === "shells") player.shells = Math.min(100, player.shells + 5);
        else if (def.ammo === "nails") player.nails = Math.min(200, player.nails + 30);
        else player.rockets = Math.min(100, player.rockets + 5);
        player.weapon = weaponId;
        const hint = player.owned.size >= 2 ? "  (keys 1-5 or mouse wheel to switch)" : "";
        return { label: `You got the ${def.name}${hint}`, sound: "weapons/pkup.wav" };
    }

    // Ammo boxes route to the matching pool.
    if (cls === "item_shells") {
        player.shells = Math.min(100, player.shells + 20);
        return { label: "You got shells", sound: "weapons/lock4.wav" };
    }
    if (cls === "item_rockets") {
        player.rockets = Math.min(100, player.rockets + 5);
        return { label: "You got rockets", sound: "weapons/lock4.wav" };
    }
    if (cls === "item_spikes") {
        player.nails = Math.min(200, player.nails + (flags & 1 ? 50 : 25));
        return { label: "You got nails", sound: "weapons/lock4.wav" };
    }
    if (cls === "item_cells") return { label: "You got cells", sound: "weapons/lock4.wav" };
    return { label: "You got ammo", sound: "weapons/lock4.wav" };
}

/**
 * Quake-style hit particle bursts. Each shot emits a small cluster of tiny
 * particles from the impact point that fly outward, fall under gravity and pop
 * out within a fraction of a second — a grey dust puff on world geometry and a
 * red blood spray on a monster, matching vanilla Quake's R_RunParticleEffect.
 * Pooled so firing never allocates; particles move purely via transform updates
 * (no material mutation, no render-bundle invalidation).
 */
class ImpactFx {
    private readonly blood: Particles;
    private readonly spark: Particles;
    private readonly fireball: Particles;
    private readonly emberSmoke: Particles;
    private last = performance.now() / 1000;

    constructor(engine: Engine, scene: ReturnType<typeof createSceneContext>) {
        // Fixed-colour pools. Colours are baked at construction because Standard
        // material colour changes made after the scene is registered are not re-uploaded
        // to the GPU; only per-frame transforms (position/scale) update.
        this.blood = new Particles(engine, scene, [0.62, 0.03, 0.03], 48);
        this.spark = new Particles(engine, scene, [0.78, 0.76, 0.7], 40);
        // Explosion: a fast bright-orange fireball plus a darker, slower ember/smoke
        // cloud so grenade blasts read like Quake's r_explosion rather than a flat puff.
        this.fireball = new Particles(engine, scene, [1.0, 0.55, 0.12], 64, { size: 5.5, maxLife: 0.55, speedBase: 140, speedRand: 220, upBias: 70 });
        this.emberSmoke = new Particles(engine, scene, [0.35, 0.16, 0.06], 48, { size: 6.5, maxLife: 0.7, speedBase: 40, speedRand: 90, upBias: 90 });
    }

    /** point is in Quake space; blood=true sprays red, else a grey dust puff. */
    spawn(point: [number, number, number], blood: boolean): void {
        const [ex, ey, ez] = quakeToEngine(point[0], point[1], point[2]);
        (blood ? this.blood : this.spark).burst(ex, ey, ez, blood ? 12 : 9);
    }

    /** Big fireball + ember cloud for a grenade detonation (Quake-space point). */
    explosion(point: [number, number, number]): void {
        const [ex, ey, ez] = quakeToEngine(point[0], point[1], point[2]);
        this.fireball.burst(ex, ey, ez, 40);
        this.emberSmoke.burst(ex, ey, ez, 26);
    }

    update(): void {
        const now = performance.now() / 1000;
        const dt = Math.min(now - this.last, 0.05);
        this.last = now;
        this.blood.tick(dt);
        this.spark.tick(dt);
        this.fireball.tick(dt);
        this.emberSmoke.tick(dt);
    }
}

/** A single fixed-colour pool of tiny particle boxes with velocity + gravity. */
interface ParticleOpts {
    size?: number;
    maxLife?: number;
    speedBase?: number;
    speedRand?: number;
    upBias?: number;
}

class Particles {
    private readonly mesh: Mesh[] = [];
    private readonly px: number[] = [];
    private readonly py: number[] = [];
    private readonly pz: number[] = [];
    private readonly vx: number[] = [];
    private readonly vy: number[] = [];
    private readonly vz: number[] = [];
    private readonly life: number[] = [];
    private next = 0;
    private readonly size: number;
    private readonly maxLife: number;
    private readonly speedBase: number;
    private readonly speedRand: number;
    private readonly upBias: number;
    private static readonly GRAVITY = 520; // engine units / s² (Y-up)

    constructor(engine: Engine, scene: ReturnType<typeof createSceneContext>, color: [number, number, number], count: number, opts: ParticleOpts = {}) {
        this.size = opts.size ?? 2.6;
        this.maxLife = opts.maxLife ?? 0.4;
        this.speedBase = opts.speedBase ?? 35;
        this.speedRand = opts.speedRand ?? 75;
        this.upBias = opts.upBias ?? 45;
        for (let i = 0; i < count; i++) {
            const m = createBox(engine, this.size);
            const mat = createStandardMaterial();
            mat.emissiveColor = color;
            mat.diffuseColor = [0, 0, 0];
            m.material = mat;
            // Kept permanently in the scene (and thus in the cached opaque render bundle);
            // hidden by collapsing to zero scale rather than toggling `visible`, which
            // would not invalidate the bundle and so would never reappear.
            m.scaling.set(0, 0, 0);
            addToScene(scene, m);
            this.mesh.push(m);
            this.px.push(0);
            this.py.push(0);
            this.pz.push(0);
            this.vx.push(0);
            this.vy.push(0);
            this.vz.push(0);
            this.life.push(-1);
        }
    }

    /** Emit `n` particles from (x,y,z) scattering in a hemisphere-ish puff. */
    burst(x: number, y: number, z: number, n: number): void {
        for (let k = 0; k < n; k++) {
            const i = this.next;
            this.next = (this.next + 1) % this.mesh.length;
            // Random direction on a sphere, biased slightly upward.
            const theta = Math.random() * Math.PI * 2;
            const cosP = 2 * Math.random() - 1;
            const sinP = Math.sqrt(1 - cosP * cosP);
            const spd = this.speedBase + Math.random() * this.speedRand;
            this.px[i] = x;
            this.py[i] = y;
            this.pz[i] = z;
            this.vx[i] = Math.cos(theta) * sinP * spd;
            this.vy[i] = cosP * spd * 0.6 + this.upBias;
            this.vz[i] = Math.sin(theta) * sinP * spd;
            this.life[i] = this.maxLife * (0.7 + Math.random() * 0.6);
            const mesh = this.mesh[i]!;
            mesh.position.set(x, y, z);
            mesh.scaling.set(1, 1, 1);
        }
    }

    tick(dt: number): void {
        for (let i = 0; i < this.mesh.length; i++) {
            const mesh = this.mesh[i]!;
            const life = this.life[i]!;
            if (life < 0) continue;
            const nextLife = life - dt;
            this.life[i] = nextLife;
            if (nextLife <= 0) {
                mesh.scaling.set(0, 0, 0);
                this.life[i] = -1;
                continue;
            }
            this.vy[i] = this.vy[i]! - Particles.GRAVITY * dt;
            this.px[i] = this.px[i]! + this.vx[i]! * dt;
            this.py[i] = this.py[i]! + this.vy[i]! * dt;
            this.pz[i] = this.pz[i]! + this.vz[i]! * dt;
            mesh.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
            // Shrink to a point near end of life so it fades out rather than popping.
            const f = nextLife / this.maxLife;
            const k = f < 0.5 ? f * 2 : 1;
            mesh.scaling.set(k, k, k);
        }
    }
}

interface Hud {
    message: (text: string) => void;
    complete: (map: string) => void;
    setStats: (player: Player, kills: number, total: number) => void;
    muzzle: () => void;
    pain: (amount: number) => void;
    underwater: (contents: number) => void;
    showDead: () => void;
}

/** Apply damage to the player (armor soaks 60%); shows the death overlay at 0 HP. */
function hurtPlayer(player: Player, amount: number, hud: Hud, sound: QuakeSound): void {
    if (player.dead) return;
    if (player.godmode) return;
    const soak = Math.min(player.armor, amount * 0.6);
    player.armor -= soak;
    player.health -= amount - soak;
    hud.pain(amount);
    if (player.health <= 0) {
        player.health = 0;
        player.dead = true;
        sound.playRandom(["player/death1.wav", "player/death2.wav", "player/death3.wav", "player/death4.wav", "player/death5.wav"]);
        hud.showDead();
    } else {
        sound.playRandom(["player/pain1.wav", "player/pain2.wav", "player/pain3.wav", "player/pain4.wav", "player/pain5.wav", "player/pain6.wav"]);
    }
    hud.message("");
}

/** DOM HUD: transient messages, muzzle flash, death + level-complete overlays,
 *  plus the authentic Quake status bar (sbar/ibar) rendered to an overlay canvas. */
async function createHud(palette: Palette): Promise<Hud> {
    const msg = document.createElement("div");
    msg.style.cssText =
        "position:fixed;left:0;right:0;top:16px;margin:auto;max-width:80%;text-align:center;color:#ffe;font:16px monospace;text-shadow:0 0 4px #000,0 2px 4px #000;pointer-events:none;z-index:9998;opacity:0;transition:opacity .3s;";
    document.body.appendChild(msg);
    let hideTimer = 0;

    // Authentic Quake sbar/ibar. Falls back to a simple text stats line if
    // gfx.wad is unavailable (e.g. assets not fetched).
    const sbar = await SbarHud.create(palette);
    let stats: HTMLDivElement | null = null;
    if (!sbar) {
        stats = document.createElement("div");
        stats.style.cssText =
            "position:fixed;left:0;right:0;bottom:12px;text-align:center;color:#ffe;font:bold 20px monospace;text-shadow:0 0 4px #000,0 2px 4px #000;pointer-events:none;z-index:9998;letter-spacing:1px;";
        document.body.appendChild(stats);
    }

    const flash = document.createElement("div");
    flash.style.cssText = "position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:9997;transition:opacity .08s;";
    document.body.appendChild(flash);

    // Quake CSHIFT_DAMAGE blend: a red full-screen wash on taking damage that
    // snaps in proportional to the hit and fades out over ~0.4s.
    const damage = document.createElement("div");
    damage.style.cssText = "position:fixed;inset:0;background:#b30000;opacity:0;pointer-events:none;z-index:9996;transition:opacity .4s ease-out;";
    document.body.appendChild(damage);

    // Quake underwater view blend: a full-screen colour wash while the eyes are
    // submerged, tinted by the liquid (water = blue, slime = green, lava = orange).
    const underwater = document.createElement("div");
    underwater.style.cssText = "position:fixed;inset:0;opacity:0;pointer-events:none;z-index:9995;transition:opacity .25s ease-out;";
    document.body.appendChild(underwater);

    const banner = document.createElement("div");
    banner.style.cssText =
        "position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;color:#ffd86b;font:bold 40px monospace;text-shadow:0 0 12px #000;background:rgba(0,0,0,.6);z-index:9999;";
    document.body.appendChild(banner);

    return {
        message(text: string) {
            if (!text) return;
            msg.textContent = text;
            msg.style.opacity = "1";
            window.clearTimeout(hideTimer);
            hideTimer = window.setTimeout(() => (msg.style.opacity = "0"), 3000);
        },
        setStats(player: Player, kills: number, total: number) {
            const def = WEAPONS[player.weapon];
            const ammoCount = def.ammo === "shells" ? player.shells : def.ammo === "nails" ? player.nails : player.rockets;
            if (sbar) {
                const weapons = WEAPON_ORDER.filter((id) => player.owned.has(id)).map((id) => ({
                    invIcon: WEAPONS[id].invIcon,
                    ibarSlotX: WEAPONS[id].ibarSlotX,
                    selected: id === player.weapon,
                }));
                sbar.setStats({
                    health: player.health,
                    armor: player.armor,
                    ammo: ammoCount,
                    kills,
                    total,
                    weapons,
                    ammoIcon: def.ammoIcon,
                });
                return;
            }
            const ammoLabel = def.ammo === "shells" ? "SHELLS" : def.ammo === "nails" ? "NAILS" : "ROCKETS";
            stats!.innerHTML =
                `<span style="color:#ff6b6b">HEALTH ${Math.max(0, Math.ceil(player.health))}</span>` +
                `&nbsp;&nbsp;<span style="color:#6bb6ff">ARMOR ${Math.max(0, Math.round(player.armor))}</span>` +
                `&nbsp;&nbsp;<span style="color:#ffd86b">${def.name.toUpperCase()} · ${ammoLabel} ${ammoCount}</span>` +
                `&nbsp;&nbsp;<span style="color:#b6ffb6">KILLS ${kills}/${total}</span>`;
        },
        muzzle() {
            flash.style.opacity = "0.35";
            window.setTimeout(() => (flash.style.opacity = "0"), 60);
        },
        pain(amount: number) {
            // Snap to an intensity scaled by the hit, then fade. Two rAFs guarantee
            // the snap-in is painted for a frame before the fade starts, so the
            // browser can't coalesce both writes and skip the flash entirely.
            const intensity = Math.min(0.7, 0.35 + amount * 0.015);
            damage.style.transition = "none";
            damage.style.opacity = String(intensity);
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    damage.style.transition = "opacity .5s ease-out";
                    damage.style.opacity = "0";
                })
            );
        },
        underwater(contents: number) {
            // contents: -3 water, -4 slime, -5 lava; anything else clears the wash.
            if (contents === -3) {
                underwater.style.background = "rgb(40,90,150)";
                underwater.style.opacity = "0.5";
            } else if (contents === -4) {
                underwater.style.background = "rgb(50,90,30)";
                underwater.style.opacity = "0.62";
            } else if (contents === -5) {
                underwater.style.background = "rgb(200,70,0)";
                underwater.style.opacity = "0.62";
            } else {
                underwater.style.opacity = "0";
            }
        },
        showDead() {
            banner.style.display = "flex";
            banner.innerHTML = `<div style="color:#ff5555">YOU DIED</div><div style="font-size:18px;margin-top:12px;opacity:.8">Reload the page to try again</div>`;
        },
        complete(map: string) {
            if (banner.style.display === "flex") return;
            banner.style.display = "flex";
            banner.innerHTML = `<div>LEVEL COMPLETE</div><div style="font-size:18px;margin-top:12px;opacity:.8">Next: ${map || "?"}</div>`;
        },
    };
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) canvas.dataset.error = String(err);
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && err.stack ? err.stack : ""}`;
    document.body.appendChild(pre);
});
