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
import { PHYS, PLAYER_FIRE_FRAMES, PLAYER_FRAMES, TILE } from "./frames.js";
import { createInput, type InputController } from "./input.js";
import { createSfx, type Sfx } from "./audio.js";
import { createHud, type Hud } from "./hud.js";
import { buildLevel, type BlockKind, type Level, type Pipe } from "./level.js";
import { createParallax } from "./parallax.js";
import { makeFireballDataUrl, makeFireFlowerDataUrl } from "./fire.js";
import { makeSparkDataUrl } from "./juice.js";
import { IRIS_FRAGMENT, makeCaveBackdropDataUrl, makePipeTextureDataUrl, makeWhiteTextureDataUrl } from "./portal.js";
import { LAVA_FRAGMENT } from "./lava.js";
import { LANTERN_FRAGMENT, makeGlowDataUrl } from "./lantern.js";
import { moveAndCollide, overlaps, type AABB, type CollisionMap } from "./physics.js";

const SKY = { r: 0.38, g: 0.62, b: 0.95, a: 1 } as const;
const START_TIME = 300;
const ASSET_BASE = "/platformer";

/** Number of afterimage ghosts in the star-power trail. */
const STAR_TRAIL = 6;
/** Frame spacing between consecutive ghosts (larger = longer, sparser trail). */
const STAR_TRAIL_GAP = 3;

// Visual draw sizes are decoupled from the collision boxes. The Kenney frames
// carry transparent padding above the character/creature (art sits at the frame
// bottom), and a tight hitbox feels better than a roomy one — so each sprite is
// DRAWN larger than its box, scaled to read ~1 tile like the ?-blocks. The
// bottom-centre pivot keeps the feet grounded as the sprite grows.
/** Player target *visible* height (small, un-grown / big, mushroom). Deluxe
 *  alien frames are tightly cropped (art reaches the frame edges), so the
 *  sprite is scaled by its stand-frame height to hit these heights; other poses
 *  (jump/duck/walk) keep their natural aspect. Big reads ~2 tiles (SMB-style). */
const PLAYER_VIS_SMALL = TILE * 1.3;
const PLAYER_VIS_BIG = TILE * 2.0;
/** Enemy sprite scale over its natural (tightly-cropped) frame size. */
const ENEMY_VIS_SCALE = 1.45;
/** Flying-enemy tuning: horizontal drift, vertical bob amplitude / frequency. */
const FLY_SPEED = 70;
const FLY_AMP = TILE * 1.3;
const FLY_FREQ = 2.2;
/** Piranha-plant emerge/retract cycle (seconds) and how far it rises (px). */
const PIRANHA_CYCLE = 3.4;
const PIRANHA_RISE = TILE * 1.45;
/** Piranha emergence 0..1 (hidden → rising → up → retracting) from its cycle phase (s). */
function piranhaEmerge(phase: number): number {
    const t = (((phase % PIRANHA_CYCLE) + PIRANHA_CYCLE) % PIRANHA_CYCLE) / PIRANHA_CYCLE;
    if (t < 0.12) return 0;
    if (t < 0.32) return (t - 0.12) / 0.2; // rising
    if (t < 0.62) return 1; // fully up
    if (t < 0.82) return 1 - (t - 0.62) / 0.2; // retracting
    return 0; // hidden in the pipe
}
// Items (coins, power-ups) use near-square 128×128 frames, but the art carries
// generous transparent padding (~50–62% fill), so the DRAWN cell must be larger
// than the visible item for it to read ~0.85 tile vs the 1-tile ?-blocks. The
// centre pivot keeps the visible shape centred on the (tighter) collision box.
/** Floating-coin draw size (cell; coin art fills ~60%). */
const COIN_DRAW = TILE * 1.4;
/** Coin collection radius box (half-extent). */
const COIN_PICK_HALF = TILE * 0.42;
/** Per-kind pickup DRAW size (square cell), tuned per art fill so each reads ~0.85 tile. */
const PICKUP_DRAW: Record<PickupState["kind"], number> = {
    "coin-pop": TILE * 1.4,
    mushroom: TILE * 1.5,
    star: TILE * 1.75,
    "fire-flower": TILE * 1.1,
};
/**
 * For grounded pickups (mushroom, star, fire-flower) the sprite is drawn much larger
 * than its collision box, so we anchor it by the FEET instead of centring it — otherwise
 * the oversized centred sprite sinks below the box and clips into the block it emerges
 * from. Value = `0.5 − padBottom` of the frame (measured alpha bounds): the mushroom
 * art is flush with its frame bottom (padBottom≈0 → 0.5); the star is centred in its
 * frame (padBottom≈0.27 → ≈0.23); the fire flower has a short stem (padBottom≈0.1 → 0.4).
 */
