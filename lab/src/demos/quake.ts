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
    startEngine,
    type Mesh,
} from "babylon-lite";

import { parseBsp } from "./quake/bsp/parse-bsp.js";
import { parsePalette } from "./quake/palette.js";
import { parseEntities, parseVec3, filterEntitiesBySkill } from "./quake/entities/parse-entities.js";
import { buildLevelGeometry, buildModelGeometry, quakeToEngine, type GeometryBatch } from "./quake/geometry/build-geometry.js";
import { QuakeTextureCache } from "./quake/render/texture-cache.js";
import { createQuakeMaterial } from "./quake/render/quake-material.js";
import { QuakePhysics, type MoveInput } from "./quake/physics/collision.js";
import { MoverSystem, type WorldEnt } from "./quake/entities/mover-system.js";
import { MonsterSystem } from "./quake/combat/monsters.js";
import { Viewmodel } from "./quake/render/viewmodel.js";
import { spawnItemModels, type SpawnedItem } from "./quake/render/items.js";

const BSP_URL = "/librequake/lq_e1m1.bsp";
const PALETTE_URL = "/librequake/palette.lmp";
const MOVE_SPEED = 320; // Quake units / second
const LOOK_SENS = 0.0022;
const MAX_FRAME = 0.05;

const MOVER_KINDS = new Set(["door", "secret", "button", "plat"]);

const SHOTGUN_RANGE = 2048;
const SHOTGUN_DAMAGE = 24; // 4 pellets worth in one hitscan
const START_AMMO = 25;
const START_HEALTH = 100;
const ITEM_PICKUP_RADIUS = 48; // Quake item touch range (player half-width + item).
const ITEM_PICKUP_HEIGHT = 56; // vertical reach: player box + item height overlap.
const ITEM_SPIN_SPEED = 1.6; // radians/sec — Quake-3-style pickup rotation.

const STEPSIZE = 18; // Quake STEPSIZE — must match physics; used for view-Z stair smoothing.
const STAIR_SMOOTH_SPEED = 180; // units/sec the smoothed eye catches up after a step-up.

type Engine = Awaited<ReturnType<typeof createEngine>>;

interface View {
    yaw: number;
    pitch: number;
}

