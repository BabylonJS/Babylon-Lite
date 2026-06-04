// Orchestrates a playable DOOM level: parses a WAD, decodes the palette/colormap,
// builds per-texture geometry batches, uploads them as meshes, and installs a
// free-fly camera at the player-1 start with keyboard controls.

import { addToScene, createFreeCamera, createMeshFromData, createTexture2DFromPixels, onBeforeRender, type EngineContext, type Mesh, type SceneContext } from "babylon-lite";

import { parseWad } from "./wad/wad-file.js";
import { parseMap } from "./wad/map.js";
import type { DoomMap } from "./wad/map.js";
import { parsePlaypal, parseColormap, buildColormapLut } from "./wad/palette.js";
import { DoomTextureCache } from "./render/texture-cache.js";
import { createDoomMaterial } from "./render/doom-material.js";
import { createSky } from "./render/sky.js";
import { buildLevelBatches } from "./geometry/build-level-geometry.js";
import { DynamicGeometry } from "./geometry/dynamic-geometry.js";
import { SpecialsManager } from "./specials/specials.js";
import { buildCollisionLines, tryMove, blockAgainstThings, PLAYER_RADIUS, VIEW_HEIGHT } from "./physics/collision.js";
import { floorHeightAt, sectorIndexAt } from "./wad/bsp-query.js";
import { SpriteStore } from "./render/sprites.js";
import { SpriteRenderer } from "./render/sprite-render.js";
import { WeaponView } from "./render/weapon-view.js";
import { DoomWorld } from "./mobj/world.js";
import { MF } from "./mobj/info.js";
import { Player, Weapon } from "./player/player.js";
import { DoomHud } from "./hud/hud.js";
import { DoomSound } from "./sound/sound.js";

const MOVE_SPEED = 320; // map units per second
const TURN_SPEED = 2.4; // radians per second
const TIC_SECONDS = 1 / 35; // DOOM simulation tic rate
// Cap the per-frame timestep so a single long frame (e.g. the dynamic-mesh
// rebuild that runs the first time a door/lift starts moving, or any render
// hitch) cannot fast-forward many sim tics at once and snap movers fully
// open/closed in one frame. Without this, doors appear to "disappear" instead
// of sliding, and lifts teleport instead of gliding.
const MAX_FRAME_SECONDS = 0.05;

export interface DoomLevel {
    map: DoomMap;
    dispose(): void;
}

export function buildDoomLevel(engine: EngineContext, scene: SceneContext, wadBytes: ArrayBuffer, mapName = "E1M1"): DoomLevel {
    const wad = parseWad(wadBytes);
    const map = parseMap(wad, mapName);

    const playpal = parsePlaypal(wad);
    const colormap = parseColormap(wad);
    const lut = buildColormapLut(playpal, colormap);
    const colormapTex = createTexture2DFromPixels(engine, lut, 256, 34, {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
    });

    const textures = new DoomTextureCache(engine, wad);

    const playerSectorRef = { value: -1 };
    const specials = new SpecialsManager(map, {
        playerSector: () => playerSectorRef.value,
    });

    // Static geometry excludes anything the specials can mutate at runtime.
    const batches = buildLevelBatches(map, textures, {
        includeLine: (i) => !specials.dynamicLines.has(i),
        includeSubsector: (i) => !specials.dynamicSubsectors.has(i),
    });

    let i = 0;
    for (const [texName, batch] of batches) {
        if (batch.idx.length === 0) continue;
        const src = textures.getWall(texName) ?? textures.getFlat(texName);
        if (!src) continue;
        const positions = new Float32Array(batch.pos);
        const normals = new Float32Array(batch.pos.length); // unused by material
        const indices = new Uint32Array(batch.idx);
        const uvs = new Float32Array(batch.uv);
        const colors = new Float32Array(batch.col);
        const mesh = createMeshFromData(engine, `doom_${i}_${texName}`, positions, normals, indices, uvs, undefined, undefined, colors);
        mesh.material = createDoomMaterial(`doomMat_${i}_${texName}`, src.texture, colormapTex);
        addToScene(scene, mesh);
        i++;
    }

    const dynamicGeo = new DynamicGeometry(engine, scene, map, textures, colormapTex, specials);

    // Mobjs (monsters, items, decorations) rendered as faithful billboards.
    const spriteStore = new SpriteStore(engine, wad);
    const world = new DoomWorld(map, spriteStore);
    const usedSprites = world.spawnFromMap();
    // Sprites referenced only by runtime spawns (projectiles, puffs, blood, the
    // barrel explosion) must also be in the atlas.
    for (const extra of ["PUFF", "BLUD", "BAL1", "BEXP"]) {
        if (spriteStore.has(extra)) usedSprites.add(extra);
    }
    spriteStore.build(usedSprites);
    const spriteRenderer = new SpriteRenderer(scene, spriteStore, colormapTex);

    // Player state, HUD overlay and sound, wired to world events.
    const player = new Player(world);
    const sound = new DoomSound(wad);
    const hud = new DoomHud(engine, wad, player, colormapTex);
    const weaponView = new WeaponView(engine, wad, colormapTex);
    world.events = {
        message: (text) => {
            player.setMessage(text);
            hud.flashMessage(text);
        },
        sound: (name) => sound.play(name),
        pickup: (kind) => player.pickup(kind),
        damagePlayer: (amount) => player.takeDamage(amount),
    };

    const skyTex = textures.getWall("SKY1");
    const sky = skyTex ? createSky(engine, skyTex.texture, colormapTex) : null;
    if (sky) addToScene(scene, sky);

    installCamera(scene, map, specials, dynamicGeo, playerSectorRef, sky, world, spriteRenderer, player, hud, sound, weaponView);

    return {
        map,
        dispose: () => {
            hud.dispose();
            weaponView.dispose();
        },
    };
}

