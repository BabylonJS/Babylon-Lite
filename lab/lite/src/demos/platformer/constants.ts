/**
 * Tuning constants, the shared "star power" shader, and the one pure timing helper
 * for the platformer demo — everything the orchestrator ({@link ../game.ts}) treats
 * as fixed configuration. Pulled out of `game.ts` so the gameplay-feel knobs
 * (speeds, sizes, durations, pool capacities, colours) live in one readable place.
 *
 * Most sizes are expressed in {@link TILE}s so the whole game scales with the tile
 * grid. Draw sizes are deliberately DECOUPLED from collision boxes: the Kenney art
 * carries transparent padding, so sprites are drawn larger than their hitboxes and
 * anchored by a bottom/centre pivot (see the per-constant notes).
 */

import { TILE } from "./frames.js";
import { type PickupState } from "./entities.js";

/** Sky-blue clear colour for the overworld (the renderer's background). */
export const SKY = { r: 0.38, g: 0.62, b: 0.95, a: 1 } as const;
/** Starting level time (counts down; converted to a bonus at the goal). */
export const START_TIME = 300;

/** Number of afterimage ghosts in the star-power trail. */
export const STAR_TRAIL = 6;
/** Frame spacing between consecutive ghosts (larger = longer, sparser trail). */
export const STAR_TRAIL_GAP = 3;

// Visual draw sizes are decoupled from the collision boxes. The Kenney frames
// carry transparent padding above the character/creature (art sits at the frame
// bottom), and a tight hitbox feels better than a roomy one — so each sprite is
// DRAWN larger than its box, scaled to read ~1 tile like the ?-blocks. The
// bottom-centre pivot keeps the feet grounded as the sprite grows.
/** Player target *visible* height (small, un-grown / big, mushroom). Deluxe
 *  alien frames are tightly cropped (art reaches the frame edges), so the
 *  sprite is scaled by its stand-frame height to hit these heights; other poses
 *  (jump/duck/walk) keep their natural aspect. Big reads ~2 tiles (SMB-style). */
export const PLAYER_VIS_SMALL = TILE * 1.3;
export const PLAYER_VIS_BIG = TILE * 2.0;
/** Enemy sprite scale over its natural (tightly-cropped) frame size. */
export const ENEMY_VIS_SCALE = 1.45;
/** Flying-enemy tuning: horizontal drift, vertical bob amplitude / frequency. */
export const FLY_SPEED = 70;
export const FLY_AMP = TILE * 1.3;
export const FLY_FREQ = 2.2;
/** Piranha-plant emerge/retract cycle (seconds) and how far it rises (px). */
export const PIRANHA_CYCLE = 3.4;
export const PIRANHA_RISE = TILE * 1.45;
/** Castle boss tuning. */
export const BOSS_MAX_HP = 3;
export const BOSS_W = TILE * 2.8; // collision box (tuned to cover the drawn spider body)
export const BOSS_H = TILE * 2.35; // box top reaches the drawn head so the boss is stompable
export const BOSS_VIS_SCALE = 3.2; // boss sprite draw scale over its natural frame size
export const BOSS_SPEED = TILE * 1.6; // base pace speed (px/s); scales up per phase
export const BOSS_HURT_TIME = 1.0; // invulnerable-flash window after a hit (s)
export const BOSS_PROJ_MAX = 4;
export const BOSS_PROJ_SPEED = TILE * 5.5;
export const BOSS_PROJ_DRAW = TILE * 0.7;
/** Piranha emergence 0..1 (hidden → rising → up → retracting) from its cycle phase (s). */
export function piranhaEmerge(phase: number): number {
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
export const COIN_DRAW = TILE * 1.4;
/** Coin collection radius box (half-extent). */
export const COIN_PICK_HALF = TILE * 0.42;
/** Per-kind pickup DRAW size (square cell), tuned per art fill so each reads ~0.85 tile. */
export const PICKUP_DRAW: Record<PickupState["kind"], number> = {
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
export const PICKUP_FOOT: Partial<Record<PickupState["kind"], number>> = {
    mushroom: 0.5,
    star: 0.23,
    "fire-flower": 0.4,
};
/** Seconds the fire flower takes to rise out of its block (occluded reveal). */
export const FLOWER_EMERGE_DUR = 0.55;

// Fireball projectiles (fire power-up). Travel along the ground, bounce, and pop
// enemies on contact; drawn as additive glows.
export const FIREBALL_SPEED = 600;
export const FIREBALL_BOUNCE = 360;
export const FIREBALL_LIFE = 2.4;
export const FIREBALL_MAX = 2;
export const FIRE_COOLDOWN = 0.28;
export const FIREBALL_DRAW = TILE * 0.7;

// "Juice": additive sparkle bursts + floating score popups on coin / stomp.
/** Additive spark particle pool size + per-burst count. */
export const SPARK_MAX = 40;
export const SPARK_PER_BURST = 8;
export const SPARK_LIFE = 0.45;
export const SPARK_DRAW = TILE * 0.5;
/** Score-popup pool: each popup lays out up to MAX_DIGITS floating digit sprites. */
export const POPUP_MAX = 6;
export const POPUP_DIGITS = 4;
export const POPUP_LIFE = 0.8;
export const POPUP_RISE = TILE * 1.4; // world px the popup floats up over its life
export const POPUP_DIGIT_DRAW = TILE * 0.62;
/** Tint colours for sparkle bursts. */
export const SPARK_GOLD: readonly [number, number, number] = [1, 0.86, 0.4];
export const SPARK_WHITE: readonly [number, number, number] = [1, 1, 1];

// Brick-break debris: four spinning chunks fly out when a big player smashes a brick.
export const DEBRIS_MAX = 16;
export const DEBRIS_LIFE = 1.1;
export const DEBRIS_DRAW = TILE * 0.42;

/**
 * Player invincibility fragment: an animated rainbow palette-cycle + sparkle pulse,
 * mixed over the sprite by `fx.params.x` (0 = untouched sprite, 1 = full star dazzle).
 * At strength 0 it returns exactly the stock `atlas * tint * opacity`, so the same
 * layer renders the normal player when not invincible. WGSL contract per
 * `createSprite2DCustomShader`: `in.uv`/`in.tint`, `atlasTex`/`atlasSamp`, `fx.time`/
 * `fx.params`, and the layer UBO `L.opacityMul`.
 */
export const STAR_FRAGMENT = `
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