const PICKUP_FOOT: Partial<Record<PickupState["kind"], number>> = {
    mushroom: 0.5,
    star: 0.23,
    "fire-flower": 0.4,
};

// Fireball projectiles (fire power-up). Travel along the ground, bounce, and pop
// enemies on contact; drawn as additive glows.
const FIREBALL_SPEED = 600;
const FIREBALL_BOUNCE = 360;
const FIREBALL_LIFE = 2.4;
const FIREBALL_MAX = 2;
const FIRE_COOLDOWN = 0.28;
const FIREBALL_DRAW = TILE * 0.7;

// "Juice": additive sparkle bursts + floating score popups on coin / stomp.
/** Additive spark particle pool size + per-burst count. */
const SPARK_MAX = 40;
const SPARK_PER_BURST = 8;
const SPARK_LIFE = 0.45;
const SPARK_DRAW = TILE * 0.5;
/** Score-popup pool: each popup lays out up to MAX_DIGITS floating digit sprites. */
const POPUP_MAX = 6;
const POPUP_DIGITS = 4;
const POPUP_LIFE = 0.8;
const POPUP_RISE = TILE * 1.4; // world px the popup floats up over its life
const POPUP_DIGIT_DRAW = TILE * 0.62;
/** Tint colours for sparkle bursts. */
const SPARK_GOLD: readonly [number, number, number] = [1, 0.86, 0.4];
const SPARK_WHITE: readonly [number, number, number] = [1, 1, 1];

// Brick-break debris: four spinning chunks fly out when a big player smashes a brick.
const DEBRIS_MAX = 16;
const DEBRIS_LIFE = 1.1;
const DEBRIS_DRAW = TILE * 0.42;

/**
 * Player invincibility fragment: an animated rainbow palette-cycle + sparkle pulse,
 * mixed over the sprite by `fx.params.x` (0 = untouched sprite, 1 = full star dazzle).
 * At strength 0 it returns exactly the stock `atlas * tint * opacity`, so the same
 * layer renders the normal player when not invincible. WGSL contract per
 * `createSprite2DCustomShader`: `in.uv`/`in.tint`, `atlasTex`/`atlasSamp`, `fx.time`/
 * `fx.params`, and the layer UBO `L.opacityMul`.
 */
const STAR_FRAGMENT = `
let base = textureSample(atlasTex, atlasSamp, in.uv);
let strength = fx.params.x;
let phase = fx.time * 7.0 + in.uv.y * 6.0 - in.uv.x * 3.0;
let rainbow = vec3<f32>(
    0.55 + 0.45 * sin(phase),
    0.55 + 0.45 * sin(phase + 2.0944),
    0.55 + 0.45 * sin(phase + 4.1888)
);
let lum = dot(base.rgb, vec3<f32>(0.299, 0.587, 0.114));
let starRgb = mix(vec3<f32>(lum), rainbow, 0.85) * (0.45 + 0.7 * lum);
let pulse = 0.5 + 0.5 * sin(fx.time * 22.0);
let rgb = mix(base.rgb, starRgb, strength) + rainbow * (pulse * 0.3 * strength);
return vec4<f32>(rgb, base.a) * in.tint * L.opacityMul;
`;

/** One recorded player pose sampled by the star afterimage trail. */
interface TrailPose {
    x: number;
    y: number;
    w: number;
    h: number;
    frame: number;
    flip: boolean;
}

interface BlockState {
    cx: number;
    cy: number;
    kind: BlockKind;
    used: boolean;
    broken: boolean;
    slot: number;
    /** Vertical bump offset (px) when hit from below; animates back to 0. */
    bump: number;
}

interface EnemyState {
    kind: "slime" | "snail" | "fly" | "piranha";
    box: AABB;
    vx: number;
    vy: number;
    dir: -1 | 1;
    alive: boolean;
    /** snail-only: stomped into a shell. */
    shell: boolean;
    /** shell sliding speed sign, or 0 if idle. */
    shellDir: -1 | 0 | 1;
    dying: number; // >0 = death animation countdown
    slot: number;
    animT: number;
    /** fly: vertical bob centre (world px). piranha: pipe-mouth top Y (world px). */
    homeY: number;
    /** fly: sine phase. piranha: emerge/retract cycle phase (seconds). */
    phase: number;
}