interface Player {
    health: number;
    armor: number;
    ammo: number;
    dead: boolean;
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
            origin[0] = p[0];
            origin[1] = p[1];
            origin[2] = p[2];
        }
    }
    const yawParam = params.get("yaw");
    if (yawParam && Number.isFinite(Number(yawParam))) view.yaw = (Number(yawParam) * Math.PI) / 180;
    const physics = new QuakePhysics(bsp, [origin[0], origin[1], origin[2]]);

    const hud = createHud();
    const movers = new MoverSystem(bsp, entities, physics, {
        message: (m) => hud.message(m),
        complete: (map) => hud.complete(map),
        teleport: (yaw) => {
            view.yaw = yaw;
        },
    });

    // Brush-entity geometry. Movers (doors/buttons/lifts) get their own meshes so
    // we can translate them; every other brush model (func_wall, func_illusionary,
    // func_detail …) is merged into the static world so it renders without cost.
    const moverMeshes = new Map<WorldEnt, Mesh[]>();
    const moverBatches: { ent: WorldEnt; batches: Map<number, GeometryBatch> }[] = [];
    for (const ent of movers.ents) {
        if (ent.modelIndex < 0) continue;
        const model = bsp.models[ent.modelIndex];
        if (!model) continue;
        const batches = buildModelGeometry(bsp, atlas, model.firstFace, model.numFaces);
        if (MOVER_KINDS.has(ent.kind)) moverBatches.push({ ent, batches });
        else mergeBatches(worldBatches, batches);
    }

    // All atlas allocations are done — upload the lightmap once.
    const lightTex = createTexture2DFromPixels(engine, atlas.pixels, atlas.width, atlas.height, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        minFilter: "linear",
        magFilter: "linear",
    });

    let matId = 0;
    let drawn = 0;
    const makeMeshes = (batches: Map<number, GeometryBatch>, tag: string): Mesh[] => {
        const meshes: Mesh[] = [];
        for (const [miptex, batch] of batches) {
            if (batch.idx.length === 0) continue;
            const diffuse = textures.get(miptex);
            const mesh = createMeshFromData(
                engine,
                `quake_${tag}_${matId}`,
                new Float32Array(batch.pos),
                new Float32Array(batch.pos.length),
                new Uint32Array(batch.idx),
                new Float32Array(batch.uv),
                new Float32Array(batch.uv2)
            );
            mesh.material = createQuakeMaterial(`quakeMat_${matId}`, diffuse.texture, lightTex);
            addToScene(scene, mesh);
            meshes.push(mesh);
            drawn++;
            matId++;
        }
        return meshes;
    };

    makeMeshes(worldBatches, "world");
    for (const { ent, batches } of moverBatches) {
        const meshes = makeMeshes(batches, "mover");
        const [ex, ey, ez] = quakeToEngine(ent.offset[0], ent.offset[1], ent.offset[2]);
        for (const m of meshes) m.position.set(ex, ey, ez);
        moverMeshes.set(ent, meshes);
    }

    // Pickup items rendered as their real Quake models (inert decorations).
    const items = await spawnItemModels({ engine, scene, palette, lightTex, whiteUV: atlas.whiteUV, physics }, movers.ents);

    // Enemies + combat.
    const player: Player = { health: START_HEALTH, armor: 0, ammo: START_AMMO, dead: false };
    const monsters = new MonsterSystem(engine, scene, physics, lightTex, atlas.whiteUV, palette, {
        damage: (amount) => {
            hurtPlayer(player, amount, hud);
            hud.setStats(player, monsters.kills, monsters.total);
        },
        message: (m) => hud.message(m),
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

    // First-person weapon viewmodel (shotgun).
    const viewmodel = new Viewmodel(engine, scene, lightTex, palette, atlas.whiteUV);
    await viewmodel.load();

    const impacts = new ImpactFx(engine, scene);

    // Camera spawned at the player eye.
    const [cx, cy, cz] = quakeToEngine(physics.eye[0], physics.eye[1], physics.eye[2]);
    const cam = createFreeCamera({ x: cx, y: cy, z: cz }, { x: cx + Math.cos(view.yaw), y: cy, z: cz + Math.sin(view.yaw) });
    cam.nearPlane = 1;
    cam.farPlane = 20000;
    scene.camera = cam;

    installPlayerControls(scene, canvas, physics, cam, view, movers, moverMeshes, items, monsters, viewmodel, player, hud, impacts);

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(drawn);
    canvas.dataset.ready = "true";
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
    player: Player,
    hud: Hud,
    impacts: ImpactFx
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

    const fire = (): void => {
        if (player.dead || player.ammo <= 0) return;
        player.ammo--;
        // Quake view direction from yaw/pitch (X fwd, Y left, Z up).
        const cp = Math.cos(view.pitch);
        const eye: [number, number, number] = [physics.eye[0], physics.eye[1], physics.eye[2]];
        const dir: [number, number, number] = [Math.cos(view.yaw) * cp, Math.sin(view.yaw) * cp, Math.sin(view.pitch)];
        const monPoint = monsters.hitscan(eye, dir, SHOTGUN_RANGE, SHOTGUN_DAMAGE);
        if (monPoint) {
            // Pull the blood marker a little toward the shooter so it sits proud of the body.
            impacts.spawn([monPoint[0] - dir[0] * 6, monPoint[1] - dir[1] * 6, monPoint[2] - dir[2] * 6], true);
        } else {
            // No monster hit: mark where the pellets strike world geometry.
            const end: [number, number, number] = [eye[0] + dir[0] * SHOTGUN_RANGE, eye[1] + dir[1] * SHOTGUN_RANGE, eye[2] + dir[2] * SHOTGUN_RANGE];
            const wall = physics.castMove(eye, end);
            if (wall.fraction < 1) {
                const n = wall.normal ?? [0, 0, 0];
                // Push the spark out along the surface normal so it isn't embedded in the wall.
                impacts.spawn([wall.endpos[0] + n[0] * 4, wall.endpos[1] + n[1] * 4, wall.endpos[2] + n[2] * 4], false);
            }
        }
        hud.muzzle();
        viewmodel.fire();
        hud.setStats(player, monsters.kills, monsters.total);
    };

    if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => {
        keys.add(e.code);
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    });
    canvas.addEventListener("keyup", (e) => keys.delete(e.code));
    // Fire on the rising edge of the left button; grab/release the mouse (pointer
    // lock) on the rising/falling edge of the right button so look is free-cursor.
    const handleButtons = (buttons: number): void => {
        if ((buttons & LEFT_BUTTON) && !(prevButtons & LEFT_BUTTON)) fire();
        if ((buttons & RIGHT_BUTTON) && !(prevButtons & RIGHT_BUTTON)) requestLock();
        if (!(buttons & RIGHT_BUTTON) && (prevButtons & RIGHT_BUTTON)) exitLock();
        prevButtons = buttons;
    };
    canvas.addEventListener("pointerdown", (e) => {
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
    onBeforeRender(scene, (deltaMs) => {
        const dt = Math.min(deltaMs / 1000, MAX_FRAME);
        let forward = 0;
        let side = 0;
        if (!player.dead) {
            if (keys.has("KeyW") || keys.has("ArrowUp")) forward += MOVE_SPEED;
            if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= MOVE_SPEED;
            if (keys.has("KeyD") || keys.has("ArrowRight")) side += MOVE_SPEED;
            if (keys.has("KeyA") || keys.has("ArrowLeft")) side -= MOVE_SPEED;
        }
        const input: MoveInput = { forward, side, jump: !player.dead && keys.has("Space") };
        physics.update(dt, input, view.yaw);

        const riding = ridingEnt();
        movers.update(dt);
        monsters.update(dt, [physics.origin[0], physics.origin[1], physics.origin[2]]);

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
                for (const m of item.meshes) m.visible = false;
                grantPickup(player, item.cls, item.flags);
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
 * Apply a touched item's effect to the player. Mirrors Quake's pickup amounts,
 * collapsed onto this demo's single-weapon / single-ammo-counter model:
 * health heals (mega overheals), armour raises the armour ceiling, ammo and
 * weapons top up the shared ammo counter. Powerup artifacts are collected but
 * grant no persistent stat (no powerup state in this demo).
 */
function grantPickup(player: Player, cls: string, flags: number): void {
    if (cls === "item_health") {
        if (flags & 2) player.health = Math.min(250, player.health + 100); // megahealth
        else if (flags & 1) player.health = Math.min(100, player.health + 15); // rotten
        else player.health = Math.min(100, player.health + 25);
        return;
    }
    if (cls === "item_armor1") {
        player.armor = Math.max(player.armor, 100);
        return;
    }
    if (cls === "item_armor2") {
        player.armor = Math.max(player.armor, 150);
        return;
    }
    if (cls === "item_armorInv") {
        player.armor = Math.max(player.armor, 200);
        return;
    }
    let add = 0;
    if (cls === "item_shells") add = 20;
    else if (cls === "item_spikes") add = 25;
    else if (cls === "item_rockets") add = 5;
    else if (cls === "item_cells") add = 6;
    else if (cls.startsWith("weapon_")) add = 10;
    if (add > 0) player.ammo = Math.min(200, player.ammo + add);
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
    private last = performance.now() / 1000;

    constructor(engine: Engine, scene: ReturnType<typeof createSceneContext>) {
        // Two fixed-colour pools. Colours are baked at construction because Standard
        // material colour changes made after the scene is registered are not re-uploaded
        // to the GPU; only per-frame transforms (position/scale) update.
        this.blood = new Particles(engine, scene, [0.62, 0.03, 0.03], 48);
        this.spark = new Particles(engine, scene, [0.78, 0.76, 0.7], 40);
    }

    /** point is in Quake space; blood=true sprays red, else a grey dust puff. */
    spawn(point: [number, number, number], blood: boolean): void {
        const [ex, ey, ez] = quakeToEngine(point[0], point[1], point[2]);
        (blood ? this.blood : this.spark).burst(ex, ey, ez, blood ? 12 : 9);
    }

    update(): void {
        const now = performance.now() / 1000;
        const dt = Math.min(now - this.last, 0.05);
        this.last = now;
        this.blood.tick(dt);
        this.spark.tick(dt);
    }
}

/** A single fixed-colour pool of tiny particle boxes with velocity + gravity. */
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
    private static readonly SIZE = 2.6;
    private static readonly MAX_LIFE = 0.4;
    private static readonly GRAVITY = 520; // engine units / s² (Y-up)

    constructor(engine: Engine, scene: ReturnType<typeof createSceneContext>, color: [number, number, number], count: number) {
        for (let i = 0; i < count; i++) {
            const m = createBox(engine, Particles.SIZE);
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
            this.px.push(0); this.py.push(0); this.pz.push(0);
            this.vx.push(0); this.vy.push(0); this.vz.push(0);
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
            const spd = 35 + Math.random() * 75;
            this.px[i] = x; this.py[i] = y; this.pz[i] = z;
            this.vx[i] = Math.cos(theta) * sinP * spd;
            this.vy[i] = cosP * spd * 0.6 + 45;
            this.vz[i] = Math.sin(theta) * sinP * spd;
            this.life[i] = Particles.MAX_LIFE * (0.7 + Math.random() * 0.6);
            this.mesh[i].position.set(x, y, z);
            this.mesh[i].scaling.set(1, 1, 1);
        }
    }

    tick(dt: number): void {
        for (let i = 0; i < this.mesh.length; i++) {
            if (this.life[i] < 0) continue;
            this.life[i] -= dt;
            if (this.life[i] <= 0) {
                this.mesh[i].scaling.set(0, 0, 0);
                this.life[i] = -1;
                continue;
            }
            this.vy[i] -= Particles.GRAVITY * dt;
            this.px[i] += this.vx[i] * dt;
            this.py[i] += this.vy[i] * dt;
            this.pz[i] += this.vz[i] * dt;
            this.mesh[i].position.set(this.px[i], this.py[i], this.pz[i]);
            // Shrink to a point near end of life so it fades out rather than popping.
            const f = this.life[i] / Particles.MAX_LIFE;
            const k = f < 0.5 ? f * 2 : 1;
            this.mesh[i].scaling.set(k, k, k);
        }
    }
}

interface Hud {
    message: (text: string) => void;
    complete: (map: string) => void;
    setStats: (player: Player, kills: number, total: number) => void;
    muzzle: () => void;
    showDead: () => void;
}

/** Apply damage to the player (armor soaks 60%); shows the death overlay at 0 HP. */
function hurtPlayer(player: Player, amount: number, hud: Hud): void {
    if (player.dead) return;
    const soak = Math.min(player.armor, amount * 0.6);
    player.armor -= soak;
    player.health -= amount - soak;
    if (player.health <= 0) {
        player.health = 0;
        player.dead = true;
        hud.showDead();
    }
    hud.message("");
}

/** DOM HUD: stats bar, transient messages, muzzle flash, death + level-complete overlays. */
function createHud(): Hud {
    const msg = document.createElement("div");
    msg.style.cssText =
        "position:fixed;left:0;right:0;top:16px;margin:auto;max-width:80%;text-align:center;color:#ffe;font:16px monospace;text-shadow:0 0 4px #000,0 2px 4px #000;pointer-events:none;z-index:9998;opacity:0;transition:opacity .3s;";
    document.body.appendChild(msg);
    let hideTimer = 0;

    const stats = document.createElement("div");
    stats.style.cssText =
        "position:fixed;left:0;right:0;bottom:12px;text-align:center;color:#ffe;font:bold 20px monospace;text-shadow:0 0 4px #000,0 2px 4px #000;pointer-events:none;z-index:9998;letter-spacing:1px;";
    document.body.appendChild(stats);

    const flash = document.createElement("div");
    flash.style.cssText = "position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:9997;transition:opacity .08s;";
    document.body.appendChild(flash);

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
            stats.innerHTML =
                `<span style="color:#ff6b6b">HEALTH ${Math.max(0, Math.ceil(player.health))}</span>` +
                `&nbsp;&nbsp;<span style="color:#6bb6ff">ARMOR ${Math.max(0, Math.round(player.armor))}</span>` +
                `&nbsp;&nbsp;<span style="color:#ffd86b">SHELLS ${player.ammo}</span>` +
                `&nbsp;&nbsp;<span style="color:#b6ffb6">KILLS ${kills}/${total}</span>`;
        },
        muzzle() {
            flash.style.opacity = "0.35";
            window.setTimeout(() => (flash.style.opacity = "0"), 60);
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
