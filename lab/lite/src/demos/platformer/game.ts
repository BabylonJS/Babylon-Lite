/**
 * Platformer game orchestrator — owns the world state, the fixed-timestep update,
 * and all sprite bookkeeping. Everything draws through Lite's batched 2D sprite
 * renderer; the gameplay (physics, AI, power states, scoring) is hand-rolled in
 * this `platformer/` module folder.
 *
 * Sprite slots are pre-allocated and reused: `removeSprite2DIndex` swap-removes
 * (which would renumber indices), so entities own a stable slot for the whole
 * level and are hidden with `visible:false` rather than removed.
 */

import {
    addSprite2DIndex,
    clearSprite2DLayer,
    createGridSpriteAtlas,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteRenderer,
    loadTexture2D,
    registerSpriteRenderer,
    setSprite2DShaderParams,
    spriteBlendAdditive,
    spriteBlendMultiply,
    startEngine,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
} from "babylon-lite";

import { loadPlatformerSheet, type PlatformerSheet } from "./atlas.js";
import { createCrtPostProcess } from "./crt.js";
import { PHYS, PLAYER_FIRE_FRAMES, PLAYER_FRAMES, TILE } from "./frames.js";
import { createInput, type InputController } from "./input.js";
import { createSfx, type Sfx } from "./audio.js";
import { createHud, type Hud } from "./hud.js";
import { buildWorld, type AreaId, type BlockKind, type LevelArea, type Pipe, type World } from "./level.js";
import { createParallax } from "./parallax.js";
import { makeFireballDataUrl, makeFireFlowerDataUrl } from "./fire.js";
import { makeSparkDataUrl } from "./juice.js";
import { IRIS_FRAGMENT, makePipeTextureDataUrl, makeWhiteTextureDataUrl } from "./portal.js";
import { LAVA_FRAGMENT } from "./lava.js";
import { LANTERN_FRAGMENT, makeGlowDataUrl } from "./lantern.js";
import { moveAndCollide, overlaps, type AABB, type CollisionMap } from "./physics.js";
import { demoAssetUrl } from "../demo-asset-url.js";

import type {
    BlockState,
    BossProjectile,
    BossState,
    Debris,
    EnemyState,
    Fireball,
    MovingPlatform,
    Phase,
    PickupState,
    Popup,
    Spark,
    TrailPose,
} from "./entities.js";
import {
    BOSS_H,
    BOSS_HURT_TIME,
    BOSS_MAX_HP,
    BOSS_PROJ_DRAW,
    BOSS_PROJ_MAX,
    BOSS_PROJ_SPEED,
    BOSS_SPEED,
    BOSS_VIS_SCALE,
    BOSS_W,
    COIN_DRAW,
    COIN_PICK_HALF,
    DEBRIS_DRAW,
    DEBRIS_LIFE,
    DEBRIS_MAX,
    ENEMY_VIS_SCALE,
    FIRE_COOLDOWN,
    FIREBALL_BOUNCE,
    FIREBALL_DRAW,
    FIREBALL_LIFE,
    FIREBALL_MAX,
    FIREBALL_SPEED,
    FLOWER_EMERGE_DUR,
    FLY_AMP,
    FLY_FREQ,
    FLY_SPEED,
    PICKUP_DRAW,
    PICKUP_FOOT,
    PIRANHA_RISE,
    piranhaEmerge,
    PLAYER_VIS_BIG,
    PLAYER_VIS_SMALL,
    POPUP_DIGIT_DRAW,
    POPUP_DIGITS,
    POPUP_LIFE,
    POPUP_MAX,
    POPUP_RISE,
    SKY,
    SPARK_DRAW,
    SPARK_GOLD,
    SPARK_LIFE,
    SPARK_MAX,
    SPARK_PER_BURST,
    SPARK_WHITE,
    STAR_FRAGMENT,
    START_TIME,
    STAR_TRAIL,
    STAR_TRAIL_GAP,
} from "./constants.js";

// Resolve the committed Kenney sprite sheets relative to THIS demo's bundle module,
// so they load under any deploy base path (the demos site serves ONLY the bundle dir,
// where copyDemoRuntimeAssets places `platformer/`). A root-absolute `/platformer/...`
// would 404 there.
const ASSET_BASE = demoAssetUrl("./platformer", import.meta.url);