/** A kinematic moving platform that ping-pongs along one axis and carries the rider. */
interface MovingPlatform {
    box: AABB;
    axis: "x" | "y";
    /** Travel bounds along the axis (world px). */
    min: number;
    max: number;
    /** Speed in world px/sec, and the current travel direction. */
    speed: number;
    dir: 1 | -1;
    /** This frame's movement delta (used to carry the rider). */
    dx: number;
    dy: number;
    /** Sprite slots, one per platform tile (left → right). */
    slots: number[];
}

interface PickupState {
    kind: "coin-pop" | "mushroom" | "star" | "fire-flower";
    box: AABB;
    vx: number;
    vy: number;
    active: boolean;
    /** coin-pop only: lifetime countdown. */
    life: number;
    slot: number;
    /** The layer this pool entry's sprite lives on (atlas-specific). */
    layer: Sprite2DLayer;
}

/** A fire-power projectile: bounces along the ground, pops enemies, drawn additive. */
interface Fireball {
    box: AABB;
    vx: number;
    vy: number;
    life: number;
    active: boolean;
    slot: number;
}

/** An additive sparkle particle for coin/stomp bursts. */
interface Spark {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    active: boolean;
    slot: number;
    color: readonly [number, number, number];
}

/** A floating score popup (e.g. "100") rendered from HUD digit sprites. */
interface Popup {
    x: number;
    y: number;
    life: number;
    active: boolean;
    /** Digit frame indices (left to right) for the value's text. */
    digits: number[];
    /** This popup's digit sprite slots on the digit layer (fixed run). */
    slots: number[];
}

/** A spinning brick chunk thrown out when a brick is smashed. */
interface Debris {
    x: number;
    y: number;
    vx: number;
    vy: number;
    rot: number;
    spin: number;
    life: number;
    active: boolean;
    slot: number;
}

type Phase = "ready" | "playing" | "warping" | "dying" | "complete" | "gameover";

