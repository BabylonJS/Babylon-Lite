// First-person weapon sprite overlay for the DOOM demo.
//
// DOOM draws the player's weapon as a "player sprite" (psprite): a full-bright
// sprite anchored near the bottom-center of the 3D view, bobbing with movement
// and showing a muzzle-flash overlay when fired. We reproduce that here as a 2D
// canvas overlay so it costs nothing in the WebGPU bundle and never touches the
// parity-tested engine (matching the DOM HUD approach).
//
// Weapon sprite lumps are decoded from the WAD's S_START..S_END namespace and
// colored with PLAYPAL palette 0 (full-bright). Placement uses the documented
// psprite formula: a virtual 320x200 frame with the sprite's pivot offsets,
// the ready weapon resting at WEAPONTOP. No GPL Doom source is used.

import type { Wad } from "../wad/wad-file.js";
import { findLumpIndex, getLump } from "../wad/wad-file.js";
import { decodePatch } from "../wad/graphics.js";
import { parsePlaypal } from "../wad/palette.js";
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

// A decoded sprite ready to blit: its own pixel canvas plus pivot offsets.
interface DecodedSprite {
    canvas: HTMLCanvasElement;
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

export class WeaponView {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly palette: Uint8Array;
    private readonly cache = new Map<string, DecodedSprite | null>();

    private lastRefire = 0;
    private lastWeapon: Weapon | null = null;
    private flashTimer = 0;
    private bobPhase = 0;
    private bobAmp = 0;

    constructor(private readonly wad: Wad) {
        this.palette = parsePlaypal(wad); // palette 0 used (full-bright psprites)
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:47;image-rendering:pixelated";
        document.body.appendChild(canvas);
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d")!;
    }

    /** Decodes a psprite lump to a pixel canvas (palette 0, full-bright). Cached. */
    private decode(name: string): DecodedSprite | null {
        const cached = this.cache.get(name);
        if (cached !== undefined) return cached;
        const idx = findLumpIndex(this.wad, name);
        if (idx < 0) {
            this.cache.set(name, null);
            return null;
        }
        const img = decodePatch(getLump(this.wad, idx));
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const data = new ImageData(img.width, img.height);
        for (let i = 0; i < img.width * img.height; i++) {
            if (!img.opaque[i]) continue;
            const p = img.indices[i]! * 3;
            data.data[i * 4 + 0] = this.palette[p]!;
            data.data[i * 4 + 1] = this.palette[p + 1]!;
            data.data[i * 4 + 2] = this.palette[p + 2]!;
            data.data[i * 4 + 3] = 255;
        }
        c.getContext("2d")!.putImageData(data, 0, 0);
        const dec: DecodedSprite = { canvas: c, width: img.width, height: img.height, leftOffset: img.leftOffset, topOffset: img.topOffset };
        this.cache.set(name, dec);
        return dec;
    }

    /**
     * Updates the weapon overlay. `moving` enables the bob; `dt` is seconds since
     * the previous frame. Hidden while the player is dead.
     */
    update(player: Player, dt: number, moving: boolean): void {
        this.resize();
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (player.dead) {
            this.lastRefire = player.refireDelay;
            this.lastWeapon = player.weapon;
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
        const sprites = WEAPON_SPRITES[player.weapon];
        const gun = this.decode(firing ? sprites.fire : sprites.ready) ?? this.decode(sprites.ready);
        if (gun) this.draw(gun, bobX, bobY);
        if (firing && sprites.flash) {
            const flash = this.decode(sprites.flash);
            if (flash) this.draw(flash, bobX, bobY);
        }
    }

    /** Blits one psprite into the virtual 320x200 frame, scaled to the viewport. */
    private draw(s: DecodedSprite, bobX: number, bobY: number): void {
        const ctx = this.ctx;
        const scale = this.canvas.height / FRAME_H;
        const frameLeft = (this.canvas.width - FRAME_W * scale) / 2;
        // psprite placement: pivot column at frame center area, ready weapon at WEAPONTOP.
        const vx = -s.leftOffset + bobX;
        const vy = WEAPONTOP - s.topOffset + bobY;
        const dx = frameLeft + vx * scale;
        const dy = vy * scale;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s.canvas, dx, dy, s.width * scale, s.height * scale);
    }

    private resize(): void {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    }

    dispose(): void {
        this.canvas.remove();
    }
}