function installCamera(scene: SceneContext, map: DoomMap, specials: SpecialsManager, dynamicGeo: DynamicGeometry, playerSectorRef: { value: number }, sky: Mesh | null, world: DoomWorld, spriteRenderer: SpriteRenderer, player: Player, hud: DoomHud, sound: DoomSound, weaponView: WeaponView): void {
    const start = map.things.find((t) => t.type === 1) ?? map.things[0];
    const sx = start ? start.x : 0;
    const sz = start ? start.y : 0;
    const floorH = floorHeightAt(map, sx, sz);
    const yaw0 = start ? (start.angle * Math.PI) / 180 : 0;

    const eye = { x: sx, y: floorH + VIEW_HEIGHT, z: sz };
    const cam = createFreeCamera(eye, { x: sx + Math.cos(yaw0), y: floorH + VIEW_HEIGHT, z: sz + Math.sin(yaw0) });
    cam.nearPlane = 1;
    cam.farPlane = 12000;
    scene.camera = cam;

    let yaw = yaw0;
    let ticAccum = 0;
    let usePressed = false;
    let firing = false;
    let viewHeight = VIEW_HEIGHT;
    let wasDead = false;
    const collLines = buildCollisionLines(map);

    // Doom death: the view sinks toward the floor; press USE to respawn at start.
    const DEATH_VIEW_HEIGHT = 6;
    const DEATH_SINK_SPEED = 36; // units/sec, ~1s from standing to corpse height
    const respawn = (): void => {
        player.respawn();
        eye.x = sx;
        eye.z = sz;
        yaw = yaw0;
        viewHeight = VIEW_HEIGHT;
        eye.y = floorHeightAt(map, sx, sz) + VIEW_HEIGHT;
        playerSectorRef.value = sectorIndexAt(map, sx, sz);
    };
    const keys = new Set<string>();
    const weaponKeys: Record<string, Weapon> = {
        Digit1: Weapon.FIST,
        Digit2: Weapon.PISTOL,
        Digit3: Weapon.SHOTGUN,
        Digit4: Weapon.CHAINGUN,
        Digit5: Weapon.ROCKET,
        Digit6: Weapon.PLASMA,
        Digit7: Weapon.BFG,
    };
    const onDown = (e: KeyboardEvent): void => {
        if (e.code === "Space" && !keys.has("Space")) usePressed = true;
        if (e.code === "ControlLeft" || e.code === "ControlRight") firing = true;
        const wk = weaponKeys[e.code];
        if (wk !== undefined) player.selectWeapon(wk);
        keys.add(e.code);
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent): void => {
        if (e.code === "ControlLeft" || e.code === "ControlRight") firing = false;
        keys.delete(e.code);
    };
    const onMouseDown = (e: MouseEvent): void => {
        if (e.button === 0) {
            firing = true;
            sound.resume();
        }
    };
    const onMouseUp = (e: MouseEvent): void => {
        if (e.button === 0) firing = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", () => sound.resume(), { once: true });

    onBeforeRender(scene, (deltaMs) => {
        const dt = Math.min(deltaMs / 1000, MAX_FRAME_SECONDS);
        const dead = player.dead;

        // Play the death sound once on the kill, and reset the flag on respawn.
        if (dead && !wasDead) sound.play("PLDETH");
        wasDead = dead;

        // The view can still be turned while dead (Doom lets you look around).
        const strafeMod = keys.has("AltLeft") || keys.has("AltRight");
        if (!strafeMod) {
            if (keys.has("ArrowLeft")) yaw += TURN_SPEED * dt;
            if (keys.has("ArrowRight")) yaw -= TURN_SPEED * dt;
        }

        const fx = Math.cos(yaw);
        const fz = Math.sin(yaw);
        const speed = (keys.has("ShiftLeft") ? 2 : 1) * MOVE_SPEED * dt;
        let mx = 0;
        let mz = 0;
        // No movement, firing, or door use once dead; SPACE respawns instead.
        if (!dead) {
            if (keys.has("ArrowUp")) {
                mx += fx;
                mz += fz;
            }
            if (keys.has("ArrowDown")) {
                mx -= fx;
                mz -= fz;
            }
            const strafeLeft = keys.has("Comma") || (strafeMod && keys.has("ArrowLeft"));
            const strafeRight = keys.has("Period") || (strafeMod && keys.has("ArrowRight"));
            if (strafeLeft) {
                mx -= fz;
                mz += fx;
            }
            if (strafeRight) {
                mx += fz;
                mz -= fx;
            }
        }
        const fromX = eye.x;
        const fromZ = eye.z;
        const currentFloor = floorHeightAt(map, eye.x, eye.z);
        const moved = tryMove(collLines, eye.x, eye.z, mx * speed, mz * speed, currentFloor, map.sectors);
        // Block against solid things (monsters, barrels, columns) like vanilla Doom,
        // then re-resolve walls so a thing can't shove the player through geometry.
        const blockers = world.mobjs.filter((m) => (m.flags & MF.SOLID) !== 0 && m.health > 0);
        const pushed = blockAgainstThings(moved.x, moved.y, blockers, PLAYER_RADIUS);
        const resolved = tryMove(collLines, pushed.x, pushed.y, 0, 0, currentFloor, map.sectors);
        eye.x = resolved.x;
        eye.z = resolved.y;
        playerSectorRef.value = sectorIndexAt(map, eye.x, eye.z);

        // World interactivity: USE (Space), walk-over triggers, and timed movers.
        if (usePressed) {
            if (dead) {
                respawn();
            } else {
                specials.tryUse(eye.x, eye.z, yaw);
            }
            usePressed = false;
        }
        if (fromX !== eye.x || fromZ !== eye.z) {
            specials.crossLines(fromX, fromZ, eye.x, eye.z);
        }
        ticAccum += dt;
        while (ticAccum >= TIC_SECONDS) {
            specials.tic();
            // Sync the player mobj to the camera so monsters can see/target it.
            world.player.x = eye.x;
            world.player.y = eye.z;
            world.player.z = floorHeightAt(map, eye.x, eye.z);
            world.player.angle = yaw;
            if (firing && !dead) player.fire();
            player.tic();
            world.tic();
            ticAccum -= TIC_SECONDS;
        }
        if (specials.consumeDirty()) {
            dynamicGeo.rebuild();
        }

        // View height: stand at eye level when alive; when dead, sink the camera
        // toward the corpse height like Doom's P_DeathThink.
        if (dead) {
            viewHeight = Math.max(DEATH_VIEW_HEIGHT, viewHeight - DEATH_SINK_SPEED * dt);
        } else {
            viewHeight = VIEW_HEIGHT;
        }
        eye.y = floorHeightAt(map, eye.x, eye.z) + viewHeight;

        // Keep the sky dome centered on the camera so it has no parallax (infinite sky).
        if (sky) {
            sky.position.x = eye.x;
            sky.position.y = eye.y;
            sky.position.z = eye.z;
        }

        cam.position.x = eye.x;
        cam.position.y = eye.y;
        cam.position.z = eye.z;
        cam.target.x = eye.x + fx;
        cam.target.y = eye.y;
        cam.target.z = eye.z + fz;

        // Rebuild all mobj billboards once per frame, facing the camera.
        spriteRenderer.rebuild(world.collectSprites(eye.x, eye.z));
        weaponView.update(player, dt, fromX !== eye.x || fromZ !== eye.z);
        hud.update(dt);
    });
}