export async function startGame(canvas: HTMLCanvasElement, engine: EngineContext): Promise<void> {
    const level = buildLevel();
    const worldW = level.cols * TILE;
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
    const [pipeTex, caveTex, whiteTex, fireFlowerTex, fireballTex, sparkTex, glowTex] = await Promise.all([
        loadTexture2D(engine, makePipeTextureDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeCaveBackdropDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeWhiteTextureDataUrl(), { invertY: false, mipMaps: false }),
        loadTexture2D(engine, makeFireFlowerDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeFireballDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeSparkDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
        loadTexture2D(engine, makeGlowDataUrl(), { invertY: false, addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", mipMaps: false, minFilter: "linear", magFilter: "linear" }),
    ]);
    const pipeAtlas = createGridSpriteAtlas(pipeTex, { cellWidthPx: pipeTex.width, cellHeightPx: pipeTex.height });
    const caveAtlas = createGridSpriteAtlas(caveTex, { cellWidthPx: caveTex.width, cellHeightPx: caveTex.height });
    const whiteAtlas = createGridSpriteAtlas(whiteTex, { cellWidthPx: whiteTex.width, cellHeightPx: whiteTex.height });
    const sparkAtlas = createGridSpriteAtlas(sparkTex, { cellWidthPx: sparkTex.width, cellHeightPx: sparkTex.height });
    const fireFlowerAtlas = createGridSpriteAtlas(fireFlowerTex, { cellWidthPx: fireFlowerTex.width, cellHeightPx: fireFlowerTex.height });
    const fireballAtlas = createGridSpriteAtlas(fireballTex, { cellWidthPx: fireballTex.width, cellHeightPx: fireballTex.height });
    const glowAtlas = createGridSpriteAtlas(glowTex, { cellWidthPx: glowTex.width, cellHeightPx: glowTex.height });

    // ── Gameplay layers (back → front) ────────────────────────────────────────
    // Frame indices are atlas-specific, so each sheet needs its own layer(s).
    // Dark cave backdrop: full-screen panel shown only underground, behind terrain.
    const caveBackLayer = createSprite2DLayer(caveAtlas, { capacity: 1, order: 4, pivot: [0, 0] });
    // Molten lava pools: procedural custom-shader quads (reuse the 1×1 white atlas),
    // drawn just in front of the cave backdrop and behind the stone terrain + player.
    const lavaShader = createSprite2DCustomShader({ fragment: LAVA_FRAGMENT });
    const lavaLayer = createSprite2DLayer(whiteAtlas, { capacity: Math.max(1, level.lava.length), order: 4.5, customShader: lavaShader, pivot: [0, 0] });
    const terrainLayer = createSprite2DLayer(tiles.atlas, { capacity: level.terrain.length + 4, order: 5, pivot: [0, 0] });
    const pipeLayer = createSprite2DLayer(pipeAtlas, { capacity: Math.max(1, level.pipes.length), order: 6, pivot: [0, 0] });
    // Moving platforms (kinematic): drawn as bridge tiles, in front of terrain/pipes.
    const moverTileCount = level.movers.reduce((n, m) => n + m.w, 0);
    const moverLayer = createSprite2DLayer(tiles.atlas, { capacity: Math.max(1, moverTileCount), order: 6.5, pivot: [0, 0] });
    const blockLayer = createSprite2DLayer(tiles.atlas, { capacity: level.blocks.length + 32, order: 7, pivot: [0, 0] });
    const itemLayer = createSprite2DLayer(items.atlas, { capacity: level.coins.length + 40, order: 8, pivot: [0.5, 0.5] });
    // Mushrooms come from the *items* sheet, so they need a centre-pivot items layer.
    const shroomLayer = createSprite2DLayer(items.atlas, { capacity: 8, order: 9, pivot: [0.5, 0.5] });
    // Fire flowers (procedural texture) get their own centre-pivot layer.
    const fireFlowerLayer = createSprite2DLayer(fireFlowerAtlas, { capacity: 4, order: 9, pivot: [0.5, 0.5] });
    const enemyLayer = createSprite2DLayer(enemies.atlas, { capacity: level.enemies.length + 4, order: 10, pivot: [0.5, 1] });
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
    const torchLayer = createSprite2DLayer(tiles.atlas, { capacity: Math.max(1, level.torches.length), order: 9.5, pivot: [0.5, 1] });
    // Underground "lantern": a full-screen multiply-darkness pool that follows the player (#8).
    const lanternShader = createSprite2DCustomShader({ fragment: LANTERN_FRAGMENT });
    const lanternLayer = createSprite2DLayer(whiteAtlas, { capacity: 1, order: 17, pivot: [0, 0], customShader: lanternShader, blendMode: spriteBlendMultiply });
    // Torch glows: additive warm haloes in front of the darkness so torches shine through.
    const torchGlowLayer = createSprite2DLayer(glowAtlas, { capacity: Math.max(1, level.torches.length + level.lava.length), order: 17.5, pivot: [0.5, 0.5], blendMode: spriteBlendAdditive });
    // Fullscreen iris-wipe transition (custom-shader quad), on top of everything.
    const irisShader = createSprite2DCustomShader({ fragment: IRIS_FRAGMENT });
    const irisLayer = createSprite2DLayer(whiteAtlas, { capacity: 1, order: 20, pivot: [0, 0], customShader: irisShader });

    const renderer = createSpriteRenderer(engine, {
        layers: [...parallax.layers, caveBackLayer, lavaLayer, terrainLayer, pipeLayer, moverLayer, blockLayer, itemLayer, shroomLayer, fireFlowerLayer, enemyLayer, torchLayer, trailLayer, playerLayer, fireballLayer, sparkLayer, digitLayer, debrisLayer, lanternLayer, torchGlowLayer, irisLayer],
        clearValue: SKY,
    });
    registerSpriteRenderer(renderer);

    // Cave backdrop, warp-pipe, and iris sprite slots.
    const caveBackSlot = addSprite2DIndex(caveBackLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
    // Lava pools: one quad each; `color` carries the pool's tile dims for the shader.
    const lavaSlots = level.lava.map((lv) => addSprite2DIndex(lavaLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [lv.w, lv.h, 0, 1], visible: false }));
    // Lantern darkness quad + wall torches (sprite + additive glow), hidden until underground.
    const lanternSlot = addSprite2DIndex(lanternLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1.77, 0, 0, 1], visible: false });
    const torchFrame = tiles.frameOf("torch");
    const torchSlots = level.torches.map(() => addSprite2DIndex(torchLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: torchFrame, visible: false }));
    const torchGlowSlots = level.torches.map(() => addSprite2DIndex(torchGlowLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1, 0.72, 0.32, 0.9], visible: false }));
    const lavaGlowSlots = level.lava.map(() => addSprite2DIndex(torchGlowLayer, { positionPx: [0, 0], sizePx: [1, 1], color: [1, 0.5, 0.16, 0.85], visible: false }));
    const pipeSlots = level.pipes.map((p) => addSprite2DIndex(pipeLayer, { positionPx: [0, 0], sizePx: [p.w * TILE, p.h * TILE], frame: 0 }));
    const irisSlot = addSprite2DIndex(irisLayer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });

    // ── Moving platforms (kinematic; carry the player) ────────────────────────
    const MOVER_H = TILE * 0.6; // platform thickness (top surface at the spec row)
    const bridgeFrame = tiles.frameOf("bridge");
    const movers: MovingPlatform[] = level.movers.map((m) => {
        const w = m.w * TILE;
        const x0 = m.cx * TILE;
        const y0 = m.cy * TILE;
        // x: travel right from the start; y: travel UP from the start (then back).
        const min = m.axis === "x" ? x0 : y0 - m.range * TILE;
        const max = m.axis === "x" ? x0 + m.range * TILE : y0;
        const slots: number[] = [];
        for (let i = 0; i < m.w; i++) slots.push(addSprite2DIndex(moverLayer, { positionPx: [0, 0], sizePx: [TILE, MOVER_H], frame: bridgeFrame }));
        return {
            box: { x: x0, y: y0, w, h: MOVER_H },
            axis: m.axis,
            min,
            max,
            speed: m.speed * TILE,
            dir: (m.axis === "x" ? 1 : -1) as 1 | -1,
            dx: 0,
            dy: 0,
            slots,
        };
    });

    // ── Static terrain sprites (frame fixed; position re-projected each frame) ─
    const terrainSlots = level.terrain.map((t) =>
        addSprite2DIndex(terrainLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: tiles.frameOf(t.name) }),
    );

    // ── Interactive blocks ────────────────────────────────────────────────────
    const blockFrame = (kind: BlockKind): number => {
        switch (kind) {
            case "brick":
                return tiles.frameOf("brickWall");
            case "coin-block":
                return tiles.frameOf("boxItem");
            case "mushroom-block":
                return tiles.frameOf("boxItem");
            case "star-block":
                return tiles.frameOf("boxItem");
        }
    };
    const blocks: BlockState[] = level.blocks.map((b) => {
        const slot = addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: blockFrame(b.kind) });
        return { cx: b.cx, cy: b.cy, kind: b.kind, used: false, broken: false, slot, bump: 0 };
    });

    // Flag pole: a column of chain tiles from the flag down to the ground.
    const flagX = level.flag.cx;
    const poleSlots: number[] = [];
    for (let cy = level.flag.cy + 1; cy < level.rows; cy++) {
        if (level.solid[cy * level.cols + flagX]) break;
        poleSlots.push(addSprite2DIndex(blockLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: items.frameOf("chain") }));
    }

    // ── Coins (floating, collectible) ─────────────────────────────────────────
    const coinFrame = items.frameOf("coinGold");
    const coins = level.coins.map((c) => ({
        x: c.cx * TILE + TILE / 2,
        y: c.cy * TILE + TILE / 2,
        collected: false,
        slot: addSprite2DIndex(itemLayer, { positionPx: [0, 0], sizePx: [COIN_DRAW, COIN_DRAW], frame: coinFrame, visible: false }),
    }));

    // Flag (animated) on the items layer.
    const flagSlot = addSprite2DIndex(itemLayer, { positionPx: [0, 0], sizePx: [TILE, TILE], frame: items.frameOf("flagGreen"), visible: true });

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
    const particleFrames = ["particleBrick1a", "particleBrick1b", "particleBrick2a", "particleBrick2b"].map((n) => items.frameOf(n));
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
            // Fire flower: emerges and sits still on its block (classic, does not walk).
            p.box.w = p.box.h = TILE * 0.8;
            p.box.x = cx * TILE + (TILE - p.box.w) / 2;
            p.vx = 0;
            p.vy = -260;
            updateSprite2DIndex(p.layer, p.slot, { sizePx: [PICKUP_DRAW[kind], PICKUP_DRAW[kind]], visible: true });
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
    const enemyList: EnemyState[] = level.enemies.map((e) => {
        const { w, h } = enemyBoxDims(e.kind);
        const startFrame =
            e.kind === "fly" ? "bee" : e.kind === "piranha" ? "snakeSlime" : e.kind === "snail" ? "snail_walk" : "slimeGreen_walk";
        const boxY = (e.cy + 1) * TILE - h;
        const slot = addSprite2DIndex(enemyLayer, { positionPx: [0, 0], sizePx: [w, h], frame: enemies.frameOf(startFrame), visible: false });
        return {
            kind: e.kind,
            box: { x: e.cx * TILE + (TILE - w) / 2, y: boxY, w, h },
            vx: -PHYS.enemySpeed,
            vy: 0,
            dir: -1,
            alive: true,
            shell: false,
            shellDir: 0,
            dying: 0,
            slot,
            animT: 0,
            homeY: boxY,
            phase: Math.random() * Math.PI * 2,
        };
    });

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
    const game = { phase: "ready" as Phase, score: 0, coins: 0, lives: 3, time: START_TIME, timer: 1.6, flagAnimT: 0, world: "1-1", combo: 0 };

    // Warp / area state. `inCave` drives the dark backdrop + flag-goal guard; `warp`
    // runs the iris-wipe transition and teleports the player at its darkest point.
    let inCave = false;
    const WARP_DUR = 1.0;
    const WARP_MID = 0.5;
    const warp = { active: false, t: 0, teleported: false, cooldown: 0, toCx: 0, toCy: 0, toCave: false, label: "1-1" };

    const sfx: Sfx = createSfx();
    const input: InputController = createInput(document.body);
    const hud: Hud = createHud(document.body);
    hud.banner("WORLD 1-1", "Get ready!");
    const resumeAudio = (): void => sfx.resume();
    window.addEventListener("pointerdown", resumeAudio, { once: false });
    window.addEventListener("keydown", resumeAudio, { once: false });

    const cam = { x: 0, y: 0 };

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
                updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf(e.kind === "snail" ? "snail_walk" : "slimeGreen_dead"), flipY: true });
                addScore(200);
                juicePop(e.box.x + e.box.w / 2, e.box.y, 200, SPARK_WHITE);
                sfx.kick();
                killFireball(f);
                return;
            }
        }
        if (f.box.y > worldH + TILE) killFireball(f);
    };

    // Begin a pipe warp: freeze the player and run the iris transition; the teleport
    // itself happens at the darkest point (see the "warping" phase in the tick).
    const startWarp = (pipe: Pipe): void => {
        game.phase = "warping";
        warp.active = true;
        warp.t = 0;
        warp.teleported = false;
        warp.toCx = pipe.toCx;
        warp.toCy = pipe.toCy;
        warp.toCave = pipe.toCave;
        warp.label = pipe.worldLabel;
        player.vx = 0;
        player.vy = 0;
        player.ducking = true;
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
                if (pipe.decorative) continue; // piranha pipes aren't warps
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
                updateSprite2DIndex(itemLayer, c.slot, { visible: false });
                gainCoin();
                juicePop(c.x, c.y - TILE * 0.2, 200, SPARK_GOLD);
            }
        }

        // Goal: reach the flag column (overworld only — the cave reuses far-right columns).
        if (!inCave && player.box.x + player.box.w * 0.5 >= flagX * TILE) {
            game.phase = "complete";
            game.timer = 3.5;
            // End-of-area tally: convert remaining time into bonus points.
            const bonus = Math.floor(game.time) * 50;
            addScore(bonus);
            sfx.complete();
            hud.banner("LEVEL COMPLETE", `TIME BONUS  ${bonus}`);
        }
    };

    // Death/"hit" frame for each enemy kind (snail has no _dead → use _hit).
    const deadFrame = (kind: EnemyState["kind"]): string =>
        kind === "snail" ? "snail_hit" : kind === "fly" ? "bee_dead" : kind === "piranha" ? "snakeSlime_dead" : "slimeGreen_dead";

    const updateEnemy = (e: EnemyState, dt: number): void => {
        e.animT += dt;
        if (e.dying > 0) {
            e.dying -= dt;
            if (e.dying <= 0) {
                e.alive = false;
                updateSprite2DIndex(enemyLayer, e.slot, { visible: false });
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
            updateSprite2DIndex(enemyLayer, e.slot, { visible: false });
            return;
        }

        // Shell-vs-walker kills
        if (e.shell && e.shellDir !== 0) {
            for (const o of enemyList) {
                if (o === e || !o.alive || o.dying > 0) continue;
                if (overlaps(e.box, o.box)) {
                    o.dying = 0.4;
                    o.vy = -360;
                    updateSprite2DIndex(enemyLayer, o.slot, { frame: enemies.frameOf(deadFrame(o.kind)), flipY: true });
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
            updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf(deadFrame(e.kind)), flipY: true });
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
                updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf("snail_shell"), sizePx: [e.box.w, e.box.h] });
                comboStomp(e.box.x + e.box.w / 2, e.box.y);
                sfx.stomp();
            } else if (e.kind === "snail" && e.shell) {
                // Kick a resting shell, or stop a moving one.
                e.shellDir = e.shellDir === 0 ? (player.facing as -1 | 1) : 0;
                addScore(100);
                sfx.kick();
            } else {
                e.dying = 0.35;
                updateSprite2DIndex(enemyLayer, e.slot, { frame: enemies.frameOf(deadFrame(e.kind)), sizePx: [e.box.w, e.box.h * 0.6] });
                comboStomp(e.box.x + e.box.w / 2, e.box.y);
                sfx.stomp();
            }
            return;
        }

        // A resting shell that the player walks into gets kicked, not hurt.
        if (e.kind === "snail" && e.shell && e.shellDir === 0) {
            e.shellDir = player.box.x < e.box.x ? 1 : -1;
            addScore(100);
            sfx.kick();
            return;
        }

        hurtPlayer();
    };

    const updatePickup = (p: PickupState, dt: number): void => {
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
        // Camera follows the player, clamped to the level.
        const targetX = player.box.x + player.box.w / 2 - viewW / 2;
        cam.x = Math.max(0, Math.min(worldW - viewW, targetX));
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
        updateSprite2DIndex(caveBackLayer, caveBackSlot, inCave ? { positionPx: [0, 0], sizePx: [cw, ch], visible: true } : { visible: false });

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
        // Lantern: a multiply-darkness pool centred on the player.
        if (inCave) {
            const lpx = sx(player.box.x + player.box.w / 2) / cw;
            const lpy = sy(player.box.y + player.box.h * 0.4) / ch;
            setSprite2DShaderParams(lanternLayer, [lpx, lpy, 0.46, 0.2]);
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
        for (const mp of movers) {
            for (let i = 0; i < mp.slots.length; i++) {
                const tx0 = Math.round(sx(mp.box.x + i * TILE));
                const tx1 = Math.round(sx(mp.box.x + (i + 1) * TILE));
                const ty0 = Math.round(sy(mp.box.y));
                updateSprite2DIndex(moverLayer, mp.slots[i]!, { positionPx: [tx0, ty0], sizePx: [tx1 - tx0, ss(mp.box.h)] });
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
        // Flag pole
        for (let i = 0; i < poleSlots.length; i++) {
            const cy = level.flag.cy + 1 + i;
            const s = snapTile(flagX, cy);
            updateSprite2DIndex(blockLayer, poleSlots[i]!, { positionPx: s.pos, sizePx: s.size });
        }

        // Coins (bob)
        const bob = Math.sin(game.flagAnimT * 6) * TILE * 0.06;
        for (const c of coins) {
            if (c.collected) continue;
            updateSprite2DIndex(itemLayer, c.slot, { positionPx: [sx(c.x), sy(c.y + bob)], sizePx: [ss(COIN_DRAW), ss(COIN_DRAW)], visible: true });
        }
        // Flag wave. The flag sprite's pole runs up its far-left edge (centre at
        // ~0.07 of the sprite width), so with a centre pivot we shift right by
        // ~0.43·TILE to sit the pole over the centred chain column.
        const flagName = Math.floor(game.flagAnimT * 6) % 2 === 0 ? "flagGreen" : "flagGreen2";
        updateSprite2DIndex(itemLayer, flagSlot, {
            positionPx: [sx(flagX * TILE + TILE * 0.93), sy(level.flag.cy * TILE + TILE * 0.5)],
            sizePx: [ss(TILE), ss(TILE)],
            frame: items.frameOf(flagName),
        });

        // Pickups
        for (const p of pickups) {
            if (!p.active) continue;
            const draw = PICKUP_DRAW[p.kind];
            const foot = PICKUP_FOOT[p.kind];
            // Grounded pickups (mushroom/star/fire-flower) anchor by the feet so the big
            // sprite sits on the ground / emerges cleanly from its block; coin-pop stays centred.
            const cy = foot !== undefined ? p.box.y + p.box.h - draw * foot : p.box.y + p.box.h / 2;
            updateSprite2DIndex(p.layer, p.slot, {
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
                updateSprite2DIndex(enemyLayer, e.slot, { visible: false });
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
            updateSprite2DIndex(enemyLayer, e.slot, {
                positionPx: [sx(e.box.x + e.box.w / 2), sy(e.box.y + e.box.h)],
                sizePx: [ss(efw * escale), ss(efh * escale)],
                frame: enemies.frameOf(name),
                visible: true,
                flipX: e.kind !== "piranha" && e.dir > 0,
                flipY: e.dying > 0,
            });
        }

        // Player
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

        // Iris-wipe transition (fullscreen custom-shader quad) during a pipe warp.
        if (warp.active) {
            const prog = warp.t / WARP_DUR;
            const k = prog < WARP_MID ? prog / WARP_MID : (1 - prog) / (1 - WARP_MID);
            updateSprite2DIndex(irisLayer, irisSlot, { positionPx: [0, 0], sizePx: [cw, ch], visible: true });
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
        game.flagAnimT += dt;
        player.animT += dt;

        switch (game.phase) {
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
                if (!warp.teleported && warp.t >= WARP_DUR * WARP_MID) {
                    // Teleport at the iris's darkest point so the camera jump is hidden.
                    player.box.x = warp.toCx * TILE + (TILE - player.box.w) / 2;
                    player.box.y = (warp.toCy + 1) * TILE - player.box.h;
                    player.vx = 0;
                    player.vy = 0;
                    player.onGround = true;
                    inCave = warp.toCave;
                    game.world = warp.label;
                    warp.teleported = true;
                }
                if (warp.t >= WARP_DUR) {
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
                        hud.banner("GAME OVER", "Press Enter / tap A to retry");
                    } else {
                        game.phase = "ready";
                        game.timer = 1.4;
                        game.time = START_TIME;
                        resetPlayer();
                        inCave = false;
                        game.world = "1-1";
                        for (const e of enemyList) respawnEnemy(e);
                        for (const p of pickups) {
                            p.active = false;
                            updateSprite2DIndex(p.layer, p.slot, { visible: false });
                        }
                        for (const f of fireballs) killFireball(f);
                        for (const s of sparks) killSpark(s);
                        for (const d of debris) killDebris(d);
                        for (const p of popups) hidePopup(p);
                        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.stand) });
                        hud.banner("WORLD 1-1", "Get ready!");
                    }
                }
                break;
            case "complete":
                game.timer -= dt;
                player.box.x += 120 * dt; // stroll off
                break;
            case "gameover":
                if (input.state.startPressed) restartLevel();
                break;
        }

        updateJuice(dt);
        project();
        hud.update({ score: game.score, coins: game.coins, lives: game.lives, time: game.time, world: game.world });
        input.endFrame();
        requestAnimationFrame(tick);
    };

    const respawnEnemy = (e: EnemyState): void => {
        const src = level.enemies.find((_, i) => enemyList[i] === e);
        if (!src) return;
        const { w, h } = enemyBoxDims(src.kind);
        const boxY = (src.cy + 1) * TILE - h;
        e.box = { x: src.cx * TILE + (TILE - w) / 2, y: boxY, w, h };
        e.alive = true;
        e.shell = false;
        e.shellDir = 0;
        e.dying = 0;
        e.dir = -1;
        e.vx = -PHYS.enemySpeed;
        e.vy = 0;
        e.homeY = boxY;
        e.phase = src.kind === "fly" ? Math.random() * Math.PI * 2 : 0;
    };

    const restartLevel = (): void => {
        game.score = 0;
        game.coins = 0;
        game.lives = 3;
        game.time = START_TIME;
        game.phase = "ready";
        game.timer = 1.4;
        resetPlayer();
        inCave = false;
        game.world = "1-1";
        warp.active = false;
        warp.cooldown = 0;
        for (const b of blocks) {
            b.used = false;
            b.broken = false;
            b.bump = 0;
            if (b.kind !== "brick") level.solid[b.cy * level.cols + b.cx] = 1;
            updateSprite2DIndex(blockLayer, b.slot, { frame: blockFrame(b.kind), visible: true });
        }
        for (const c of coins) {
            c.collected = false;
            updateSprite2DIndex(itemLayer, c.slot, { visible: true });
        }
        for (const e of enemyList) respawnEnemy(e);
        for (const p of pickups) {
            p.active = false;
            updateSprite2DIndex(p.layer, p.slot, { visible: false });
        }
        for (const f of fireballs) killFireball(f);
        for (const s of sparks) killSpark(s);
        for (const d of debris) killDebris(d);
        for (const p of popups) hidePopup(p);
        updateSprite2DIndex(playerLayer, playerSlot, { frame: players.frameOf(PLAYER_FRAMES.stand) });
        hud.banner("WORLD 1-1", "Get ready!");
    };

    requestAnimationFrame(tick);
    canvas.dataset.ready = "true";
}

// Keep an explicit reference so unused-import linters see the sheet types.
export type { PlatformerSheet, Level, Sprite2DLayer };
