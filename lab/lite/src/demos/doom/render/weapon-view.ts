// First-person weapon sprite overlay for the DOOM demo — Babylon-Lite Sprite2D path.
//
// DOOM draws the player's weapon as a "player sprite" (psprite): a full-bright
// sprite anchored near the bottom-center of the 3D view, bobbing with movement
// and showing a muzzle-flash overlay when fired. Here we reproduce it with a lite
// `Sprite2DLayer` drawn by a `SpriteRenderer` overlay (a 2D pass layered on top of
// the scene's swapchain), exercising the engine's Sprite2D custom-shader hook: the
// same palette + COLORMAP lookup the world uses, sampled at the full-bright row.
//
// Weapon sprite lumps are decoded from the WAD into one palette-indexed atlas
// (R = palette index, A = coverage). Placement uses the documented psprite
// formula: a virtual 320x200 frame with the sprite's pivot offsets, the ready
// weapon resting at WEAPONTOP. No GPL Doom source is used.

import {
    addSprite2DIndex,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteAtlasFromFrames,
    createSpriteRenderer,
    disposeSpriteRenderer,
    registerSpriteRenderer,
    updateSprite2DIndex,
    type EngineContext,
    type Sprite2DLayer,
    type SpriteAtlas,
    type SpriteAtlasFrameSource,
    type SpriteRenderer,
    type Texture2D,
} from "babylon-lite";
import type { Wad } from "../wad/wad-file.js";
import { findLumpIndex, getLump } from "../wad/wad-file.js";
import { decodePatch } from "../wad/graphics.js";
import type { Player } from "../player/player.js";
import { Weapon } from "../player/player.js";

interface WeaponSprites {
    /** Resting/idle frame lump name. */
    ready: string;
    /** Frame shown briefly while firing (falls back to `ready` if missing). */
    fire: string;
    /** Optional full-bright muzzle-flash overlay lump name. */
    flash: string | null;
}

// Per-weapon psprite lump names (Doom sprite-naming convention, present in Freedoom).
const WEAPON_SPRITES: Record<Weapon, WeaponSprites> = {
    [Weapon.FIST]: { ready: "PUNGA0", fire: "PUNGC0", flash: null },
    [Weapon.PISTOL]: { ready: "PISGA0", fire: "PISGB0", flash: "PISFA0" },
    [Weapon.SHOTGUN]: { ready: "SHTGA0", fire: "SHTGB0", flash: "SHTFA0" },
    [Weapon.CHAINGUN]: { ready: "CHGGA0", fire: "CHGGB0", flash: "CHGFA0" },
    [Weapon.ROCKET]: { ready: "MISGA0", fire: "MISGB0", flash: "MISFA0" },
    [Weapon.PLASMA]: { ready: "PLSGA0", fire: "PLSGB0", flash: "PLSFA0" },
    [Weapon.BFG]: { ready: "BFGGA0", fire: "BFGGB0", flash: "BFGFA0" },
    [Weapon.CHAINSAW]: { ready: "SAWGC0", fire: "SAWGA0", flash: null },
};

/** One decoded psprite placed in the shared atlas: its lite frame index plus pivot offsets. */
interface PSprite {
    frameIndex: number;
    width: number;
    height: number;
    leftOffset: number;
    topOffset: number;
}

const WEAPONTOP = 32; // virtual-frame Y of a resting weapon (psprite WEAPONTOP)
const FRAME_W = 320;
const FRAME_H = 200;
const FLASH_SECONDS = 0.12; // muzzle flash / fire-frame duration after a shot
const BOB_AMP = 6; // virtual pixels of weapon bob while moving
const BOB_SPEED = 3.43; // rad/s, ~Doom's 1.8s bob cycle
const ATLAS_WIDTH = 512;

// Full-bright psprite fragment: palette-indexed sample → COLORMAP row 0 (full-bright),
// with a hard cutout discard on coverage. Mirrors the world/enemy palette path.
const WEAPON_FRAGMENT = `let src = textureSample(atlasTex, atlasSamp, in.uv);
if (src.a < 0.5) { discard; }
let idx = floor(src.r * 255.0 + 0.5);
let lut = textureSample(colormapTex, colormapSamp, vec2<f32>((idx + 0.5) / 256.0, 0.5 / 34.0));
return vec4<f32>(lut.rgb, 1.0);`;

const GUN_SLOT = 0;
const FLASH_SLOT = 1;

export class WeaponView {
    private readonly atlas: SpriteAtlas;
    private readonly sprites = new Map<string, PSprite>();
    private readonly layer: Sprite2DLayer;
    private readonly renderer: SpriteRenderer;
    private registered = false;

    private lastRefire = 0;
    private lastWeapon: Weapon | null = null;
    private flashTimer = 0;
    private bobPhase = 0;
    private bobAmp = 0;

