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
import { parseEntities, parseVec3 } from "./quake/entities/parse-entities.js";
import { buildLevelGeometry, buildModelGeometry, quakeToEngine, type GeometryBatch } from "./quake/geometry/build-geometry.js";
import { QuakeTextureCache } from "./quake/render/texture-cache.js";
import { createQuakeMaterial } from "./quake/render/quake-material.js";
import { QuakePhysics, type MoveInput } from "./quake/physics/collision.js";
import { MoverSystem, type WorldEnt } from "./quake/entities/mover-system.js";
import { MonsterSystem } from "./quake/combat/monsters.js";

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
    const entities = parseEntities(bsp.entities);

    const textures = new QuakeTextureCache(engine, bsp.mipTextures, palette);

    // World geometry (model 0) seeds the shared lightmap atlas.
    const { batches: worldBatches, atlas } = buildLevelGeometry(bsp);

    // Player physics + clean-room entity logic. Constructing the mover system
    // registers solid brush hulls into the physics world.
    const start = entities.find((e) => e.classname === "info_player_start") ?? entities.find((e) => e.classname?.startsWith("info_player"));
    const origin = parseVec3(start?.origin);
    const view: View = { yaw: ((start?.angle ? Number(start.angle) : 0) * Math.PI) / 180, pitch: 0 };
    // Optional dev override: ?spawn=x,y,z&yaw=deg
    const params = new URLSearchParams(location.search);
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

    // Item pickups as spinning emissive boxes.
    const itemMeshes = createItemMeshes(engine, scene, movers.ents);

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

    // Camera spawned at the player eye.
    const [cx, cy, cz] = quakeToEngine(physics.eye[0], physics.eye[1], physics.eye[2]);
    const cam = createFreeCamera({ x: cx, y: cy, z: cz }, { x: cx + Math.cos(view.yaw), y: cy, z: cz + Math.sin(view.yaw) });
    cam.nearPlane = 1;
    cam.farPlane = 20000;
    scene.camera = cam;

    installPlayerControls(scene, canvas, physics, cam, view, movers, moverMeshes, itemMeshes, monsters, player, hud);

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
    itemMeshes: { ent: WorldEnt; mesh: Mesh }[],
    monsters: MonsterSystem,
    player: Player,
    hud: Hud
): void {
    const keys = new Set<string>();
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const fire = (): void => {
        if (player.dead || player.ammo <= 0) return;
        player.ammo--;
        // Quake view direction from yaw/pitch (X fwd, Y left, Z up).
        const cp = Math.cos(view.pitch);
        const dir: [number, number, number] = [Math.cos(view.yaw) * cp, Math.sin(view.yaw) * cp, Math.sin(view.pitch)];
        monsters.hitscan([physics.eye[0], physics.eye[1], physics.eye[2]], dir, SHOTGUN_RANGE, SHOTGUN_DAMAGE);
        hud.muzzle();
        hud.setStats(player, monsters.kills, monsters.total);
    };

    if (!canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
    canvas.addEventListener("keydown", (e) => {
        keys.add(e.code);
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    });
    canvas.addEventListener("keyup", (e) => keys.delete(e.code));
    canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.focus();
        if (e.button === 0) fire();
    });
    canvas.addEventListener("pointerup", (e) => {
        canvas.releasePointerCapture(e.pointerId);
        dragging = false;
    });
    canvas.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        view.yaw -= dx * LOOK_SENS;
        view.pitch -= dy * LOOK_SENS;
        const maxPitch = Math.PI / 2 - 0.01;
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

    let spin = 0;
    onBeforeRender(scene, (deltaMs) => {
        const dt = Math.min(deltaMs / 1000, MAX_FRAME);
        let forward = 0;
        let side = 0;
        if (keys.has("KeyW") || keys.has("ArrowUp")) forward += MOVE_SPEED;
        if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= MOVE_SPEED;
        if (keys.has("KeyD") || keys.has("ArrowRight")) side += MOVE_SPEED;
        if (keys.has("KeyA") || keys.has("ArrowLeft")) side -= MOVE_SPEED;
        const input: MoveInput = { forward, side, jump: keys.has("Space") };
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

        // Item pickups: spin, hide once collected, grant ammo/health.
        spin += dt * 2;
        for (const { ent, mesh } of itemMeshes) {
            if (ent.picked) {
                if (mesh.visible !== false) {
                    mesh.visible = false;
                    grantPickup(player, ent.cls);
                    hud.setStats(player, monsters.kills, monsters.total);
                }
            } else {
                mesh.rotation.set(0, spin, 0);
            }
        }

        const [px, py, pz] = quakeToEngine(physics.eye[0], physics.eye[1], physics.eye[2]);
        cam.position.set(px, py, pz);
        const cp = Math.cos(view.pitch);
        cam.target.set(px + Math.cos(view.yaw) * cp, py + Math.sin(view.pitch), pz + Math.sin(view.yaw) * cp);
    });
}

/** Spawn a colored emissive box for every item/weapon entity in the map. */
function createItemMeshes(engine: Engine, scene: ReturnType<typeof createSceneContext>, ents: WorldEnt[]): { ent: WorldEnt; mesh: Mesh }[] {
    const out: { ent: WorldEnt; mesh: Mesh }[] = [];
    for (const ent of ents) {
        if (!ent.isItem) continue;
        const mesh = createBox(engine, 16);
        const [ex, ey, ez] = quakeToEngine(ent.origin[0], ent.origin[1], ent.origin[2] + 16);
        mesh.position.set(ex, ey, ez);
        const mat = createStandardMaterial();
        mat.emissiveColor = itemColor(ent.cls);
        mat.diffuseColor = [0.1, 0.1, 0.1];
        mesh.material = mat;
        addToScene(scene, mesh);
        out.push({ ent, mesh });
    }
    return out;
}

function itemColor(cls: string): [number, number, number] {
    if (cls.startsWith("weapon_")) return [0.9, 0.7, 0.1];
    if (cls.includes("health")) return [0.9, 0.15, 0.15];
    if (cls.includes("armor")) return [0.2, 0.6, 0.9];
    if (cls.includes("cells") || cls.includes("rockets") || cls.includes("shells") || cls.includes("spikes")) return [0.8, 0.6, 0.2];
    if (cls.includes("key")) return [0.9, 0.85, 0.2];
    if (cls.includes("artifact")) return [0.6, 0.2, 0.9];
    return [0.7, 0.7, 0.7];
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

/** Grant ammo / health / armor when an item box is collected. */
function grantPickup(player: Player, cls: string): void {
    if (cls.includes("health")) player.health = Math.min(100, player.health + 25);
    else if (cls.includes("armor")) player.armor = Math.min(200, player.armor + 50);
    else if (cls.startsWith("weapon_")) player.ammo += 10;
    else player.ammo += 8; // ammo boxes (shells/spikes/rockets/cells)
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