export async function startGame(canvas: HTMLCanvasElement, engine: EngineContext): Promise<void> {
    const world: World = buildWorld();
    const allAreas = Object.values(world.areas);
    // Pool capacities are sized to the largest area so loadArea can refill any area.
    const maxOf = (pick: (a: LevelArea) => number): number => allAreas.reduce((m, a) => Math.max(m, pick(a)), 1);
    let level: LevelArea = world.areas[world.start];
    let worldW = level.cols * TILE;
    const worldH = level.rows * TILE;

    // ── Load art (Kenney "Platformer Art Deluxe", CC0) ──────────────────────
    // Deluxe puts grass/dirt/stone/castle terrain AND the box/brick blocks in ONE
    // tiles sheet (no separate "ground" sheet), so terrain + blocks share it.
    const [players, enemies, items, tiles, hud2d] = await Promise.all([
        loadPlatformerSheet(engine, `${ASSET_BASE}/players`),
        loadPlatformerSheet(engine, `${ASSET_BASE}/enemies`),
        loadPlatformerSheet(engine, `${ASSET_BASE}/items`),
        // The tiles sheet tessellates edge-to-edge, so use nearest filtering:
        // linear bleeds a dark fringe at frame edges → thin black seams.
        loadPlatformerSheet(engine, `${ASSET_BASE}/tiles`, { filter: "nearest" }),
        // HUD sheet supplies the digit glyphs (hud_0..hud_9) for floating score popups.
        loadPlatformerSheet(engine, `${ASSET_BASE}/hud`),
    ]);

    // ── Parallax background (multi-band, uvScroll) ────────────────────────────
    // Replaces the single tiled backdrop: a static sky gradient, drifting clouds,
    // and two rows of rolling hills, each scrolling at its own depth rate. Bands
    // occupy draw orders 0..3, behind every gameplay layer.
    const parallax = await createParallax(engine, 0);

    // ── Portal textures (warp pipe, cave backdrop, iris-wipe quad) ────────────
    const [pipeTex, backdropTex, whiteTex, fireFlowerTex, fireballTex, sparkTex, glowTex] = await Promise.all([
        loadTexture2D(engine, makePipeTextureDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, demoAssetUrl("./platformer/backgrounds/bg_castle.png", import.meta.url), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeWhiteTextureDataUrl(), { invertY: false, mipMaps: false }),
        loadTexture2D(engine, makeFireFlowerDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeFireballDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeSparkDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeGlowDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
    ]);
    const pipeAtlas = createGridSpriteAtlas(pipeTex, { cellWidthPx: pipeTex.width, cellHeightPx: pipeTex.height });
    const backdropAtlas = createGridSpriteAtlas(backdropTex, { cellWidthPx: backdropTex.width, cellHeightPx: backdropTex.height });
    const whiteAtlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: whiteTex.width, cellHeightPx: whiteTex.height });
    const sparkAtlas = createGridSpriteAtlas(sparkTex, { cellWidthPx: sparkTex.width, cellHeightPx: sparkTex.height });
    const fireFlowerAtlas = createGridSpriteAtlas(fireFlowerTex, { cellWidthPx: fireFlowerTex.width, cellHeightPx: fireFlowerTex.height });
    const fireballAtlas = createGridSpriteAtlas(fireballTex, { cellWidthPx: fireballTex.width, cellHeightPx: fireballTex.height });
    const glowAtlas = createGridSpriteAtlas(glowTex, { cellWidthPx: glowTex.width, cellHeightPx: glowTex.height });

    // ── Gameplay layers (back → front) ────────────────────────────────────────
    // Frame indices are atlas-specific, so each sheet needs its own layer(s).
    // Full-screen backdrop image (bg_castle), shown only underground (cave + castle), behind terrain.
    const backdropLayer = createSprite2DLayer(backdropAtlas, { capacity: 1, order: 4, pivot: [0, 0] });
    // Molten lava pools: procedural custom-shader quads (reuse the 1×1 white atlas),
    // drawn ABOVE the lantern (order 17) so the molten pool stays EMISSIVE: it glows in the
    // dark instead of being multiplied toward black by the lantern far from the player.
    const lavaShader = createSprite2DCustomShader({ fragment: LAVA_FRAGMENT });
    const lavaLayer = createSprite2DLayer(whiteAtlas, { capacity: maxOf((a) => a.lava.length), order: 17.2, customShader: lavaShader, pivot: [0, 0] });
    const terrainLayer = createSprite2DLayer(tiles.atlas, { capacity: maxOf((a) => a.terrain.length) + 4, order: 5, pivot: [0, 0] });
    // Player sprite while travelling through a pipe: a dedicated layer just BEHIND the
    // pipe (order 5.5 < pipeLayer's 6) so the player slides in/out occluded by the pipe.
    const pipeTravelLayer = createSprite2DLayer(players.atlas, { capacity: 1, order: 5.5, pivot: [0.5, 1] });
    // Piranha plants emerge from pipe mouths: drawn BEHIND the pipe (order 5.7 < pipe 6)
    // so the plant rises above the rim and sinks back behind it (instead of hovering in
    // front of the pipe). Shares the enemies atlas, but its own layer for the depth sort.
    const piranhaLayer = createSprite2DLayer(enemies.atlas, { capacity: maxOf((a) => a.enemies.filter((e) => e.kind === "piranha").length), order: 5.7, pivot: [0.5, 1] });
    const pipeLayer = createSprite2DLayer(pipeAtlas, { capacity: maxOf((a) => a.pipes.length), order: 6, pivot: [0, 0] });
    // Moving platforms (kinematic): drawn as bridge tiles, in front of terrain/pipes.
    const moverLayer = createSprite2DLayer(tiles.atlas, { capacity: maxOf((a) => a.movers.reduce((n, m) => n + m.w, 0)), order: 6.5, pivot: [0, 0] });
    const blockLayer = createSprite2DLayer(tiles.atlas, { capacity: maxOf((a) => a.blocks.length) + 16, order: 7, pivot: [0, 0] });
    // Area coins + flag (cleared/refilled per area by loadArea).
    const coinLayer = createSprite2DLayer(items.atlas, { capacity: maxOf((a) => a.coins.length) + 2, order: 8, pivot: [0.5, 0.5] });
    // Global pickup pool (coin-pops, stars) — persistent, NOT cleared by loadArea.
    const itemLayer = createSprite2DLayer(items.atlas, { capacity: 16, order: 8.1, pivot: [0.5, 0.5] });
    // Mushrooms come from the *items* sheet, so they need a centre-pivot items layer.
    const shroomLayer = createSprite2DLayer(items.atlas, { capacity: 8, order: 9, pivot: [0.5, 0.5] });
    // Fire flowers (procedural texture) get their own centre-pivot layer.
    const fireFlowerLayer = createSprite2DLayer(fireFlowerAtlas, { capacity: 4, order: 9, pivot: [0.5, 0.5] });
    // Fire flowers EMERGING from a block draw on this layer (order 6.8), BEHIND the block
    // layer (7), so the box occludes the flower's lower half as it rises out of the box.
    const fireFlowerEmergeLayer = createSprite2DLayer(fireFlowerAtlas, { capacity: 2, order: 6.8, pivot: [0.5, 0.5] });
    const enemyLayer = createSprite2DLayer(enemies.atlas, { capacity: maxOf((a) => a.enemies.length) + 2, order: 10, pivot: [0.5, 1] });
    // Castle boss: a big enemy-atlas sprite (one slot) + its arcing projectiles (additive).
    const bossLayer = createSprite2DLayer(enemies.atlas, { capacity: 1, order: 10.2, pivot: [0.5, 1] });
    const bossProjLayer = createSprite2DLayer(fireballAtlas, { capacity: BOSS_PROJ_MAX, order: 13, blendMode: spriteBlendAdditive, pivot: [0.5, 0.5] });
    // Star-power afterimage trail: additive ghosts of the player (glow stacks), drawn
    // just behind the player and hidden unless invincible.
    const trailLayer = createSprite2DLayer(players.atlas, { capacity: STAR_TRAIL, order: 11, blendMode: spriteBlendAdditive, pivot: [0.5, 1] });
    // The player's invincibility look is a per-layer custom fragment shader (rainbow
    // palette-cycle + sparkle), its intensity driven each frame via setSprite2DShaderParams.
    const starShader = createSprite2DCustomShader({ fragment: STAR_FRAGMENT });
    const playerLayer = createSprite2DLayer(players.atlas, { capacity: 2, order: 12, customShader: starShader, pivot: [0.5, 1] });
    // Fireball projectiles: additive glow layer, in front of the player.
    const fireballLayer = createSprite2DLayer(fireballAtlas, { capacity: FIREBALL_MAX + 1, order: 13, blendMode: spriteBlendAdditive, pivot: [0.5, 0.5] });
    // Coin/stomp "juice": additive sparkle bursts + floating score-digit popups.
    const sparkLayer = createSprite2DLayer(sparkAtlas, { capacity: SPARK_MAX, order: 14, blendMode: spriteBlendAdditive, pivot: [0.5, 0.5] });
    const digitLayer = createSprite2DLayer(hud2d.atlas, { capacity: POPUP_MAX * POPUP_DIGITS, order: 15, pivot: [0.5, 0.5] });
    // Brick-break debris: spinning brick chunks from the *items* sheet (centre pivot to rotate).
    const debrisLayer = createSprite2DLayer(items.atlas, { capacity: DEBRIS_MAX, order: 16, pivot: [0.5, 0.5] });
    // Wall torches (the tiles "torch" frame), drawn in front of the cave walls.
    const torchLayer = createSprite2DLayer(tiles.atlas, { capacity: maxOf((a) => a.torches.length), order: 9.5, pivot: [0.5, 1] });
    // Underground "lantern": a full-screen multiply-darkness pool that follows the player (#8).
    const lanternShader = createSprite2DCustomShader({ fragment: LANTERN_FRAGMENT });
    const lanternLayer = createSprite2DLayer(whiteAtlas, { capacity: 1, order: 17, pivot: [0, 0], customShader: lanternShader, blendMode: spriteBlendMultiply });
    // Torch glows: additive warm haloes in front of the darkness so torches shine through.
    const torchGlowLayer = createSprite2DLayer(glowAtlas, { capacity: maxOf((a) => a.torches.length + a.lava.length), order: 17.5, pivot: [0.5, 0.5], blendMode: spriteBlendAdditive });
    // Fullscreen iris-wipe transition (custom-shader quad), on top of everything.
    const irisShader = createSprite2DCustomShader({ fragment: IRIS_FRAGMENT });
    const irisLayer = createSprite2DLayer(whiteAtlas, { capacity: 1, order: 20, pivot: [0, 0], customShader: irisShader });

    const renderer = createSpriteRenderer(engine, {
        layers: [...parallax.layers, backdropLayer, lavaLayer, terrainLayer, pipeTravelLayer, piranhaLayer, pipeLayer, moverLayer, fireFlowerEmergeLayer, blockLayer, coinLayer, itemLayer, shroomLayer, fireFlowerLayer, enemyLayer, bossLayer, torchLayer, trailLayer, playerLayer, fireballLayer, bossProjLayer, sparkLayer, digitLayer, debrisLayer, lanternLayer, torchGlowLayer, irisLayer],
        clearValue: SKY,
    });
    registerSpriteRenderer(renderer);

    // CRT / scanline post-process (#17). Redirects the scene renderer into an
    // offscreen texture and presents it through a curved-glass CRT shader. Default
    // ON; press "C" to toggle. Driven once per frame from the main loop via crt.sync().
    const crt = createCrtPostProcess(engine, renderer, true);
    window.addEventListener("keydown", (e) => {
        if ((e.key === "c" || e.key === "C") && !e.repeat) {
            const nowOn = crt.toggle();
            hud.banner(nowOn ? "CRT ON" : "CRT OFF");
            window.setTimeout(() => hud.banner(null), 700);
        }
    });

    // Pause (P): hold a static frame while playing; press again to resume.
    let paused = false;
    window.addEventListener("keydown", (e) => {
        if ((e.key === "p" || e.key === "P") && !e.repeat && game.phase === "playing") {
            paused = !paused;
            hud.banner(paused ? "PAUSED" : null);
            sfx.music.setPaused(paused);
        }
    });

    // Persistent single-slot overlays, reused across areas (repositioned/hidden).
    const backdropSlot = addSprite2DIndex(backdropLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
    const lanternSlot = addSprite2DIndex(lanternLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1.77, 0, 0, 1], visible: false });
    const pipeTravelSlot = addSprite2DIndex(pipeTravelLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
    const irisSlot = addSprite2DIndex(irisLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
    const torchFrame = tiles.frameOf("torch");
    const bridgeFrame = tiles.frameOf("bridge");
    const coinFrame = items.frameOf("coinGold");
    const flagFrame = items.frameOf("flagGreen");
    // The flag POLE is drawn on the (tiles-atlas) block layer, so it must use a tiles
    // frame — the vertical rope reads as a clean flagpole. (Using the items "chain"
    // index here mapped to a random tiles cell — the "! cube" the pole used to show.)
    const poleFrame = tiles.frameOf("ropeVertical");
    const MOVER_H = TILE * 0.6; // moving-platform collision thickness
    // The Kenney "bridge" frame fills only the bottom ~29% of its cell; this is the
    // transparent top padding, used to seat the visible plank on the collision surface.
    const BRIDGE_TOP_PAD = 0.714;

    const blockFrame = (kind: BlockKind): number => {
        switch (kind) {
            case "brick":
                return tiles.frameOf("brickWall");
            case "coin-block":
            case "mushroom-block":
            case "star-block":
                return tiles.frameOf("boxItem");
        }
    };

    // ── Per-area collections, emptied + refilled by loadArea() ────────────────
    // These are mutated IN PLACE (never reassigned) so the many closures below keep
    // a stable reference. loadArea() clears the per-area layers, then repopulates.
    interface CoinState {
        x: number;
        y: number;
        collected: boolean;
        slot: number;
    }
    const lavaSlots: number[] = [];
    const torchSlots: number[] = [];
    const torchGlowSlots: number[] = [];
    const lavaGlowSlots: number[] = [];
    const pipeSlots: number[] = [];
    const movers: MovingPlatform[] = [];
    const terrainSlots: number[] = [];
    const blocks: BlockState[] = [];
    const poleSlots: number[] = [];
    const coins: CoinState[] = [];
    let flagX = -1;
    let flagSlot = -1;
    let hasFlag = false;

    // Pickup pools. coin-pops and stars come from the items sheet; mushrooms from
    // the tiles sheet, so each kind lives on a pool bound to the matching atlas.
    const pickups: PickupState[] = [];
    const makePool = (count: number, kind: PickupState["kind"], layer: Sprite2DLayer, frame: number): void => {
        for (let i = 0; i < count; i++) {
            pickups.push({
                kind,
                box: { x: 0, y: 0, w: TILE * 0.7, h: TILE * 0.7 },
                vx: 0,
                vy: 0,
                active: false,
                life: 0,
                slot: addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [TILE * 0.7, TILE * 0.7], frame, visible: false }),
                layer,
                emergeT: 0,
                emergeEndY: 0,
                emergeSlot: kind === "fire-flower" ? addSprite2DIndex(fireFlowerEmergeLayer, { positionPx: [0, 0], sizePx: [TILE * 0.7, TILE * 0.7], frame, visible: false }) : -1,
            });
        }
    };
    makePool(8, "coin-pop", itemLayer, coinFrame);
    makePool(4, "mushroom", shroomLayer, items.frameOf("mushroomRed"));
    makePool(4, "star", itemLayer, items.frameOf("star"));
    makePool(2, "fire-flower", fireFlowerLayer, 0);

    // Fireball projectile pool (additive glow layer).
    const fireballs: Fireball[] = [];
    for (let i = 0; i < FIREBALL_MAX + 1; i++) {
        fireballs.push({
            box: { x: 0, y: 0, w: TILE * 0.4, h: TILE * 0.4 },
            vx: 0,
            vy: 0,
            life: 0,
            active: false,
            slot: addSprite2DIndex(fireballLayer, { positionPx: [0, 0], sizePx: [FIREBALL_DRAW, FIREBALL_DRAW], frame: 0, visible: false }),
        });
    }
    let fireCooldown = 0;

    // ── Juice pools: additive sparkle bursts + floating score popups ──────────
    const sparks: Spark[] = [];
    for (let i = 0; i < SPARK_MAX; i++) {
        sparks.push({
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            life: 0,
            maxLife: SPARK_LIFE,
            active: false,
            color: SPARK_WHITE,
            slot: addSprite2DIndex(sparkLayer, { positionPx: [0, 0], sizePx: [SPARK_DRAW, SPARK_DRAW], frame: 0, visible: false }),
        });
    }
    /** Emit a ring of additive sparks at a world point, tinted gold (coins) or white (stomps). */
    const burstSparks = (x: number, y: number, color: readonly [number, number, number], count = SPARK_PER_BURST): void => {
        for (let i = 0; i < count; i++) {
            const s = sparks.find((q) => !q.active);
            if (!s) break;
            const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
            const spd = TILE * (2 + Math.random() * 2.4);
            s.active = true;
            s.x = x;
            s.y = y;
            s.vx = Math.cos(a) * spd;
            s.vy = Math.sin(a) * spd - TILE * 1.5; // bias upward
            s.life = SPARK_LIFE;
            s.maxLife = SPARK_LIFE;
            s.color = color;
            updateSprite2DIndex(sparkLayer, s.slot, { visible: true });
        }
    };
    const killSpark = (s: Spark): void => {
        s.active = false;
        updateSprite2DIndex(sparkLayer, s.slot, { visible: false });
    };
    const updateSpark = (s: Spark, dt: number): void => {
        s.life -= dt;
        if (s.life <= 0) {
            killSpark(s);
            return;
        }
        s.vy += PHYS.gravity * 0.5 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
    };

    // Score popups: each owns a fixed run of POPUP_DIGITS digit slots on the digit layer.
    const popups: Popup[] = [];
    for (let i = 0; i < POPUP_MAX; i++) {
        const slots: number[] = [];
        for (let d = 0; d < POPUP_DIGITS; d++) {
            slots.push(addSprite2DIndex(digitLayer, { positionPx: [0, 0], sizePx: [POPUP_DIGIT_DRAW, POPUP_DIGIT_DRAW], frame: 0, visible: false }));
        }
        popups.push({ x: 0, y: 0, life: 0, active: false, digits: [], slots });
    }
    const digitFrame = (d: number): number => hud2d.frameOf(`hud_${d}`);
    /** Float a score value (e.g. 100) upward from a world point. */
    const spawnPopup = (value: number, x: number, y: number): void => {
        const p = popups.find((q) => !q.active);
        if (!p) return;
        p.active = true;
        p.x = x;
        p.y = y;
        p.life = POPUP_LIFE;
        const text = value.toString().slice(0, POPUP_DIGITS);
        p.digits = text.split("").map((ch) => digitFrame(Number(ch)));
    };
    const hidePopup = (p: Popup): void => {
        p.active = false;
        for (const slot of p.slots) updateSprite2DIndex(digitLayer, slot, { visible: false });
    };

    /** One-shot juice at a world point: a sparkle burst + a floating score popup. */
    const juicePop = (x: number, y: number, value: number, color: readonly [number, number, number]): void => {
        burstSparks(x, y, color);
        spawnPopup(value, x, y);
    };

    // Brick-break debris pool: spinning chunks from the items sheet's brick-particle frames.
    const debris: Debris[] = [];
    const particleFrames = ["particleBrick1a", "particleBrick1b"].map((n) => items.frameOf(n));
    for (let i = 0; i < DEBRIS_MAX; i++) {
        debris.push({
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            rot: 0,
            spin: 0,
            life: 0,
            active: false,
            slot: addSprite2DIndex(debrisLayer, { positionPx: [0, 0], sizePx: [DEBRIS_DRAW, DEBRIS_DRAW], frame: particleFrames[0]!, visible: false }),
        });
    }
    /** Throw four brick chunks out of a smashed brick at tile (cx, cy). */
    const burstDebris = (cx: number, cy: number): void => {
        const x = cx * TILE + TILE / 2;
        const y = cy * TILE + TILE / 2;
        // Classic 4-chunk spray: two inner (slower) + two outer (faster), up + out.
        const shots: readonly [number, number][] = [
            [-TILE * 2.0, -TILE * 7.5],
            [TILE * 2.0, -TILE * 7.5],
            [-TILE * 4.2, -TILE * 6.0],
            [TILE * 4.2, -TILE * 6.0],
        ];
        for (const [vx, vy] of shots) {
            const d = debris.find((q) => !q.active);
            if (!d) break;
            d.active = true;
            d.x = x;
            d.y = y;
            d.vx = vx;
            d.vy = vy;
            d.rot = Math.random() * Math.PI;
            d.spin = (vx < 0 ? -1 : 1) * (6 + Math.random() * 4);
            d.life = DEBRIS_LIFE;
            updateSprite2DIndex(debrisLayer, d.slot, { frame: particleFrames[Math.floor(Math.random() * particleFrames.length)]!, visible: true });
        }
    };
    const killDebris = (d: Debris): void => {
        d.active = false;
        updateSprite2DIndex(debrisLayer, d.slot, { visible: false });
    };
    const updateDebris = (d: Debris, dt: number): void => {
        d.life -= dt;
        if (d.life <= 0) {
            killDebris(d);
            return;
        }
        d.vy += PHYS.gravity * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.rot += d.spin * dt;
        if (d.y > worldH + TILE) killDebris(d);
    };

    /** Advance sparks + popups (runs every frame, independent of game phase). */
    const updateJuice = (dt: number): void => {
        for (const s of sparks) if (s.active) updateSpark(s, dt);
        for (const d of debris) if (d.active) updateDebris(d, dt);
        for (const p of popups) {
            if (!p.active) continue;
            p.life -= dt;
            if (p.life <= 0) hidePopup(p);
        }
    };

    const spawnPickup = (kind: PickupState["kind"], cx: number, cy: number): void => {
        const p = pickups.find((q) => !q.active && q.kind === kind);
        if (!p) return;
        p.active = true;
        p.box.x = cx * TILE + (TILE - p.box.w) / 2;
        p.box.y = cy * TILE;
        if (kind === "coin-pop") {
            p.box.w = p.box.h = TILE * 0.6;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = 0;
            p.vy = -640;
            p.life = 0.5;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [PICKUP_DRAW[kind], PICKUP_DRAW[kind]], visible: true });
        } else if (kind === "mushroom") {
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = PHYS.enemySpeed * 1.6;
            p.vy = -260;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [PICKUP_DRAW[kind], PICKUP_DRAW[kind]], visible: true });
        } else if (kind === "star") {
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = PHYS.enemySpeed * 1.4;
            p.vy = -420;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [PICKUP_DRAW[kind], PICKUP_DRAW[kind]], visible: true });
        } else {
            // Fire flower: rises OUT of the block (occluded by it) over FLOWER_EMERGE_DUR,
            // then sits on top. cy is the cell above the block, so the block top is at
            // (cy+1)*TILE: start a tile lower (inside the box) and rise to sit on the box top.
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = 0;
            p.vy = 0;
            p.emergeT = FLOWER_EMERGE_DUR;
            p.emergeEndY = (cy + 1) * TILE - p.box.h;
            p.box.y = (cy + 2) * TILE - p.box.h;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
            updateSprite2DIndex(fireFlowerEmergeLayer, p.emergeSlot, { sizePx: [PICKUP_DRAW[kind], PICKUP_DRAW[kind]], visible: true });
        }
    };

    // ── Enemies ───────────────────────────────────────────────────────────────
    // Collision-box dims per enemy kind (kept tight); the drawn sprite is scaled up
    // from these by ENEMY_DRAW_* so enemies read ~1 tile like the ?-blocks.
    const enemyBoxDims = (kind: EnemyState["kind"]): { w: number; h: number } => {
        if (kind === "snail") return { w: TILE * 0.82, h: TILE * 0.66 };
        if (kind === "fly") return { w: TILE * 0.74, h: TILE * 0.5 };
        if (kind === "piranha") return { w: TILE * 0.55, h: TILE * 1.4 };
        return { w: TILE * 0.82, h: TILE * 0.58 };
    };
    const enemyStartFrame = (kind: EnemyState["kind"]): string =>
        kind === "fly" ? "bee" : kind === "piranha" ? "snakeSlime" : kind === "snail" ? "snail_walk" : "slimeGreen_walk";
    // Refilled by loadArea() from the current area's enemy spawns (mutated in place).
    const enemyList: EnemyState[] = [];

    // ── Castle boss + its projectiles ─────────────────────────────────────────
    const boss: BossState = {
        active: false,
        box: { x: 0, y: 0, w: BOSS_W, h: BOSS_H },
        hp: BOSS_MAX_HP,
        dir: -1,
        vy: 0,
        hurt: 0,
        dying: 0,
        attackT: 1.5,
        animT: 0,
        slot: addSprite2DIndex(bossLayer, { positionPx: [0, 0], sizePx: [BOSS_W, BOSS_H], frame: enemies.frameOf("spider"), visible: false }),
    };
    const bossProjectiles: BossProjectile[] = [];
    for (let i = 0; i < BOSS_PROJ_MAX; i++) {
        bossProjectiles.push({
            box: { x: 0, y: 0, w: TILE * 0.5, h: TILE * 0.5 },
            vx: 0,
            vy: 0,
            active: false,
            slot: addSprite2DIndex(bossProjLayer, { positionPx: [0, 0], sizePx: [BOSS_PROJ_DRAW, BOSS_PROJ_DRAW], frame: 0, color: [0.7, 1, 0.5, 1], visible: false }),
        });
    }

    // ── Player ────────────────────────────────────────────────────────────────
    const smallSize = { w: TILE * 0.62, h: TILE * 0.92 };
    const bigSize = { w: TILE * 0.68, h: TILE * 1.5 };
    const player = {
        box: { x: 0, y: 0, w: smallSize.w, h: smallSize.h } as AABB,
        vx: 0,
        vy: 0,
        big: false,
        onGround: false,
        facing: 1 as -1 | 1,
        ducking: false,
        invuln: 0,
        star: 0,
        fire: false,
        coyote: 0,
        jumpBuf: 0,
        animT: 0,
        alive: true,
    };
    // Per-color stand-frame heights drive natural-frame scaling (green = small/big body, yellow = fire).
    const greenStandH = players.sizeOf(PLAYER_FRAMES.stand)[1];
    const yellowStandH = players.sizeOf(PLAYER_FIRE_FRAMES.stand)[1];
    const [standW0] = players.sizeOf(PLAYER_FRAMES.stand);
    const playerSlot = addSprite2DIndex(playerLayer, { positionPx: [0, 0], sizePx: [standW0 * (PLAYER_VIS_SMALL / greenStandH), PLAYER_VIS_SMALL], frame: players.frameOf(PLAYER_FRAMES.stand) });

    // Star afterimage slots (hidden until invincible) + the rolling pose history they sample.
    const trailSlots: number[] = [];
    for (let i = 0; i < STAR_TRAIL; i++) trailSlots.push(addSprite2DIndex(trailLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false }));
    const trailHist: TrailPose[] = [];

    const resetPlayer = (): void => {
        player.big = false;
        player.box.w = smallSize.w;
        player.box.h = smallSize.h;
        player.box.x = level.playerSpawn.cx * TILE + (TILE - player.box.w) / 2;
        player.box.y = (level.playerSpawn.cy + 1) * TILE - player.box.h;
        player.vx = 0;
        player.vy = 0;
        player.invuln = 0;
        player.star = 0;
        player.fire = false;
        player.alive = true;
        player.facing = 1;
    };
    resetPlayer();

    // ── Collision map ─────────────────────────────────────────────────────────
    const isSolid = (cx: number, cy: number): boolean => {
        if (cx < 0 || cx >= level.cols) return true; // walls at the world edges
        if (cy < 0 || cy >= level.rows) return false;
        return level.solid[cy * level.cols + cx] === 1;
    };
    const collision: CollisionMap = {
        cols: level.cols,
        rows: level.rows,
        isSolid,
        isOneWay: (cx, cy) => cx >= 0 && cx < level.cols && cy >= 0 && cy < level.rows && level.oneway[cy * level.cols + cx] === 1,
    };

    // ── Run-state ─────────────────────────────────────────────────────────────
    const game = { phase: "title" as Phase, score: 0, coins: 0, lives: 3, time: START_TIME, timer: 1.6, flagAnimT: 0, world: "1-1", combo: 0 };

    // Warp / area state. `inCave` drives the dark backdrop + flag-goal guard; `warp`
    // runs the iris-wipe transition and teleports the player at its darkest point.
    let inCave = false;
    // Pipe-warp animation timing: slide DOWN behind the source pipe, a brief iris
    // (the teleport is hidden at its darkest point), then slide UP out of the
    // destination pipe. The slide distance hides the (small-rendered) player behind
    // the 2-tile pipe.
    const WARP_DESCEND = 0.55;
    const WARP_IRIS = 0.5;
    const WARP_EMERGE = 0.55;
    const WARP_TOTAL = WARP_DESCEND + WARP_IRIS + WARP_EMERGE;
    const WARP_SLIDE = TILE * 1.8;
    const warp = { active: false, t: 0, teleported: false, cooldown: 0, toArea: world.start, toEntry: "start", label: "1-1", srcX: 0, srcTopY: 0, dstX: 0, dstTopY: 0 };

    // Flagpole finish (Mario-style), run during the "complete" phase. The flag sits at the
    // BOTTOM of the pole during play; on reaching the goal the player grabs the pole, the
    // flag RISES to the top + expands, the player SLIDES down to the floor, then strolls
    // off to the castle. The timeline is driven by `game.timer` counting down COMPLETE_DUR→0.
    const FLAG_RAISE_DUR = 0.9; // flag travels up the pole (player clinging at top)
    const FLAG_SLIDE_DUR = 0.9; // player slides down the pole
    const FLAG_WALK_DUR = 1.7; // stroll to the castle
    const COMPLETE_DUR = FLAG_RAISE_DUR + FLAG_SLIDE_DUR + FLAG_WALK_DUR;
    const flagSeq = { poleX: 0, grabFeetY: 0, baseFeetY: 0, walkFeetY: 0 };

    const sfx: Sfx = createSfx();
    const input: InputController = createInput(document.body);
    const hud: Hud = createHud(document.body);
    const resumeAudio = (): void => sfx.resume();
    window.addEventListener("pointerdown", resumeAudio, { once: false });
    window.addEventListener("keydown", resumeAudio, { once: false });

    const cam = { x: 0, y: 0 };
    // Attract-screen auto-pan accumulator (seconds). The title camera ping-pongs
    // across the overworld to show off the parallax + level while idle.
    let titleT = 0;
    const TITLE_PAN_SPEED = 0.03;
    hud.title(true); // start on the attract screen

    // ── Area loading: tear down + refill the per-area sprite layers ───────────
    /** Switch to `areaId`, rebuild every per-area entity/slot, and stand the player
     *  on the named entry cell. Pooled layers are cleared then repopulated, so areas
     *  can differ freely in size/theme with no shared mega-grid. */
    const loadArea = (areaId: AreaId, entryName: string): void => {
        level = world.areas[areaId];
        worldW = level.cols * TILE;
        inCave = level.theme !== "overworld"; // dark backdrop + lantern for cave AND castle
        game.world = level.worldLabel;

        // Tear down per-area layers (persistent overlay layers are untouched).
        clearSprite2DLayer(terrainLayer);
        clearSprite2DLayer(blockLayer);
        clearSprite2DLayer(coinLayer);
        clearSprite2DLayer(moverLayer);
        clearSprite2DLayer(enemyLayer);
        clearSprite2DLayer(piranhaLayer);
        clearSprite2DLayer(lavaLayer);
        clearSprite2DLayer(torchLayer);
        clearSprite2DLayer(torchGlowLayer);
        clearSprite2DLayer(pipeLayer);
        // Empty the JS collections (kept as the SAME array refs so closures still work).
        terrainSlots.length = 0;
        blocks.length = 0;
        poleSlots.length = 0;
        coins.length = 0;
        movers.length = 0;
        enemyList.length = 0;
        lavaSlots.length = 0;
        lavaGlowSlots.length = 0;
        torchSlots.length = 0;
        torchGlowSlots.length = 0;
        pipeSlots.length = 0;

        // Terrain.
        for (const t of level.terrain) {
            terrainSlots.push(addSprite2DIndex(terrainLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: tiles.frameOf(t.name) }));
        }
        // Interactive blocks (blockLayer), then the flag pole's chain column (also blockLayer).
        for (const b of level.blocks) {
            const slot = addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: blockFrame(b.kind) });
            blocks.push({ cx: b.cx, cy: b.cy, kind: b.kind, used: false, broken: false, slot, bump: 0 });
        }
        hasFlag = level.flag !== null;
        flagX = level.flag ? level.flag.cx : -1;
        if (level.flag) {
            for (let cy = level.flag.cy + 1; cy < level.rows; cy++) {
                if (level.solid[cy * level.cols + flagX]) break;
                poleSlots.push(addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: poleFrame }));
            }
        }
        // Coins (coinLayer), then the flag sprite LAST (stable slot after the coins).
        for (const c of level.coins) {
            coins.push({
                x: c.cx * TILE + TILE / 2,
                y: c.cy * TILE + TILE / 2,
                collected: false,
                slot: addSprite2DIndex(coinLayer, { positionPx: [0, 0], sizePx: [COIN_DRAW, COIN_DRAW], frame: coinFrame, visible: false }),
            });
        }
        flagSlot = hasFlag ? addSprite2DIndex(coinLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: flagFrame, visible: true }) : -1;

        // Moving platforms (moverLayer).
        for (const m of level.movers) {
            const w = m.w * TILE;
            const x0 = m.cx * TILE;
            const y0 = m.cy * TILE;
            const min = m.axis === "x" ? x0 : y0 - m.range * TILE;
            const max = m.axis === "x" ? x0 + m.range * TILE : y0;
            const slots: number[] = [];
            for (let i = 0; i < m.w; i++) slots.push(addSprite2DIndex(moverLayer, { positionPx: [0, 0], sizePx: [TILE, MOVER_H], frame: bridgeFrame }));
            movers.push({ box: { x: x0, y: y0, w, h: MOVER_H }, axis: m.axis, min, max, speed: m.speed * TILE, dir: (m.axis === "x" ? 1 : -1) as 1 | -1, dx: 0, dy: 0, slots });
        }
        // Lava pools (lavaLayer).
        for (const lv of level.lava) {
            lavaSlots.push(addSprite2DIndex(lavaLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [lv.w, lv.h, 0, 1], visible: false }));
        }
        // Torches + their glows; torch glow i aligns with torch i, then lava glows.
        for (let i = 0; i < level.torches.length; i++) {
            torchSlots.push(addSprite2DIndex(torchLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: torchFrame, visible: false }));
            torchGlowSlots.push(addSprite2DIndex(torchGlowLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1, 0.72, 0.32, 0.9], visible: false }));
        }
        for (let i = 0; i < level.lava.length; i++) {
            lavaGlowSlots.push(addSprite2DIndex(torchGlowLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1, 0.5, 0.16, 0.85], visible: false }));
        }
        // Pipes (pipeLayer).
        for (const p of level.pipes) {
            pipeSlots.push(addSprite2DIndex(pipeLayer, { positionPx: [0, 0], sizePx: [p.w * TILE, p.h * TILE], frame: 0 }));
        }
        // Enemies. Piranha plants live on the behind-pipe layer; everything else on the
        // front enemy layer. Each enemy stores its layer so updates target the right one.
        for (const e of level.enemies) {
            const { w, h } = enemyBoxDims(e.kind);
            const boxY = (e.cy + 1) * TILE - h;
            const layer = e.kind === "piranha" ? piranhaLayer : enemyLayer;
            const slot = addSprite2DIndex(layer, { positionPx: [0, 0], sizePx: [w, h], frame: enemies.frameOf(enemyStartFrame(e.kind)), visible: false });
            enemyList.push({ kind: e.kind, box: { x: e.cx * TILE + (TILE - w) / 2, y: boxY, w, h }, vx: -PHYS.enemySpeed, vy: 0, dir: -1, alive: true, shell: false, shellDir: 0, kickGrace: 0, dying: 0, slot, layer, animT: 0, homeY: boxY, phase: Math.random() * Math.PI * 2 });
        }

        // Boss (castle only). Stand it on its spawn cell; reset hp/state, hide projectiles.
        if (level.bossSpawn) {
            boss.active = true;
            boss.hp = BOSS_MAX_HP;
            boss.dir = -1;
            boss.vy = 0;
            boss.hurt = 0;
            boss.dying = 0;
            boss.attackT = 1.8;
            boss.animT = 0;
            boss.box.w = BOSS_W;
            boss.box.h = BOSS_H;
            boss.box.x = level.bossSpawn.cx * TILE + (TILE - BOSS_W) / 2;
            boss.box.y = (level.bossSpawn.cy + 1) * TILE - BOSS_H;
            updateSprite2DIndex(bossLayer, boss.slot, { visible: false }); // shown by project()
            hud.boss(boss.hp, BOSS_MAX_HP);
        } else {
            boss.active = false;
            updateSprite2DIndex(bossLayer, boss.slot, { visible: false });
            hud.boss(0, 0);
        }
        for (const bp of bossProjectiles) {
            bp.active = false;
            updateSprite2DIndex(bossProjLayer, bp.slot, { visible: false });
        }

        // Stand the player on the named entry cell (occupies-cell convention: centre at
        // (cx+0.5)·TILE, feet at the bottom of the cell).
        const entry = level.entries[entryName] ?? level.playerSpawn;
        player.box.x = entry.cx * TILE + (TILE - player.box.w) / 2;
        player.box.y = (entry.cy + 1) * TILE - player.box.h;
        player.vx = 0;
        player.vy = 0;
        player.onGround = true;
        // Background music follows the area: bright overworld theme, moody cave/castle theme.
        sfx.music.play(level.theme === "overworld" ? "overworld" : "cave");
    };

    // Build the starting area now so the first frame has content.
    loadArea(world.start, "start");

    // ── Helpers ───────────────────────────────────────────────────────────────
    const addScore = (n: number): void => {
        game.score += n;
    };
    // Escalating stomp-combo points (chain enemies mid-air without landing). The 8th
    // consecutive stomp grants a 1-up, then the chain resets — classic SMB cadence.
    const COMBO_PTS = [100, 200, 400, 800, 1000, 2000, 4000, 8000] as const;
    const comboStomp = (x: number, y: number): void => {
        const pts = COMBO_PTS[Math.min(game.combo, COMBO_PTS.length - 1)]!;
        game.combo++;
        addScore(pts);
        juicePop(x, y, pts, SPARK_WHITE);
        if (game.combo >= COMBO_PTS.length) {
            game.lives += 1;
            sfx.oneUp();
            game.combo = 0;
        }
    };
    const gainCoin = (): void => {
        game.coins += 1;
        addScore(200);
        sfx.coin();
        if (game.coins >= 100) {
            game.coins -= 100;
            game.lives += 1;
            sfx.oneUp();
        }
    };

    const hurtPlayer = (): void => {
        if (player.invuln > 0 || player.star > 0 || game.phase !== "playing") return;
        if (player.fire) {
            // Fire → big (lose the fire power but keep size), like classic SMB.
            player.fire = false;
            player.invuln = 1.6;
            sfx.powerDown();
        } else if (player.big) {
            player.big = false;
            const feet = player.box.y + player.box.h;
            player.box.w = smallSize.w;
            player.box.h = smallSize.h;
            player.box.y = feet - player.box.h;
            player.invuln = 1.6;
            sfx.powerDown();
        } else {
            killPlayer();
        }
    };
    const killPlayer = (): void => {
        player.alive = false;
        game.phase = "dying";
        game.timer = 1.8;
        player.vy = -760;
        sfx.die();
        sfx.music.stop();
        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.hit) });
    };

    const growPlayer = (): void => {
        if (!player.big) {
            const feet = player.box.y + player.box.h;
            player.big = true;
            player.box.w = bigSize.w;
            player.box.h = bigSize.h;
            player.box.y = feet - player.box.h;
            sfx.powerUp();
        } else {
            addScore(1000);
        }
    };

    // Fire flower: grow if small (no extra grow-score), then grant the fire power.
    const giveFire = (): void => {
        if (!player.big) {
            const feet = player.box.y + player.box.h;
            player.big = true;
            player.box.w = bigSize.w;
            player.box.h = bigSize.h;
            player.box.y = feet - player.box.h;
        }
        player.fire = true;
        sfx.powerUp();
    };

    // Fire a fireball in the facing direction (capped at FIREBALL_MAX live at once).
    const shootFireball = (): void => {
        let live = 0;
        for (const f of fireballs) if (f.active) live++;
        if (live >= FIREBALL_MAX) return;
        const f = fireballs.find((q) => !q.active);
        if (!f) return;
        f.active = true;
        f.life = FIREBALL_LIFE;
        f.box.x = player.box.x + player.box.w / 2 - f.box.w / 2;
        f.box.y = player.box.y + player.box.h * 0.35;
        // Add the player's FORWARD speed so the ball always pulls ahead by exactly
        // FIREBALL_SPEED relative to the player — otherwise running (maxRun > base
        // speed) lets the player overtake their own fireball.
        const forward = Math.max(0, player.vx * player.facing);
        f.vx = player.facing * (FIREBALL_SPEED + forward);
        f.vy = 140;
        sfx.fireball();
        updateSprite2DIndex(fireballLayer, f.slot, { visible: true });
    };

    const killFireball = (f: Fireball): void => {
        f.active = false;
        updateSprite2DIndex(fireballLayer, f.slot, { visible: false });
    };

    const updateFireball = (f: Fireball, dt: number): void => {
        f.life -= dt;
        if (f.life <= 0) {
            killFireball(f);
            return;
        }
        f.vy += PHYS.gravity * dt;
        if (f.vy > PHYS.maxFall) f.vy = PHYS.maxFall;
        const res = moveAndCollide(f.box, f.vx, f.vy, dt, collision);
        if (res.onGround) f.vy = -FIREBALL_BOUNCE; // bounce along the ground
        if (res.hitWall !== 0) {
            killFireball(f);
            return;
        }
        for (const e of enemyList) {
            if (!e.alive || e.dying > 0) continue;
            if (overlaps(f.box, e.box)) {
                e.dying = 0.4;
                e.vy = -360;
                updateSprite2DIndex(e.layer, e.slot, { frame: enemies.frameOf(e.kind === "snail" ? "snail_walk" : "slimeGreen_dead"), flipY: true });
                addScore(200);
                juicePop(e.box.x + e.box.w / 2, e.box.y, 200, SPARK_WHITE);
                sfx.kick();
                killFireball(f);
                return;
            }
        }
        // Fireballs also damage the castle boss.
        if (boss.active && boss.dying <= 0 && boss.hurt <= 0 && overlaps(f.box, boss.box)) {
            damageBoss();
            killFireball(f);
            return;
        }
        if (f.box.y > worldH + TILE) killFireball(f);
    };

    // Begin a pipe warp: freeze the player and run the iris transition; the area swap
    // (loadArea) + emerge happen at the darkest point (see the "warping" phase in the tick).
    const startWarp = (pipe: Pipe): void => {
        if (!pipe.toArea || !pipe.toEntry) return; // decorative pipe, not a warp
        game.phase = "warping";
        warp.active = true;
        warp.t = 0;
        warp.teleported = false;
        warp.toArea = pipe.toArea;
        warp.toEntry = pipe.toEntry;
        // Source pipe to slide DOWN behind (2 tiles wide → centre one tile right of `cx`).
        warp.srcX = (pipe.cx + pipe.w / 2) * TILE;
        warp.srcTopY = pipe.cy * TILE;
        // Destination is computed after loadArea repositions the player (see the tick).
        warp.dstX = warp.srcX;
        warp.dstTopY = warp.srcTopY;
        player.vx = 0;
        player.vy = 0;
        sfx.warp();
    };

    // Bump a block from below: return contents, flip to used/broken.
    const bumpBlock = (cx: number, cy: number): void => {
        const b = blocks.find((q) => q.cx === cx && q.cy === cy && !q.broken);
        if (!b) return;
        b.bump = 12;
        if (b.kind === "brick") {
            if (player.big) {
                b.broken = true;
                level.solid[cy * level.cols + cx] = 0;
                updateSprite2DIndex(blockLayer, b.slot, { visible: false });
                addScore(50);
                // Juice: spray four spinning brick chunks + a little dust sparkle.
                burstDebris(cx, cy);
                burstSparks(cx * TILE + TILE / 2, cy * TILE + TILE / 2, SPARK_WHITE, 5);
                sfx.breakBlock();
            } else {
                sfx.bump();
            }
            return;
        }
        if (b.used) {
            sfx.bump();
            return;
        }
        b.used = true;
        updateSprite2DIndex(blockLayer, b.slot, { frame: tiles.frameOf("boxItem_disabled") });
        if (b.kind === "coin-block") {
            spawnPickup("coin-pop", cx, cy - 1);
            gainCoin();
            juicePop(cx * TILE + TILE / 2, (cy - 1) * TILE, 200, SPARK_GOLD);
        } else if (b.kind === "mushroom-block") {
            // Mushroom when small (grow first); a fire flower once already big — classic progression.
            if (!player.big) spawnPickup("mushroom", cx, cy - 1);
            else spawnPickup("fire-flower", cx, cy - 1);
            sfx.powerUp();
        } else {
            spawnPickup("star", cx, cy - 1);
            sfx.powerUp();
        }
    };

    // ── Per-frame update ──────────────────────────────────────────────────────
    const updateMovers = (dt: number): void => {
        for (const mp of movers) {
            const prevX = mp.box.x;
            const prevY = mp.box.y;
            const step = mp.speed * dt * mp.dir;
            if (mp.axis === "x") {
                mp.box.x += step;
                if (mp.box.x <= mp.min) { mp.box.x = mp.min; mp.dir = 1; } else if (mp.box.x >= mp.max) { mp.box.x = mp.max; mp.dir = -1; }
            } else {
                mp.box.y += step;
                if (mp.box.y <= mp.min) { mp.box.y = mp.min; mp.dir = 1; } else if (mp.box.y >= mp.max) { mp.box.y = mp.max; mp.dir = -1; }
            }
            mp.dx = mp.box.x - prevX;
            mp.dy = mp.box.y - prevY;
        }
    };

    const updatePlaying = (dt: number): void => {
        const s = input.state;
        // Timers
        game.time -= dt;
        if (game.time <= 0) {
            game.time = 0;
            killPlayer();
            return;
        }
        if (player.invuln > 0) player.invuln -= dt;
        if (player.star > 0) player.star -= dt;
        if (warp.cooldown > 0) warp.cooldown -= dt;

        // Advance moving platforms first, so the rider-carry below uses fresh positions.
        updateMovers(dt);

        // Fire power: shoot a fireball on the fire button (run / B), rate-limited.
        if (fireCooldown > 0) fireCooldown -= dt;
        if (player.fire && s.firePressed && fireCooldown <= 0) {
            shootFireball();
            fireCooldown = FIRE_COOLDOWN;
        }

        // Horizontal input
        const wantRun = s.run;
        const maxSpeed = wantRun ? PHYS.maxRun : PHYS.maxWalk;
        const accel = player.onGround ? (wantRun ? PHYS.runAccel : PHYS.walkAccel) : PHYS.airAccel;
        player.ducking = player.onGround && s.down && !s.left && !s.right;

        let dir = 0;
        if (s.left) dir -= 1;
        if (s.right) dir += 1;
        if (player.ducking) dir = 0;

        if (dir !== 0) {
            player.vx += dir * accel * dt;
            player.facing = dir > 0 ? 1 : -1;
            if (player.vx > maxSpeed) player.vx = maxSpeed;
            if (player.vx < -maxSpeed) player.vx = -maxSpeed;
        } else if (player.onGround) {
            const f = PHYS.groundFriction * dt;
            if (player.vx > f) player.vx -= f;
            else if (player.vx < -f) player.vx += f;
            else player.vx = 0;
        }

        // Jump (coyote-time + input buffer)
        if (player.onGround) player.coyote = PHYS.coyote;
        else player.coyote -= dt;
        if (s.jumpPressed) player.jumpBuf = PHYS.jumpBuffer;
        else player.jumpBuf -= dt;

        if (player.jumpBuf > 0 && player.coyote > 0) {
            player.vy = -PHYS.jumpSpeed;
            player.onGround = false;
            player.coyote = 0;
            player.jumpBuf = 0;
            sfx.jump();
        }

        // Gravity (variable jump height while holding)
        const g = player.vy < 0 && s.jumpHeld ? PHYS.jumpHoldGravity : PHYS.gravity;
        player.vy += g * dt;
        if (player.vy > PHYS.maxFall) player.vy = PHYS.maxFall;

        // Integrate + collide
        const res = moveAndCollide(player.box, player.vx, player.vy, dt, collision);
        player.vx = res.vx;
        player.vy = res.vy;
        player.onGround = res.onGround;
        if (res.hitCeiling && res.ceilingCell) bumpBlock(res.ceilingCell.cx, res.ceilingCell.cy);

        // Ride moving platforms: land on / be carried by a kinematic platform when
        // standing on its top (not while jumping up through it). Runs before the pit
        // check so a player riding a platform over a pit isn't counted as fallen.
        for (const mp of movers) {
            const feet = player.box.y + player.box.h;
            const overlapX = player.box.x + player.box.w > mp.box.x + 2 && player.box.x < mp.box.x + mp.box.w - 2;
            if (overlapX && player.vy >= -1 && feet >= mp.box.y - 8 && feet <= mp.box.y + 16) {
                player.box.y = mp.box.y - player.box.h;
                player.box.x += mp.dx; // carry horizontally with the platform
                player.vy = 0;
                player.onGround = true;
            }
        }

        // Fell into a pit
        if (player.box.y > worldH + TILE) {
            killPlayer();
            return;
        }

        // Touched molten lava → instant death (underground hazard). A small inset keeps
        // standing on the channel lip / stepping-stones safe; only dipping in is fatal.
        for (const lv of level.lava) {
            const lx = lv.cx * TILE;
            const ly = lv.cy * TILE;
            if (
                player.box.x + player.box.w > lx + TILE * 0.12 &&
                player.box.x < lx + lv.w * TILE - TILE * 0.12 &&
                player.box.y + player.box.h > ly + TILE * 0.2
            ) {
                killPlayer();
                return;
            }
        }

        // Pipe warp: duck while standing on a pipe's top edge.
        if (warp.cooldown <= 0 && player.onGround && s.down) {
            const cxw = player.box.x + player.box.w / 2;
            const feet = player.box.y + player.box.h;
            for (const pipe of level.pipes) {
                if (!pipe.toArea) continue; // decorative / piranha / emerge pipes aren't warps
                const left = pipe.cx * TILE;
                const right = (pipe.cx + pipe.w) * TILE;
                if (cxw >= left && cxw <= right && Math.abs(feet - pipe.cy * TILE) < TILE * 0.5) {
                    startWarp(pipe);
                    return;
                }
            }
        }

        // Enemies. The stomp-combo resets once the player is back on solid footing
        // (it only escalates while chaining mid-air bounces between enemies).
        if (player.onGround) game.combo = 0;
        for (const e of enemyList) {
            if (!e.alive) continue;
            updateEnemy(e, dt);
            resolveEnemyVsPlayer(e);
        }

        // Castle boss + its projectiles.
        updateBoss(dt);
        updateBossProjectiles(dt);

        // Pickups
        for (const p of pickups) {
            if (!p.active) continue;
            updatePickup(p, dt);
        }

        // Fireballs
        for (const f of fireballs) {
            if (!f.active) continue;
            updateFireball(f, dt);
        }

        // Coins
        for (const c of coins) {
            if (c.collected) continue;
            const cb: AABB = { x: c.x - COIN_PICK_HALF, y: c.y - COIN_PICK_HALF, w: COIN_PICK_HALF * 2, h: COIN_PICK_HALF * 2 };
            if (overlaps(player.box, cb)) {
                c.collected = true;
                updateSprite2DIndex(coinLayer, c.slot, { visible: false });
                gainCoin();
                juicePop(c.x, c.y - TILE * 0.2, 200, SPARK_GOLD);
            }
        }

        // Goal: reach the flag column (only areas with a flag goal) → flagpole finish.
        // The flag sits on a solid pedestal, so trigger when the player reaches its base
        // (right edge at the flag column) rather than requiring the centre to pass it.
        if (hasFlag && level.flag && player.box.x + player.box.w >= flagX * TILE) {
            // Set up the Mario-style flagpole sequence. Pole base = first solid cell below
            // the flag at the flag column (its pedestal); slide down to land on TOP of it.
            let baseRow = level.flag.cy + 1;
            while (baseRow < level.rows && !level.solid[baseRow * level.cols + flagX]) baseRow++;
            const baseFeetY = baseRow * TILE; // top surface of the pedestal block
            const topFeetY = (level.flag.cy + 1) * TILE; // highest grab point (just under the flag)
            // Grab at the height the player ACTUALLY touched the pole, clamped to the span.
            const grabFeetY = Math.max(topFeetY, Math.min(baseFeetY, player.box.y + player.box.h));
            // Ground a couple tiles right of the pole = where the player strolls off to.
            const probeX = Math.min(level.cols - 1, flagX + 2);
            let groundRow = 0;
            while (groundRow < level.rows && !level.solid[groundRow * level.cols + probeX]) groundRow++;
            flagSeq.poleX = flagX * TILE + TILE / 2;
            flagSeq.grabFeetY = grabFeetY;
            flagSeq.baseFeetY = baseFeetY;
            flagSeq.walkFeetY = groundRow * TILE;
            player.box.x = flagX * TILE + (TILE - player.box.w) / 2; // snap onto the pole
            player.box.y = grabFeetY - player.box.h;
            player.vx = 0;
            player.vy = 0;
            player.star = 0;
            game.phase = "complete";
            game.timer = COMPLETE_DUR;
            // End-of-area tally: convert remaining time into bonus points.
            const bonus = Math.floor(game.time) * 50;
            addScore(bonus);
            sfx.music.stop();
            sfx.complete();
            hud.banner("STAGE CLEAR!", `TIME BONUS  ${bonus}  ·  TO THE CASTLE`);
        }
    };

    // Death/"hit" frame for each enemy kind (snail has no _dead → use _hit).
    const deadFrame = (kind: EnemyState["kind"]): string =>
        kind === "snail" ? "snail_hit" : kind === "fly" ? "bee_dead" : kind === "piranha" ? "snakeSlime_dead" : "slimeGreen_dead";

    const updateEnemy = (e: EnemyState, dt: number): void => {
        e.animT += dt;
        if (e.kickGrace > 0) e.kickGrace -= dt;
        if (e.dying > 0) {
            e.dying -= dt;
            if (e.dying <= 0) {
                e.alive = false;
                updateSprite2DIndex(e.layer, e.slot, { visible: false });
            }
            return;
        }

        // Flying enemy: horizontal drift (bounce off walls) + a vertical sine bob.
        if (e.kind === "fly") {
            e.phase += dt;
            const res = moveAndCollide(e.box, e.dir * FLY_SPEED, 0, dt, collision);
            if (res.hitWall !== 0) e.dir = (-e.dir) as -1 | 1;
            e.box.y = e.homeY + Math.sin(e.phase * FLY_FREQ) * FLY_AMP;
            return;
        }

        // Piranha plant: rises from / retracts into its pipe on a timed cycle. It
        // freezes (stays hidden) while the player stands right over the pipe, so it
        // never pops up "unfairly" into a player standing on the mouth.
        if (e.kind === "piranha") {
            const emerge = piranhaEmerge(e.phase);
            const nearPlayer = Math.abs(player.box.x + player.box.w / 2 - (e.box.x + e.box.w / 2)) < TILE * 1.6;
            if (!(emerge < 0.02 && nearPlayer)) e.phase += dt;
            e.box.y = e.homeY + (1 - piranhaEmerge(e.phase)) * PIRANHA_RISE;
            return;
        }

        // Movement
        let speed = e.kind === "snail" && e.shell ? e.shellDir * PHYS.shellSpeed : e.dir * PHYS.enemySpeed;
        if (e.shell && e.shellDir === 0) speed = 0;
        e.vx = speed;
        e.vy += PHYS.gravity * dt;
        if (e.vy > PHYS.maxFall) e.vy = PHYS.maxFall;

        const res = moveAndCollide(e.box, e.vx, e.vy, dt, collision);
        e.vy = res.vy;
        if (res.hitWall !== 0) {
            if (e.shell && e.shellDir !== 0) {
                e.shellDir = (-e.shellDir) as -1 | 1;
                sfx.bump();
            } else {
                e.dir = (-e.dir) as -1 | 1;
            }
        }

        // Ledge avoidance for walkers (not sliding shells)
        if (res.onGround && !(e.shell && e.shellDir !== 0)) {
            const aheadX = e.dir > 0 ? e.box.x + e.box.w + 2 : e.box.x - 2;
            const footCy = Math.floor((e.box.y + e.box.h + 4) / TILE);
            const aheadCx = Math.floor(aheadX / TILE);
            if (!isSolid(aheadCx, footCy)) e.dir = (-e.dir) as -1 | 1;
        }

        // Pit death
        if (e.box.y > worldH + TILE) {
            e.alive = false;
            updateSprite2DIndex(e.layer, e.slot, { visible: false });
            return;
        }

        // Shell-vs-walker kills
        if (e.shell && e.shellDir !== 0) {
            for (const o of enemyList) {
                if (o === e || !o.alive || o.dying > 0) continue;
                if (overlaps(e.box, o.box)) {
                    o.dying = 0.4;
                    o.vy = -360;
                    updateSprite2DIndex(o.layer, o.slot, { frame: enemies.frameOf(deadFrame(o.kind)), flipY: true });
                    addScore(200);
                    sfx.kick();
                }
            }
        }
    };

    const resolveEnemyVsPlayer = (e: EnemyState): void => {
        if (!player.alive || e.dying > 0) return;
        if (!overlaps(player.box, e.box)) return;

        const stomping = player.vy > 0 && player.box.y + player.box.h - e.box.y < TILE * 0.5;

        if (player.star > 0) {
            e.dying = 0.4;
            e.vy = -360;
            updateSprite2DIndex(e.layer, e.slot, { frame: enemies.frameOf(deadFrame(e.kind)), flipY: true });
            addScore(200);
            juicePop(e.box.x + e.box.w / 2, e.box.y, 200, SPARK_WHITE);
            sfx.kick();
            return;
        }

        // Piranha plants can't be stomped — touching one always hurts (fireballs kill them).
        if (e.kind === "piranha") {
            hurtPlayer();
            return;
        }

        if (stomping) {
            player.vy = -PHYS.stompBounce;
            player.box.y = e.box.y - player.box.h;
            if (e.kind === "snail" && !e.shell) {
                e.shell = true;
                e.shellDir = 0;
                e.box.h = TILE * 0.5;
                e.box.y = (Math.floor((e.box.y + e.box.h) / TILE) + 1) * TILE - e.box.h;
                updateSprite2DIndex(e.layer, e.slot, { frame: enemies.frameOf("snail_shell"), sizePx: [e.box.w, e.box.h] });
                comboStomp(e.box.x + e.box.w / 2, e.box.y);
                sfx.stomp();
            } else if (e.kind === "snail" && e.shell) {
                // Kick a resting shell, or stop a moving one.
                if (e.shellDir === 0) {
                    e.shellDir = (player.facing as -1 | 1);
                    e.kickGrace = 0.3;
                } else {
                    e.shellDir = 0;
                }
                addScore(100);
                sfx.kick();
            } else {
                e.dying = 0.35;
                updateSprite2DIndex(e.layer, e.slot, { frame: enemies.frameOf(deadFrame(e.kind)), sizePx: [e.box.w, e.box.h * 0.6] });
                comboStomp(e.box.x + e.box.w / 2, e.box.y);
                sfx.stomp();
            }
            return;
        }

        // A resting shell that the player walks into gets kicked, not hurt.
        if (e.kind === "snail" && e.shell && e.shellDir === 0) {
            e.shellDir = player.box.x < e.box.x ? 1 : -1;
            e.kickGrace = 0.3;
            addScore(100);
            sfx.kick();
            return;
        }

        // A shell the player JUST kicked passes through harmlessly until its grace elapses.
        if (e.kind === "snail" && e.shell && e.kickGrace > 0) return;

        hurtPlayer();
    };

    // ── Castle boss ───────────────────────────────────────────────────────────
    /** Win: clear the castle, tally a big bonus, celebrate, then drop back to the title. */
    const winGame = (): void => {
        if (game.phase === "won") return;
        game.phase = "won";
        game.timer = 6;
        addScore(5000 + Math.floor(game.time) * 50);
        sfx.music.stop();
        sfx.complete();
        burstSparks(player.box.x + player.box.w / 2, player.box.y, SPARK_GOLD, 16);
        hud.banner("YOU WIN!", "CASTLE CLEARED — thanks for playing!");
        hud.boss(0, 0); // hide the boss health bar
    };
    /** Deal one hit to the boss: flash + knockback, or start its death on the last hit. */
    const damageBoss = (): void => {
        if (!boss.active || boss.dying > 0 || boss.hurt > 0) return;
        boss.hp -= 1;
        boss.hurt = BOSS_HURT_TIME;
        boss.vy = -340; // little hop
        boss.dir = (player.box.x < boss.box.x ? 1 : -1) as -1 | 1; // recoil away from the player
        juicePop(boss.box.x + boss.box.w / 2, boss.box.y, 1000, SPARK_WHITE);
        burstSparks(boss.box.x + boss.box.w / 2, boss.box.y + boss.box.h / 2, SPARK_WHITE, 8);
        addScore(1000);
        hud.boss(Math.max(0, boss.hp), BOSS_MAX_HP);
        if (boss.hp <= 0) {
            boss.dying = 1.3;
            boss.vy = -420;
            sfx.kick();
            updateSprite2DIndex(bossLayer, boss.slot, { frame: enemies.frameOf("spider_dead"), flipY: true });
        } else {
            sfx.stomp();
        }
    };
    /** Lob an arcing projectile from the boss toward the player's current position. */
    const lobBossProjectile = (): void => {
        const bp = bossProjectiles.find((q) => !q.active);
        if (!bp) return;
        bp.active = true;
        bp.box.x = boss.box.x + boss.box.w / 2 - bp.box.w / 2;
        bp.box.y = boss.box.y - bp.box.h;
        const toward = player.box.x + player.box.w / 2 - (boss.box.x + boss.box.w / 2);
        bp.vx = Math.sign(toward || 1) * BOSS_PROJ_SPEED * 0.46;
        bp.vy = -BOSS_PROJ_SPEED * 0.72; // arc up; gravity brings it down toward the player
        updateSprite2DIndex(bossProjLayer, bp.slot, { visible: true });
        sfx.fireball();
    };
    const updateBoss = (dt: number): void => {
        if (!boss.active) return;
        boss.animT += dt;
        if (boss.dying > 0) {
            boss.dying -= dt;
            boss.vy += PHYS.gravity * dt;
            boss.box.y += boss.vy * dt;
            if (boss.dying <= 0) {
                boss.active = false;
                updateSprite2DIndex(bossLayer, boss.slot, { visible: false });
                winGame();
            }
            return;
        }
        if (boss.hurt > 0) boss.hurt -= dt;
        // Phase ramps with damage: faster pacing + more frequent lobs as hp drops.
        const tier = BOSS_MAX_HP - boss.hp; // 0,1,2
        const speedMul = 1 + tier * 0.4;
        const attackInterval = Math.max(1.1, 2.6 - tier * 0.55);
        // Pace along the floor, reversing at walls; gravity keeps it grounded.
        boss.vy += PHYS.gravity * dt;
        if (boss.vy > PHYS.maxFall) boss.vy = PHYS.maxFall;
        const res = moveAndCollide(boss.box, boss.dir * BOSS_SPEED * speedMul, boss.vy, dt, collision);
        boss.vy = res.vy;
        if (res.hitWall !== 0) boss.dir = (-boss.dir) as -1 | 1;
        // Attack timer.
        boss.attackT -= dt;
        if (boss.attackT <= 0) {
            lobBossProjectile();
            boss.attackT = attackInterval;
        }
        resolveBossVsPlayer();
    };
    const resolveBossVsPlayer = (): void => {
        if (!boss.active || boss.dying > 0 || !player.alive) return;
        if (!overlaps(player.box, boss.box)) return;
        // Stomp = descending and the player's feet are in the boss's upper third.
        const feet = player.box.y + player.box.h;
        const stomping = player.vy > 0 && feet - boss.box.y < boss.box.h * 0.6;
        if (player.star > 0) {
            player.vy = -PHYS.stompBounce;
            damageBoss();
            return;
        }
        if (stomping) {
            player.vy = -PHYS.stompBounce;
            player.box.y = boss.box.y - player.box.h;
            damageBoss();
            return;
        }
        // Side/again-after-hit contact only hurts when the boss isn't flashing.
        if (boss.hurt <= 0) hurtPlayer();
    };
    const updateBossProjectiles = (dt: number): void => {
        for (const bp of bossProjectiles) {
            if (!bp.active) continue;
            bp.vy += PHYS.gravity * 0.7 * dt;
            bp.box.x += bp.vx * dt;
            bp.box.y += bp.vy * dt;
            if (player.alive && overlaps(bp.box, player.box)) {
                bp.active = false;
                updateSprite2DIndex(bossProjLayer, bp.slot, { visible: false });
                hurtPlayer();
                continue;
            }
            if (bp.box.y > worldH + TILE || bp.box.x < 0 || bp.box.x > worldW) {
                bp.active = false;
                updateSprite2DIndex(bossProjLayer, bp.slot, { visible: false });
            }
        }
    };

    const updatePickup = (p: PickupState, dt: number): void => {
        // Fire flower emerging from its block: rise (eased) from inside the box up to sitting
        // on top, drawn on the behind-block layer. No physics / cannot be collected until out.
        if (p.emergeT > 0) {
            p.emergeT -= dt;
            const k = Math.min(1, 1 - p.emergeT / FLOWER_EMERGE_DUR);
            const ease = k * k * (3 - 2 * k);
            p.box.y = p.emergeEndY + TILE - ease * TILE;
            if (p.emergeT <= 0) {
                p.emergeT = 0;
                p.box.y = p.emergeEndY;
                p.vy = 0;
                updateSprite2DIndex(fireFlowerEmergeLayer, p.emergeSlot, { visible: false });
                updateSprite2DIndex(p.layer, p.slot, { sizePx: [PICKUP_DRAW[p.kind], PICKUP_DRAW[p.kind]], visible: true });
            }
            return;
        }
        if (p.kind === "coin-pop") {
            p.box.y += p.vy * dt;
            p.vy += PHYS.gravity * 1.4 * dt;
            p.life -= dt;
            if (p.life <= 0) {
                p.active = false;
                updateSprite2DIndex(p.layer, p.slot, { visible: false });
            }
            return;
        }
        // Mushroom / star: gravity + ground/wall bounce
        p.vy += PHYS.gravity * dt;
        if (p.vy > PHYS.maxFall) p.vy = PHYS.maxFall;
        const res = moveAndCollide(p.box, p.vx, p.vy, dt, collision);
        p.vy = res.vy;
        if (res.hitWall !== 0) p.vx = -p.vx;
        if (p.kind === "star" && res.onGround) p.vy = -560; // star hops
        if (overlaps(player.box, p.box)) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
            if (p.kind === "mushroom") {
                growPlayer();
                addScore(1000);
            } else if (p.kind === "fire-flower") {
                giveFire();
                addScore(1000);
            } else {
                player.star = 8;
                sfx.powerUp();
                addScore(1000);
            }
        } else if (p.box.y > worldH + TILE) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
        }
    };

    // ── Rendering projection ──────────────────────────────────────────────────
    const project = (): void => {
        const cw = canvas.width || 1;
        const ch = canvas.height || 1;
        const scale = ch / worldH;
        const viewW = cw / scale;
        if (game.phase === "title") {
            // Attract loop: slowly ping-pong the camera across the overworld (out to
            // the flag, never into the far-right cave) to flaunt the parallax + level.
            const flagCx = level.flag ? level.flag.cx : level.cols - 6;
            const span = Math.max(1, (flagCx + 6) * TILE - viewW);
            const tri = Math.abs(((titleT * TITLE_PAN_SPEED + 1) % 2) - 1); // 0→1→0
            cam.x = tri * span;
        } else {
            // Camera follows the player, clamped to the level.
            const targetX = player.box.x + player.box.w / 2 - viewW / 2;
            cam.x = Math.max(0, Math.min(worldW - viewW, targetX));
        }
        cam.y = 0;

        const sx = (wx: number): number => (wx - cam.x) * scale;
        const sy = (wy: number): number => (wy - cam.y) * scale;
        const ss = (w: number): number => w * scale;
        // Snap a whole tile to the integer device-pixel grid so adjacent tiles
        // tessellate exactly (no sub-pixel gap, no dark seam). Right/bottom edges
        // are derived from the *next* tile's snapped origin, not a rounded size.
        const snapTile = (cx: number, cy: number, yOffsetPx = 0): { pos: [number, number]; size: [number, number] } => {
            const x0 = Math.round(sx(cx * TILE));
            const x1 = Math.round(sx((cx + 1) * TILE));
            const y0 = Math.round(sy(cy * TILE) - yOffsetPx);
            const y1 = Math.round(sy((cy + 1) * TILE) - yOffsetPx);
            return { pos: [x0, y0], size: [x1 - x0, y1 - y0] };
        };

        // Multi-band parallax background (sky, clouds, two hill rows) via uvScroll.
        parallax.update(cam.x, game.flagAnimT, cw, ch);

        // Cave backdrop: full-screen dark panel, shown only while underground.
        updateSprite2DIndex(backdropLayer, backdropSlot, inCave ? { positionPx: [0, 0], sizePx: [cw, ch], visible: true } : { visible: false });

        // Molten lava pools (world-space; only the cave has them, shown while underground).
        for (let i = 0; i < lavaSlots.length; i++) {
            const lv = level.lava[i]!;
            if (!inCave) {
                updateSprite2DIndex(lavaLayer, lavaSlots[i]!, { visible: false });
                updateSprite2DIndex(torchGlowLayer, lavaGlowSlots[i]!, { visible: false });
                continue;
            }
            const x0 = Math.round(sx(lv.cx * TILE));
            const y0 = Math.round(sy(lv.cy * TILE));
            const x1 = Math.round(sx((lv.cx + lv.w) * TILE));
            const y1 = Math.round(sy((lv.cy + lv.h) * TILE));
            updateSprite2DIndex(lavaLayer, lavaSlots[i]!, { positionPx: [x0, y0], sizePx: [x1 - x0, y1 - y0], visible: true });
            // Warm additive glow rising off the pool so the molten lava lights the dark.
            const lflick = 0.8 + 0.2 * Math.sin(game.flagAnimT * 7 + i * 2.1);
            updateSprite2DIndex(torchGlowLayer, lavaGlowSlots[i]!, {
                positionPx: [sx((lv.cx + lv.w / 2) * TILE), sy((lv.cy + 0.1) * TILE)],
                sizePx: [ss(lv.w * TILE * 1.15), ss(TILE * 4) * lflick],
                color: [1, 0.5, 0.16, 0.8 * lflick],
                visible: true,
            });
        }

        // Wall torches + their additive warm glows, and the player-following lantern (cave only).
        for (let i = 0; i < torchSlots.length; i++) {
            const tc = level.torches[i]!;
            if (!inCave) {
                updateSprite2DIndex(torchLayer, torchSlots[i]!, { visible: false });
                updateSprite2DIndex(torchGlowLayer, torchGlowSlots[i]!, { visible: false });
                continue;
            }
            updateSprite2DIndex(torchLayer, torchSlots[i]!, { positionPx: [sx((tc.cx + 0.5) * TILE), sy((tc.cy + 1) * TILE)], sizePx: [ss(TILE), ss(TILE)], visible: true });
            const flick = 0.82 + 0.18 * Math.sin(game.flagAnimT * 9 + i * 1.7);
            const gsize = ss(TILE * 3.0) * flick;
            updateSprite2DIndex(torchGlowLayer, torchGlowSlots[i]!, {
                positionPx: [sx((tc.cx + 0.5) * TILE), sy((tc.cy + 0.3) * TILE)],
                sizePx: [gsize, gsize],
                color: [1, 0.72, 0.32, 0.85 * flick],
                visible: true,
            });
        }
        // Lantern: a multiply-darkness pool centred on the player. The castle keeps a
        // brighter ambient + wider pool than the cave so the boss fight reads clearly.
        if (inCave) {
            const castle = level.theme === "castle";
            const lpx = sx(player.box.x + player.box.w / 2) / cw;
            const lpy = sy(player.box.y + player.box.h * 0.4) / ch;
            setSprite2DShaderParams(lanternLayer, [lpx, lpy, castle ? 0.72 : 0.46, castle ? 0.66 : 0.2]);
            updateSprite2DIndex(lanternLayer, lanternSlot, { positionPx: [0, 0], sizePx: [cw, ch], color: [cw / ch, 0, 0, 1], visible: true });
        } else {
            updateSprite2DIndex(lanternLayer, lanternSlot, { visible: false });
        }

        // Warp pipes (world-space; naturally off-screen when their area isn't in view).
        for (let i = 0; i < level.pipes.length; i++) {
            const pp = level.pipes[i]!;
            const x0 = Math.round(sx(pp.cx * TILE));
            const x1 = Math.round(sx((pp.cx + pp.w) * TILE));
            const y0 = Math.round(sy(pp.cy * TILE));
            const y1 = Math.round(sy((pp.cy + pp.h) * TILE));
            updateSprite2DIndex(pipeLayer, pipeSlots[i]!, { positionPx: [x0, y0], sizePx: [x1 - x0, y1 - y0] });
        }

        // Moving platforms: lay each platform's bridge tiles at its current position.
        // The Kenney "bridge" frame fills only the bottom ~29% of its cell (transparent
        // above), so draw it a full tile tall and shift it UP by that top padding — that
        // puts the visible plank's top edge exactly on the platform's collision surface
        // (mp.box.y), instead of ~0.43 tile below it (which made the player look like it
        // was hovering above the platform).
        for (const mp of movers) {
            const ty0 = Math.round(sy(mp.box.y) - BRIDGE_TOP_PAD * ss(TILE));
            for (let i = 0; i < mp.slots.length; i++) {
                const tx0 = Math.round(sx(mp.box.x + i * TILE));
                const tx1 = Math.round(sx(mp.box.x + (i + 1) * TILE));
                updateSprite2DIndex(moverLayer, mp.slots[i]!, { positionPx: [tx0, ty0], sizePx: [tx1 - tx0, ss(TILE)] });
            }
        }

        // Terrain
        for (let i = 0; i < terrainSlots.length; i++) {
            const t = level.terrain[i]!;
            const s = snapTile(t.cx, t.cy);
            updateSprite2DIndex(terrainLayer, terrainSlots[i]!, { positionPx: s.pos, sizePx: s.size });
        }

        // Blocks (with bump offset)
        for (const b of blocks) {
            if (b.broken) continue;
            if (b.bump > 0) b.bump = Math.max(0, b.bump - 1.4);
            const s = snapTile(b.cx, b.cy, b.bump * scale);
            updateSprite2DIndex(blockLayer, b.slot, { positionPx: s.pos, sizePx: s.size });
        }
        // Flag pole + flag wave (only in areas that have a flag goal).
        if (hasFlag && level.flag) {
            for (let i = 0; i < poleSlots.length; i++) {
                const cy = level.flag.cy + 1 + i;
                const s = snapTile(flagX, cy);
                updateSprite2DIndex(blockLayer, poleSlots[i]!, { positionPx: s.pos, sizePx: s.size });
            }
        }

        // Coins (bob)
        const bob = Math.sin(game.flagAnimT * 6) * TILE * 0.06;
        for (const c of coins) {
            if (c.collected) continue;
            updateSprite2DIndex(coinLayer, c.slot, { positionPx: [sx(c.x), sy(c.y + bob)], sizePx: [ss(COIN_DRAW), ss(COIN_DRAW)], visible: true });
        }
        // Flag: rests at the BOTTOM of the pole during play, then rises to the top and
        // expands during the completion sequence (Mario-style). flagAnimT drives the wave;
        // its little pole runs up the sprite's left edge so we offset right by ~0.43·width
        // to seat it over the centred rope pole.
        if (hasFlag && level.flag) {
            const raiseK = game.phase === "complete" ? Math.max(0, Math.min(1, (COMPLETE_DUR - game.timer) / FLAG_RAISE_DUR)) : 0;
            const ease = raiseK * raiseK * (3 - 2 * raiseK);
            const downCenterY = (level.flag.cy + poleSlots.length) * TILE; // near the pedestal
            const upCenterY = (level.flag.cy + 0.5) * TILE; // near the top of the pole
            const flagCenterY = downCenterY + ease * (upCenterY - downCenterY);
            const fdraw = TILE * (1 + 0.4 * ease); // "expands" as it reaches the top
            const flagName = raiseK <= 0 ? "flagGreenHanging" : (Math.floor(game.flagAnimT * 6) % 2 === 1 ? "flagGreen2" : "flagGreen");
            updateSprite2DIndex(coinLayer, flagSlot, {
                positionPx: [sx(flagX * TILE + TILE * 0.5 + fdraw * 0.43), sy(flagCenterY)],
                sizePx: [ss(fdraw), ss(fdraw)],
                frame: items.frameOf(flagName),
                visible: true,
            });
        }

        // Pickups
        for (const p of pickups) {
            if (!p.active) continue;
            const draw = PICKUP_DRAW[p.kind];
            const foot = PICKUP_FOOT[p.kind];
            // Grounded pickups (mushroom/star/fire-flower) anchor by the feet so the big
            // sprite sits on the ground / emerges cleanly from its block; coin-pop stays centred.
            const cy = foot !== undefined ? p.box.y + p.box.h - draw * foot : p.box.y + p.box.h / 2;
            const tLayer = p.emergeT > 0 ? fireFlowerEmergeLayer : p.layer;
            const tSlot = p.emergeT > 0 ? p.emergeSlot : p.slot;
            updateSprite2DIndex(tLayer, tSlot, {
                positionPx: [sx(p.box.x + p.box.w / 2), sy(cy)],
                sizePx: [ss(draw), ss(draw)],
            });
        }

        // Fireballs (additive glow, gently flickering).
        for (const f of fireballs) {
            if (!f.active) continue;
            const flicker = 0.85 + 0.15 * Math.sin(game.flagAnimT * 40 + f.box.x);
            updateSprite2DIndex(fireballLayer, f.slot, {
                positionPx: [sx(f.box.x + f.box.w / 2), sy(f.box.y + f.box.h / 2)],
                sizePx: [ss(FIREBALL_DRAW * flicker), ss(FIREBALL_DRAW * flicker)],
                visible: true,
            });
        }

        // Sparkle bursts (additive): shrink + fade with age via tint alpha.
        for (const s of sparks) {
            if (!s.active) continue;
            const t = s.life / s.maxLife; // 1 → 0
            const sz = SPARK_DRAW * (0.4 + 0.6 * t);
            updateSprite2DIndex(sparkLayer, s.slot, {
                positionPx: [sx(s.x), sy(s.y)],
                sizePx: [ss(sz), ss(sz)],
                color: [s.color[0], s.color[1], s.color[2], t],
                visible: true,
            });
        }

        // Brick-break debris: spinning chunks falling with gravity.
        for (const d of debris) {
            if (!d.active) continue;
            updateSprite2DIndex(debrisLayer, d.slot, {
                positionPx: [sx(d.x), sy(d.y)],
                sizePx: [ss(DEBRIS_DRAW), ss(DEBRIS_DRAW)],
                rotation: d.rot,
                visible: true,
            });
        }

        // Score popups: lay out the value's digits, floating up + fading with age.
        for (const p of popups) {
            if (!p.active) {
                continue;
            }
            const t = p.life / POPUP_LIFE; // 1 → 0
            const rise = (1 - t) * POPUP_RISE;
            const alpha = Math.min(1, t * 1.6); // hold bright, fade at the end
            const n = p.digits.length;
            const stepW = POPUP_DIGIT_DRAW * 0.62; // digit glyphs overlap-pack tighter than their cell
            const startX = p.x - ((n - 1) * stepW) / 2;
            for (let d = 0; d < p.slots.length; d++) {
                if (d < n) {
                    updateSprite2DIndex(digitLayer, p.slots[d]!, {
                        positionPx: [sx(startX + d * stepW), sy(p.y - rise)],
                        sizePx: [ss(POPUP_DIGIT_DRAW), ss(POPUP_DIGIT_DRAW)],
                        frame: p.digits[d]!,
                        color: [1, 1, 1, alpha],
                        visible: true,
                    });
                } else {
                    updateSprite2DIndex(digitLayer, p.slots[d]!, { visible: false });
                }
            }
        }

        // Enemies
        for (const e of enemyList) {
            if (!e.alive) continue;
            // Piranha is hidden inside its pipe while fully retracted.
            if (e.kind === "piranha" && e.dying <= 0 && piranhaEmerge(e.phase) < 0.04) {
                updateSprite2DIndex(e.layer, e.slot, { visible: false });
                continue;
            }
            const flap = Math.floor(e.animT * (e.kind === "fly" ? 12 : 6)) % 2 === 0;
            let name: string;
            if (e.dying > 0) name = deadFrame(e.kind);
            else if (e.shell) name = "snail_shell";
            else if (e.kind === "snail") name = flap ? "snail_walk" : "snail";
            else if (e.kind === "fly") name = flap ? "bee" : "bee_fly";
            else if (e.kind === "piranha") name = flap ? "snakeSlime" : "snakeSlime_ani";
            else name = flap ? "slimeGreen_walk" : "slimeGreen";
            const [efw, efh] = enemies.sizeOf(name);
            // The piranha (tall snake) draws at its natural height so it isn't oversized.
            const escale = e.kind === "piranha" ? 1.0 : ENEMY_VIS_SCALE;
            updateSprite2DIndex(e.layer, e.slot, {
                positionPx: [sx(e.box.x + e.box.w / 2), sy(e.box.y + e.box.h)],
                sizePx: [ss(efw * escale), ss(efh * escale)],
                frame: enemies.frameOf(name),
                visible: true,
                flipX: e.kind !== "piranha" && e.dir > 0,
                flipY: e.dying > 0,
            });
        }

        // Castle boss + its projectiles.
        if (boss.active) {
            const bFlap = Math.floor(boss.animT * 6) % 2 === 0;
            const bName = boss.dying > 0 ? "spider_dead" : boss.hurt > 0 ? "spider_hit" : bFlap ? "spider_walk1" : "spider_walk2";
            const [bfw, bfh] = enemies.sizeOf(bName);
            // Flash (blink) while in the post-hit invulnerability window.
            const flashHidden = boss.hurt > 0 && Math.floor(boss.hurt * 12) % 2 === 0;
            updateSprite2DIndex(bossLayer, boss.slot, {
                positionPx: [sx(boss.box.x + boss.box.w / 2), sy(boss.box.y + boss.box.h)],
                sizePx: [ss(bfw * BOSS_VIS_SCALE), ss(bfh * BOSS_VIS_SCALE)],
                frame: enemies.frameOf(bName),
                visible: !flashHidden,
                flipX: boss.dir > 0,
                flipY: boss.dying > 0,
            });
        } else {
            updateSprite2DIndex(bossLayer, boss.slot, { visible: false });
        }
        for (const bp of bossProjectiles) {
            if (!bp.active) continue;
            const flick = 0.8 + 0.2 * Math.sin(game.flagAnimT * 30 + bp.box.x);
            updateSprite2DIndex(bossProjLayer, bp.slot, {
                positionPx: [sx(bp.box.x + bp.box.w / 2), sy(bp.box.y + bp.box.h / 2)],
                sizePx: [ss(BOSS_PROJ_DRAW), ss(BOSS_PROJ_DRAW)],
                color: [0.7 * flick, 1.0 * flick, 0.45 * flick, 1],
                visible: true,
            });
        }

        // Player — or, during a pipe warp, a front-facing sprite sliding through the
        // pipe on pipeTravelLayer (BEHIND the pipe, so the pipe occludes it).
        if (game.phase === "title") {
            // Attract screen: no player on the level (the camera is touring the world).
            updateSprite2DIndex(playerLayer, playerSlot, { visible: false });
            updateSprite2DIndex(pipeTravelLayer, pipeTravelSlot, { visible: false });
            setSprite2DShaderParams(playerLayer, [0, 0, 0, 0]);
        } else if (game.phase === "complete") {
            // Flagpole finish: cling to the pole (climb frames) while the flag raises, slide
            // down to the floor, then hand off to a right-facing walk toward the castle.
            updateSprite2DIndex(pipeTravelLayer, pipeTravelSlot, { visible: false });
            setSprite2DShaderParams(playerLayer, [0, 0, 0, 0]);
            if (trailHist.length > 0) {
                trailHist.length = 0;
                for (let i = 0; i < STAR_TRAIL; i++) updateSprite2DIndex(trailLayer, trailSlots[i]!, { visible: false });
            }
            const pframes = player.fire ? PLAYER_FIRE_FRAMES : PLAYER_FRAMES;
            const standH = player.fire ? yellowStandH : greenStandH;
            const elapsed = COMPLETE_DUR - game.timer;
            const slideEnd = FLAG_RAISE_DUR + FLAG_SLIDE_DUR;
            let pf: string;
            let cx: number;
            let feetY: number;
            let flip: boolean;
            if (elapsed < slideEnd) {
                // On the pole: climbing pose, facing the pole. Held at the top while the flag
                // rises, then slides down (eased) to the captured floor level.
                pf = Math.floor(elapsed * 9) % 2 === 0 ? pframes.climb1 : pframes.climb2;
                cx = flagSeq.poleX;
                if (elapsed < FLAG_RAISE_DUR) {
                    feetY = flagSeq.grabFeetY;
                } else {
                    const k = (elapsed - FLAG_RAISE_DUR) / FLAG_SLIDE_DUR;
                    feetY = flagSeq.grabFeetY + k * k * (3 - 2 * k) * (flagSeq.baseFeetY - flagSeq.grabFeetY);
                }
                flip = true; // face left, toward the pole
            } else {
                // Off the pole: hop down from the pedestal to the ground, then walk right.
                pf = Math.floor(elapsed * 10) % 2 === 0 ? pframes.walk1 : pframes.walk2;
                cx = player.box.x + player.box.w / 2;
                const stepK = Math.min(1, (elapsed - slideEnd) / 0.3);
                feetY = flagSeq.baseFeetY + stepK * stepK * (3 - 2 * stepK) * (flagSeq.walkFeetY - flagSeq.baseFeetY);
                flip = false;
            }
            const [pfw, pfh] = players.sizeOf(pf);
            const psc = (player.big ? PLAYER_VIS_BIG : PLAYER_VIS_SMALL) / standH;
            updateSprite2DIndex(playerLayer, playerSlot, {
                positionPx: [sx(cx), sy(feetY)],
                sizePx: [ss(pfw * psc), ss(pfh * psc)],
                frame: players.frameOf(pf),
                flipX: flip,
                visible: true,
            });
        } else if (warp.active) {
            updateSprite2DIndex(playerLayer, playerSlot, { visible: false });
            setSprite2DShaderParams(playerLayer, [0, 0, 0, 0]);
            if (trailHist.length > 0) {
                trailHist.length = 0;
                for (let i = 0; i < STAR_TRAIL; i++) updateSprite2DIndex(trailLayer, trailSlots[i]!, { visible: false });
            }
            const ease = (p: number): number => p * p * (3 - 2 * p);
            // Front frame matches the player's current power state: yellow (fire), or the
            // green front frame drawn at big or small scale (mushroom vs base).
            const wf = player.fire ? PLAYER_FIRE_FRAMES.front : PLAYER_FRAMES.front;
            const wStandH = player.fire ? yellowStandH : greenStandH;
            const wsc = (player.big ? PLAYER_VIS_BIG : PLAYER_VIS_SMALL) / wStandH;
            const [wfw, wfh] = players.sizeOf(wf);
            // Sink far enough that even a 2-tile-tall big player fully disappears behind the
            // 2-tile pipe (the pipe layer is in front of pipeTravelLayer).
            const wslide = Math.max(WARP_SLIDE, wfh * wsc);
            let travelX = warp.srcX;
            let travelFeet = warp.srcTopY;
            let travelShow = true;
            if (warp.t < WARP_DESCEND) {
                travelX = warp.srcX;
                travelFeet = warp.srcTopY + ease(warp.t / WARP_DESCEND) * wslide; // sink down
            } else if (warp.t < WARP_DESCEND + WARP_IRIS) {
                travelShow = false; // fully sunk + hidden behind the iris during the teleport
            } else {
                travelX = warp.dstX;
                travelFeet = warp.dstTopY + (1 - ease((warp.t - WARP_DESCEND - WARP_IRIS) / WARP_EMERGE)) * wslide; // rise up
            }
            updateSprite2DIndex(
                pipeTravelLayer,
                pipeTravelSlot,
                travelShow
                    ? { positionPx: [sx(travelX), sy(travelFeet)], sizePx: [ss(wfw * wsc), ss(wfh * wsc)], frame: players.frameOf(wf), flipX: false, visible: true }
                    : { visible: false },
            );
        } else {
            updateSprite2DIndex(pipeTravelLayer, pipeTravelSlot, { visible: false });

            const pframes = player.fire ? PLAYER_FIRE_FRAMES : PLAYER_FRAMES;
            let pf: string = pframes.stand;
            if (!player.alive) pf = pframes.hit;
            else if (player.ducking) pf = pframes.duck;
            else if (!player.onGround) pf = pframes.jump;
            else if (Math.abs(player.vx) > 20) pf = Math.floor(player.animT * 12) % 2 === 0 ? pframes.walk1 : pframes.walk2;
            const flashHide = player.invuln > 0 && Math.floor(player.invuln * 16) % 2 === 0;

            // Drive the player's star shader: full dazzle while invincible, blinking between
            // bright and dim in the final ~2s as a "running out" warning, 0 when not active.
            let starStrength = 0;
            if (player.star > 0) starStrength = player.star < 2 && Math.floor(player.star * 8) % 2 === 0 ? 0.35 : 1;
            setSprite2DShaderParams(playerLayer, [starStrength, 0, 0, 0]);

            const playerCx = player.box.x + player.box.w / 2;
            const playerFeet = player.box.y + player.box.h;
            const standH = player.fire ? yellowStandH : greenStandH;
            const psc = (player.big ? PLAYER_VIS_BIG : PLAYER_VIS_SMALL) / standH;
            const [pfw, pfh] = players.sizeOf(pf);
            const playerDrawW = pfw * psc;
            const playerDrawH = pfh * psc;
            const playerFrame = players.frameOf(pf);
            updateSprite2DIndex(playerLayer, playerSlot, {
                positionPx: [sx(playerCx), sy(playerFeet)],
                sizePx: [ss(playerDrawW), ss(playerDrawH)],
                frame: playerFrame,
                flipX: player.facing < 0,
                visible: !flashHide,
            });

            // Star afterimage trail: record this pose, then draw the last few poses as
            // additive rainbow ghosts fading with age. Cleared the frame star power ends.
            if (player.star > 0) {
                trailHist.unshift({ x: playerCx, y: playerFeet, w: playerDrawW, h: playerDrawH, frame: playerFrame, flip: player.facing < 0 });
                if (trailHist.length > STAR_TRAIL * STAR_TRAIL_GAP) trailHist.length = STAR_TRAIL * STAR_TRAIL_GAP;
                for (let i = 0; i < STAR_TRAIL; i++) {
                    const pose = trailHist[(i + 1) * STAR_TRAIL_GAP - 1];
                    if (!pose) {
                        updateSprite2DIndex(trailLayer, trailSlots[i]!, { visible: false });
                        continue;
                    }
                    const hue = game.flagAnimT * 7 + i * 0.7;
                    const fade = (1 - i / STAR_TRAIL) * 0.5 * starStrength;
                    updateSprite2DIndex(trailLayer, trailSlots[i]!, {
                        positionPx: [sx(pose.x), sy(pose.y)],
                        sizePx: [ss(pose.w), ss(pose.h)],
                        frame: pose.frame,
                        flipX: pose.flip,
                        visible: true,
                        color: [0.55 + 0.45 * Math.sin(hue), 0.55 + 0.45 * Math.sin(hue + 2.0944), 0.55 + 0.45 * Math.sin(hue + 4.1888), fade],
                    });
                }
            } else if (trailHist.length > 0) {
                trailHist.length = 0;
                for (let i = 0; i < STAR_TRAIL; i++) updateSprite2DIndex(trailLayer, trailSlots[i]!, { visible: false });
            }
        }

        // Iris-wipe transition: only darkens during the brief middle of a pipe warp,
        // covering the camera jump. The slide in/out happens with the iris fully open.
        if (warp.active) {
            let k = 0;
            if (warp.t >= WARP_DESCEND && warp.t < WARP_DESCEND + WARP_IRIS) {
                const ip = (warp.t - WARP_DESCEND) / WARP_IRIS;
                k = ip < 0.5 ? ip / 0.5 : (1 - ip) / 0.5;
            }
            updateSprite2DIndex(irisLayer, irisSlot, { positionPx: [0, 0], sizePx: [cw, ch], visible: k > 0.001 });
            setSprite2DShaderParams(irisLayer, [1.35 * (1 - k), cw / ch, 0, 0]);
        } else {
            updateSprite2DIndex(irisLayer, irisSlot, { visible: false });
        }
    };

    // ── Main loop ─────────────────────────────────────────────────────────────
    await startEngine(engine);

    let last = performance.now();
    const tick = (now: number): void => {
        const dt = Math.min(1 / 30, (now - last) / 1000);
        last = now;
        // Paused: keep presenting the last frame (no sim / animation advance) until resumed.
        if (paused && game.phase === "playing") {
            project();
            crt.sync(canvas.width, canvas.height);
            input.endFrame();
            requestAnimationFrame(tick);
            return;
        }
        game.flagAnimT += dt;
        player.animT += dt;

        switch (game.phase) {
            case "title":
                titleT += dt;
                // Keep the level alive (and correctly posed) while the attract camera tours
                // it: animate the purely-visual enemy cycles. Without this, enemies are frozen
                // at spawn — the piranha sits stuck EMERGED above its pipe, and a slime that
                // spawns above the ground hangs in mid-air. Flies bob, piranhas run their
                // emerge/retract cycle, and ground walkers fall to rest on the floor.
                for (const e of enemyList) {
                    if (!e.alive) continue;
                    e.animT += dt;
                    if (e.kind === "fly") {
                        e.phase += dt;
                        e.box.y = e.homeY + Math.sin(e.phase * FLY_FREQ) * FLY_AMP;
                    } else if (e.kind === "piranha") {
                        e.phase += dt;
                        e.box.y = e.homeY + (1 - piranhaEmerge(e.phase)) * PIRANHA_RISE;
                    } else {
                        // Ground walkers (slime/snail): let gravity settle them onto the floor
                        // so one that SPAWNS above the ground (e.g. the col-44 slime, which
                        // normally falls onto the floor at the start of play) rests on the
                        // ground here instead of hanging in the air. No horizontal motion, so
                        // they don't wander off the attract view or shift their start position.
                        e.vy = Math.min(PHYS.maxFall, e.vy + PHYS.gravity * dt);
                        const res = moveAndCollide(e.box, 0, e.vy, dt, collision);
                        e.vy = res.vy;
                    }
                }
                // Start on the jump key (Space) — the game's primary action button —
                // or Enter / the on-screen A button (both set startPressed).
                if (input.state.startPressed || input.state.jumpPressed) {
                    hud.title(false);
                    game.phase = "ready";
                    game.timer = 1.4;
                    hud.banner("WORLD 1-1", "Get ready!");
                    sfx.coin();
                }
                break;
            case "ready":
                game.timer -= dt;
                if (game.timer <= 0) {
                    game.phase = "playing";
                    hud.banner(null);
                }
                break;
            case "playing":
                updatePlaying(dt);
                break;
            case "warping": {
                warp.t += dt;
                if (!warp.teleported && warp.t >= WARP_DESCEND + WARP_IRIS * 0.5) {
                    // At the iris's darkest point: swap to the destination area (loadArea
                    // stands the player on the entry pipe), then drive the emerge from there.
                    loadArea(warp.toArea, warp.toEntry);
                    warp.dstX = player.box.x + player.box.w / 2;
                    warp.dstTopY = player.box.y + player.box.h;
                    warp.teleported = true;
                }
                if (warp.t >= WARP_TOTAL) {
                    warp.active = false;
                    warp.cooldown = 0.5;
                    game.phase = "playing";
                }
                break;
            }
            case "dying":
                player.vy += PHYS.gravity * dt;
                player.box.y += player.vy * dt;
                game.timer -= dt;
                if (game.timer <= 0) {
                    game.lives -= 1;
                    if (game.lives <= 0) {
                        game.phase = "gameover";
                        hud.banner("GAME OVER", "Press Space / tap A");
                    } else {
                        resetWorld();
                    }
                }
                break;
            case "complete":
                game.timer -= dt;
                // The flag-raise + pole-slide happen first (player held on the pole by the
                // renderer); only stroll toward the castle once the player is off the pole.
                if (COMPLETE_DUR - game.timer >= FLAG_RAISE_DUR + FLAG_SLIDE_DUR) {
                    player.box.x += 150 * dt; // stroll off toward the castle
                }
                if (game.timer <= 0) {
                    // Cut to the castle finale (keep the run going: score, coins, lives, time).
                    loadArea("castle", "start");
                    game.phase = "ready";
                    game.timer = 1.6;
                    hud.banner("CASTLE", "Stomp the boss or blast it - 3 hits!");
                }
                break;
            case "won":
                game.timer -= dt;
                // Victory fireworks: periodic sparkle bursts across the top of the view.
                if (Math.floor(game.timer * 2) !== Math.floor((game.timer + dt) * 2)) {
                    burstSparks(cam.x + (0.2 + Math.random() * 0.6) * (canvas.width / (canvas.height / worldH)), (0.2 + Math.random() * 0.3) * worldH, Math.random() < 0.5 ? SPARK_GOLD : SPARK_WHITE, 10);
                }
                if (game.timer <= 0) {
                    // Back to the attract screen with a fresh run.
                    restartLevel();
                    game.phase = "title";
                    hud.banner(null);
                    hud.boss(0, 0);
                    hud.title(true);
                    titleT = 0;
                }
                break;
            case "gameover":
                if (input.state.startPressed || input.state.jumpPressed) {
                    // Fresh game, but return to the attract screen first.
                    restartLevel();
                    game.phase = "title";
                    hud.banner(null);
                    hud.title(true);
                    titleT = 0;
                }
                break;
        }

        updateJuice(dt);
        project();
        crt.sync(canvas.width, canvas.height);
        hud.update({ score: game.score, coins: game.coins, lives: game.lives, time: game.time, world: game.world });
        input.endFrame();
        requestAnimationFrame(tick);
    };

    // Full reset of the WORLD to its initial state — reloads the start area (which
    // rebuilds blocks incl. broken bricks, coins, enemies, platforms fresh) and clears
    // every cross-area particle pool, with the player back at spawn. Does NOT touch
    // score / coins-collected / lives, so a death restores the world while keeping the
    // run's totals (classic SMB). Shared by death-respawn + full restart.
    const resetWorld = (): void => {
        game.phase = "ready";
        game.timer = 1.4;
        game.time = START_TIME;
        game.combo = 0;
        warp.active = false;
        warp.cooldown = 0;
        resetPlayer(); // reset size/power BEFORE loadArea positions the box
        loadArea(world.start, "start"); // rebuild the start area + place the player
        // Clear the cross-area (persistent) pools.
        for (const p of pickups) {
            p.active = false;
            p.emergeT = 0;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
            if (p.emergeSlot >= 0) updateSprite2DIndex(fireFlowerEmergeLayer, p.emergeSlot, { visible: false });
        }
        for (const f of fireballs) killFireball(f);
        for (const s of sparks) killSpark(s);
        for (const d of debris) killDebris(d);
        for (const p of popups) hidePopup(p);
        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.stand) });
        hud.banner("WORLD 1-1", "Get ready!");
    };

    const restartLevel = (): void => {
        game.score = 0;
        game.coins = 0;
        game.lives = 3;
        resetWorld();
    };

    requestAnimationFrame(tick);
    canvas.dataset.ready = "true";
}

// Keep an explicit reference so unused-import linters see the sheet types.
export type { PlatformerSheet, World, LevelArea, Sprite2DLayer };
