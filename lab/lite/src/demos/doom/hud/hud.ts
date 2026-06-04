// DOOM status bar rendered from the real WAD STBAR graphics — Babylon-Lite Sprite2D path.
//
// The classic status bar (STBAR) and all of its widgets — the big red counters,
// the ARMS panel, the animated face, the keys, the per-type ammo list and the
// pickup-message text (STCFN small font) — are decoded straight from the IWAD's
// UI lumps into one palette-indexed atlas and drawn each frame through a lite
// `Sprite2DLayer` overlay (a 2D pass on top of the scene swapchain), reusing the
// same palette + COLORMAP full-bright shader as the world/weapon. Widget
// coordinates come from public DOOM documentation (st_stuff.c layout constants);
// no GPL Doom source is used.
//
// A few feedback effects that have no STBAR equivalent — the full-screen
// pain/pickup tint, a center crosshair (our addition, since DOOM has none) and
// the death prompt — stay as lightweight DOM overlays.

import {
    addSprite2DIndex,
    clearSprite2DLayer,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteAtlasFromFrames,
    createSpriteRenderer,
    disposeSpriteRenderer,
    registerSpriteRenderer,
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
import { Pickup } from "../mobj/info.js";

const FRAME_W = 320;
const FRAME_H = 200;
const BAR_Y = 168; // top of the 32px status bar in the virtual 320x200 frame

// ARMS panel: the six selectable weapon slots, displayed as digits 2..7. The grey
// digits are baked into STARMS; a yellow STYSNUM is drawn over a slot once owned.
const ARMS_WEAPONS: readonly Weapon[] = [
    Weapon.PISTOL,
    Weapon.SHOTGUN,
    Weapon.CHAINGUN,
    Weapon.ROCKET,
    Weapon.PLASMA,
    Weapon.BFG,
];

// Small ammo list rows: [player.ammo index, virtual Y]. DOOM lists clip, shell,
// rocket, cell top-to-bottom; player.ammo is [bullets, shells, cells, rockets].
const AMMO_ROWS: readonly [number, number][] = [
    [0, 173],
    [1, 179],
    [3, 185],
    [2, 191],
];

// Key rows: [card pickup, skull pickup, virtual Y] for blue, yellow, red.
const KEY_ROWS: readonly [Pickup, Pickup, number][] = [
    [Pickup.KEY_BLUE, Pickup.KEY_BLUE_SKULL, 171],
    [Pickup.KEY_YELLOW, Pickup.KEY_YELLOW_SKULL, 181],
    [Pickup.KEY_RED, Pickup.KEY_RED_SKULL, 191],
];

/** One decoded UI lump placed in the shared atlas: its lite frame index plus pivot offsets. */
interface UiPatch {
    frameIndex: number;
    width: number;
    height: number;
    leftOffset: number;
    topOffset: number;
}

const ATLAS_WIDTH = 1024;

// Full-bright UI fragment: palette-indexed sample → COLORMAP row 0, cutout discard.
// Identical to the weapon overlay; the world's COLORMAP texture is reused.
const HUD_FRAGMENT = `let src = textureSample(atlasTex, atlasSamp, in.uv);
if (src.a < 0.5) { discard; }
let idx = floor(src.r * 255.0 + 0.5);
let lut = textureSample(colormapTex, colormapSamp, vec2<f32>((idx + 0.5) / 256.0, 0.5 / 34.0));
return vec4<f32>(lut.rgb, 1.0);`;

/** Enumerates every HUD lump baked into the atlas (fixed names + digit / face / font ranges). */
function hudLumpNames(): string[] {
    const names = ["STBAR", "STARMS", "STTPRCNT", "STFDEAD0"];
    for (let i = 0; i < 10; i++) names.push(`STTNUM${i}`, `STYSNUM${i}`);
    for (let i = 0; i < 9; i++) names.push(`STKEYS${i}`);
    for (let pl = 0; pl < 5; pl++) {
        names.push(`STFOUCH${pl}`);
        for (let look = 0; look < 3; look++) names.push(`STFST${pl}${look}`);
    }
    // Small message font (STCFN), printable ASCII 33..95 ('!'..'_').
    for (let code = 33; code <= 95; code++) names.push(`STCFN${String(code).padStart(3, "0")}`);
    return names;
}

export class DoomHud {
    private readonly atlas: SpriteAtlas;
    private readonly patches = new Map<string, UiPatch>();
    private readonly layer: Sprite2DLayer;
    private readonly renderer: SpriteRenderer;
    private registered = false;

    private readonly crosshair: HTMLDivElement;
    private readonly painEl: HTMLDivElement;
    private readonly deathEl: HTMLDivElement;

    /** Advance widths (px) for the tall (STTNUM) and small (STYSNUM) digit fonts. */
    private readonly tallW: number;
    private readonly shortW: number;
    private faceTime = 0;
    private message = "";

    // Per-frame placement state (set at the top of `update`).
    private scale = 1;
    private frameLeft = 0;

    constructor(
        private readonly engine: EngineContext,
        wad: Wad,
        private readonly player: Player,
        colormapTex: Texture2D
    ) {
        this.atlas = this.buildAtlas(wad);
        const customShader = createSprite2DCustomShader({
            fragment: HUD_FRAGMENT,
            extraTextures: [{ name: "colormap", texture: colormapTex }],
        });
        this.layer = createSprite2DLayer(this.atlas, { depth: "none", pivot: [0, 0], capacity: 160, customShader });
        this.renderer = createSpriteRenderer(engine, { layers: [this.layer], clear: false });

        this.tallW = this.patches.get("STTNUM0")?.width ?? 14;
        this.shortW = this.patches.get("STYSNUM0")?.width ?? 4;

        // Red damage / pickup full-screen tint.
        const pain = document.createElement("div");
        pain.style.cssText = "position:fixed;inset:0;pointer-events:none;background:#ff0000;opacity:0;transition:opacity .1s linear;z-index:48";
        this.painEl = pain;

        // Center crosshair (shows where autoaimed shots are sent).
        const cross = document.createElement("div");
        cross.style.cssText = "position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;z-index:51;opacity:.85";
        cross.innerHTML =
            `<div style="position:absolute;left:10px;top:0;width:2px;height:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;left:10px;bottom:0;width:2px;height:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;top:10px;left:0;height:2px;width:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;top:10px;right:0;height:2px;width:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;left:10px;top:10px;width:2px;height:2px;background:#34ff34"></div>`;
        this.crosshair = cross;

        // Death prompt: hidden until the player is killed.
        const death = document.createElement("div");
        death.style.cssText = "position:fixed;left:50%;top:36%;transform:translateX(-50%);text-align:center;pointer-events:none;z-index:52;opacity:0;transition:opacity .4s linear;font-family:'Courier New',monospace";
        death.innerHTML =
            `<div style="color:#d21d12;font-weight:bold;font-size:52px;letter-spacing:4px;text-shadow:3px 3px 0 #000,0 0 16px rgba(210,29,18,.8)">YOU DIED</div>` +
            `<div style="margin-top:14px;color:#e8e8b0;font-weight:bold;font-size:18px;text-shadow:2px 2px 0 #000">Press SPACE to restart</div>`;
        this.deathEl = death;

        document.body.appendChild(pain);
        document.body.appendChild(cross);
        document.body.appendChild(death);
    }

    /** Decode every HUD lump into one palette-indexed atlas (R = index, A = coverage). */
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
        const pending: Pending[] = [];
        for (const name of hudLumpNames()) {
            const idx = findLumpIndex(wad, name);
            if (idx < 0) continue;
            const img = decodePatch(getLump(wad, idx));
            pending.push({ name, indices: img.indices, opaque: img.opaque, w: img.width, h: img.height, left: img.leftOffset, top: img.topOffset });
        }

        // Encode each patch as a palette-indexed RGBA frame (R = palette index, A = coverage)
        // and let the engine packer build + upload the atlas.
        const sources: SpriteAtlasFrameSource[] = pending.map((it, i) => {
            this.patches.set(it.name, { frameIndex: i, width: it.w, height: it.h, leftOffset: it.left, topOffset: it.top });
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

    /** Adds one patch sprite at virtual (vx,vy), honoring its pivot offsets. */
    private blit(name: string, vx: number, vy: number): void {
        const p = this.patches.get(name);
        if (!p) return;
        const dx = this.frameLeft + (vx - p.leftOffset) * this.scale;
        const dy = (vy - p.topOffset) * this.scale;
        addSprite2DIndex(this.layer, {
            positionPx: [dx, dy],
            sizePx: [p.width * this.scale, p.height * this.scale],
            frame: p.frameIndex,
        });
    }

    /**
     * Adds an integer right-justified so its rightmost edge sits at virtual `rightX`.
     * `prefix` (e.g. "STTNUM"/"STYSNUM") + digit picks the font lump.
     */
    private blitNum(value: number, rightX: number, y: number, prefix: string, advance: number, maxDigits: number): void {
        let v = Math.max(0, Math.floor(value));
        let x = rightX;
        let n = 0;
        do {
            x -= advance;
            this.blit(`${prefix}${v % 10}`, x, y);
            v = Math.floor(v / 10);
            n++;
        } while (v > 0 && n < maxDigits);
    }

    /** Adds the pickup message as a row of STCFN small-font sprites at virtual (8,8). */
    private blitMessage(text: string): void {
        let x = 8;
        const y = 8;
        for (const ch of text.toUpperCase()) {
            const code = ch.charCodeAt(0);
            if (ch === " ") {
                x += 5;
                continue;
            }
            if (code < 33 || code > 95) continue;
            const p = this.patches.get(`STCFN${String(code).padStart(3, "0")}`);
            if (!p) {
                x += 5;
                continue;
            }
            this.blit(`STCFN${String(code).padStart(3, "0")}`, x, y);
            x += p.width + 1;
        }
    }

    /** Picks the status-bar face lump for the current player state. */
    private faceLump(): string {
        const p = this.player;
        if (p.dead) return "STFDEAD0";
        // Pain level 0 (healthy) .. 4 (near death), matching DOOM's face stride.
        const pl = Math.max(0, Math.min(4, Math.floor(((100 - Math.max(0, p.health)) * 5) / 101)));
        if (p.painFlash > 0.6) return `STFOUCH${pl}`;
        const look = Math.floor(this.faceTime / 0.5) % 3; // left / center / right glance
        return `STFST${pl}${look}`;
    }

    flashMessage(text: string): void {
        this.message = text;
    }

    update(dt: number): void {
        if (!this.registered) {
            registerSpriteRenderer(this.renderer);
            this.registered = true;
        }
        this.faceTime += dt;

        const canvas = this.engine.canvas;
        this.scale = canvas.height / FRAME_H;
        this.frameLeft = (canvas.width - FRAME_W * this.scale) / 2;

        const p = this.player;
        clearSprite2DLayer(this.layer);

        // Background bar + the ARMS panel overlay.
        this.blit("STBAR", 0, BAR_Y);
        this.blit("STARMS", 104, BAR_Y);

        // Ready-weapon ammo (tall, right-justified). Skip for ammo-less weapons.
        const ready = p.currentAmmo();
        if (ready >= 0) this.blitNum(ready, 44, 171, "STTNUM", this.tallW, 3);

        // Health + armor percentages (tall number then a '%').
        this.blitNum(p.health, 90, 171, "STTNUM", this.tallW, 3);
        this.blit("STTPRCNT", 90, 171);
        this.blitNum(p.armor, 221, 171, "STTNUM", this.tallW, 3);
        this.blit("STTPRCNT", 221, 171);

        // ARMS: light owned slots with the yellow digit over the baked-in grey.
        for (let i = 0; i < ARMS_WEAPONS.length; i++) {
            if (!p.weaponsOwned.has(ARMS_WEAPONS[i]!)) continue;
            const x = 111 + (i % 3) * 12;
            const ry = 172 + Math.floor(i / 3) * 10;
            this.blit(`STYSNUM${i + 2}`, x, ry);
        }

        // Face.
        this.blit(this.faceLump(), 143, BAR_Y);

        // Keys: combined card+skull icon if both are held.
        for (let c = 0; c < KEY_ROWS.length; c++) {
            const [card, skull, ky] = KEY_ROWS[c]!;
            const hasCard = p.keys.has(card);
            const hasSkull = p.keys.has(skull);
            let lump: string | null = null;
            if (hasCard && hasSkull) lump = `STKEYS${c + 6}`;
            else if (hasSkull) lump = `STKEYS${c + 3}`;
            else if (hasCard) lump = `STKEYS${c}`;
            if (lump) this.blit(lump, 239, ky);
        }

        // Per-type ammo list: current (right edge 288) and max (right edge 314).
        for (const [idx, ay] of AMMO_ROWS) {
            this.blitNum(p.ammo[idx]!, 288, ay, "STYSNUM", this.shortW, 3);
            this.blitNum(p.maxAmmo[idx]!, 314, ay, "STYSNUM", this.shortW, 3);
        }

        // Pickup message (STCFN small font) along the top edge.
        if (p.messageTics > 0 && this.message) this.blitMessage(this.message);

        // DOM feedback overlays.
        this.painEl.style.opacity = (p.painFlash * 0.4).toFixed(2);
        this.deathEl.style.opacity = p.dead ? "1" : "0";
        this.crosshair.style.opacity = p.dead ? "0" : ".85";
    }

    dispose(): void {
        disposeSpriteRenderer(this.renderer);
        this.registered = false;
        this.crosshair.remove();
        this.deathEl.remove();
        this.painEl.remove();
    }
}