    constructor(
        private readonly engine: EngineContext,
        wad: Wad,
        colormapTex: Texture2D
    ) {
        this.atlas = this.buildAtlas(wad);
        const customShader = createSprite2DCustomShader({
            fragment: WEAPON_FRAGMENT,
            extraTextures: [{ name: "colormap", texture: colormapTex }],
        });
        // Layer pivot [0,0]: each sprite's `positionPx` is its top-left corner,
        // matching the virtual-frame placement computed in `place`.
        this.layer = createSprite2DLayer(this.atlas, { depth: "none", pivot: [0, 0], capacity: 2, customShader });
        // Gun + flash slots, both hidden until the first `update`.
        addSprite2DIndex(this.layer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
        addSprite2DIndex(this.layer, { positionPx: [0, 0], sizePx: [1, 1], visible: false });
        this.renderer = createSpriteRenderer(engine, { layers: [this.layer], clear: false });
    }

    /** Decode every weapon psprite lump into one palette-indexed atlas (R = index, A = coverage). */
    private buildAtlas(wad: Wad): SpriteAtlas {
        interface Pending {
            name: string;
            indices: Uint8Array;
            opaque: Uint8Array;
            w: number;
            h: number;
            left: number;
            top: number;
        }
        const seen = new Set<string>();
        const pending: Pending[] = [];
        for (const ws of Object.values(WEAPON_SPRITES)) {
            for (const name of [ws.ready, ws.fire, ws.flash]) {
                if (!name || seen.has(name)) continue;
                seen.add(name);
                const idx = findLumpIndex(wad, name);
                if (idx < 0) continue;
                const img = decodePatch(getLump(wad, idx));
                pending.push({ name, indices: img.indices, opaque: img.opaque, w: img.width, h: img.height, left: img.leftOffset, top: img.topOffset });
            }
        }

        // Encode each patch as a palette-indexed RGBA frame (R = palette index, A = coverage)
        // and let the engine packer build + upload the atlas.
        const sources: SpriteAtlasFrameSource[] = pending.map((it, i) => {
            this.sprites.set(it.name, { frameIndex: i, width: it.w, height: it.h, leftOffset: it.left, topOffset: it.top });
            const px = new Uint8Array(it.w * it.h * 4);
            for (let si = 0; si < it.w * it.h; si++) {
                if (!it.opaque[si]) continue;
                px[si * 4] = it.indices[si]!;
                px[si * 4 + 3] = 255;
            }
            return { pixels: px, width: it.w, height: it.h, pivot: [0, 0], name: it.name };
        });
        return createSpriteAtlasFromFrames(this.engine, sources, { maxWidthPx: ATLAS_WIDTH });
    }

    /**
     * Updates the weapon overlay. `moving` enables the bob; `dt` is seconds since
     * the previous frame. Hidden while the player is dead.
     */
    update(player: Player, dt: number, moving: boolean): void {
        if (!this.registered) {
            registerSpriteRenderer(this.renderer);
            this.registered = true;
        }
        if (player.dead) {
            this.lastRefire = player.refireDelay;
            this.lastWeapon = player.weapon;
            this.hide(GUN_SLOT);
            this.hide(FLASH_SLOT);
            return;
        }

        // A fresh shot bumps refireDelay back up; trigger the flash / fire frame.
        if (player.refireDelay > this.lastRefire && player.weapon === this.lastWeapon) {
            this.flashTimer = FLASH_SECONDS;
        }
        if (player.weapon !== this.lastWeapon) this.flashTimer = 0;
        this.lastRefire = player.refireDelay;
        this.lastWeapon = player.weapon;
        if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);

        // Bob: ramp amplitude up while moving, ease back to rest otherwise.
        const targetAmp = moving ? BOB_AMP : 0;
        this.bobAmp += (targetAmp - this.bobAmp) * Math.min(1, dt * 8);
        if (moving) this.bobPhase += dt * BOB_SPEED;
        const bobX = this.bobAmp * Math.cos(this.bobPhase);
        const bobY = this.bobAmp * Math.abs(Math.sin(this.bobPhase));

        const firing = this.flashTimer > 0;
        const sp = WEAPON_SPRITES[player.weapon];
        const gun = this.sprites.get(firing ? sp.fire : sp.ready) ?? this.sprites.get(sp.ready);
        if (gun) this.place(GUN_SLOT, gun, bobX, bobY);
        else this.hide(GUN_SLOT);

        const flash = firing && sp.flash ? this.sprites.get(sp.flash) : undefined;
        if (flash) this.place(FLASH_SLOT, flash, bobX, bobY);
        else this.hide(FLASH_SLOT);
    }

    /** Position one psprite slot in the virtual 320x200 frame, scaled to the render target. */
    private place(slot: number, s: PSprite, bobX: number, bobY: number): void {
        const canvas = this.engine.canvas;
        const scale = canvas.height / FRAME_H;
        const frameLeft = (canvas.width - FRAME_W * scale) / 2;
        const vx = -s.leftOffset + bobX;
        const vy = WEAPONTOP - s.topOffset + bobY;
        updateSprite2DIndex(this.layer, slot, {
            positionPx: [frameLeft + vx * scale, vy * scale],
            sizePx: [s.width * scale, s.height * scale],
            frame: s.frameIndex,
            visible: true,
        });
    }

    private hide(slot: number): void {
        updateSprite2DIndex(this.layer, slot, { visible: false });
    }

    dispose(): void {
        disposeSpriteRenderer(this.renderer);
        this.registered = false;
    }
}
