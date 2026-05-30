// DOOM status-bar HUD rendered with Babylon-Lite Sprite2D — the classic STBAR.
//
// The original DOOM HUD is a 320x32 bitmap status bar (lump STBAR) drawn at the
// bottom of the 320x200 frame, with the dynamic readouts (ammo / health / armor
// counters, the ARMS panel, the marine face, the key icons and the per-type ammo
// list) composited on top from individual patch lumps (STTNUM/STYSNUM digits,
// STTPRCNT, STKEYS, STFST faces, STARMS). Pickup messages use the small HUD font
// (STCFN). This module decodes all of those lumps from the WAD into one
// palette-indexed atlas and draws them through a lite `Sprite2DLayer` + custom
// fragment shader (the same palette → COLORMAP full-bright lookup the world uses),
// exercising the engine's Sprite2D path with a real, dynamic, multi-element HUD.
//
// A handful of non-STBAR overlays that have no WAD lump — the aiming crosshair,
// the full-screen damage/pickup tint, and the (non-vanilla) death prompt — remain
// as a few lightweight DOM elements; everything that DOOM actually ships as a
// status-bar graphic is now a sprite. No GPL Doom source is used; placement
// constants come from public Doom documentation.

import {
    addSprite2DIndex,
    clearSprite2DLayer,
    createSprite2DCustomShader,
    createSprite2DLayer,
    createSpriteAtlasFromFrames,
    createSpriteRenderer,
    createTexture2DFromPixels,
    disposeSpriteRenderer,
    registerSpriteRenderer,
    type AtlasFrameSpec,
    type EngineContext,
    type Sprite2DLayer,
    type SpriteAtlas,
    type SpriteRenderer,
    type Texture2D,
} from "babylon-lite";
import type { Wad } from "../wad/wad-file.js";
import { findLumpIndex, getLump } from "../wad/wad-file.js";
import { decodePatch } from "../wad/graphics.js";
import type { Player } from "../player/player.js";
import { Weapon } from "../player/player.js";
import { Pickup } from "../mobj/info.js";

const RED = "#d21d12";

/** One ARMS panel entry: the on-screen slot number and the weapon it selects. */
interface ArmsSlot {
    slot: number;
    weapon: Weapon;
}

/**
 * Canonical DOOM ARMS slots (the STBAR shows weapon slots 2..7). The HUD lights a
 * slot's number yellow once its weapon is owned; the gray base numbers come from
 * the STARMS background patch.
 */
export const ARMS_SLOTS: readonly ArmsSlot[] = [
    { slot: 2, weapon: Weapon.PISTOL },
    { slot: 3, weapon: Weapon.SHOTGUN },
    { slot: 4, weapon: Weapon.CHAINGUN },
    { slot: 5, weapon: Weapon.ROCKET },
    { slot: 6, weapon: Weapon.PLASMA },
    { slot: 7, weapon: Weapon.BFG },
];

// Virtual-frame geometry (DOOM's 320x200 reference). The status bar is the bottom
// 32 rows; we scale the whole 320x200 frame to the render target's height and
// center it horizontally, matching the weapon psprite overlay.
const FRAME_W = 320;
const FRAME_H = 200;
const ST_Y = 168; // top of the status bar in the virtual frame

// Dynamic-readout anchor coordinates (public Doom ST_* constants). `*X` for the
// counters is the RIGHT edge of a right-aligned number.
const ST_AMMOX = 44;
const ST_AMMOY = 171;
const ST_HEALTHX = 90;
const ST_HEALTHY = 171;
const ST_ARMORX = 221;
const ST_ARMORY = 171;
const ST_ARMSX = 111;
const ST_ARMSY = 172;
const ST_ARMSXSPACE = 12;
const ST_ARMSYSPACE = 10;
const ST_ARMSBGX = 104;
const ST_FACESX = 143;
const ST_FACESY = 168;
const ST_KEYX = 239;
const ST_KEY0Y = 171;
const ST_KEYYSPACE = 10;
// Small per-type ammo list (now / max), right-aligned.
const ST_AMMO_NOWX = 288;
const ST_AMMO_MAXX = 314;
const ST_AMMO0Y = 173;
const ST_AMMOYSPACE = 6;

const ATLAS_WIDTH = 512;

// Full-bright HUD fragment: palette-indexed sample → COLORMAP row 0 (full-bright),
// hard cutout on coverage. Identical lookup to the world / weapon, so the HUD's
// reds and grays match the rest of the rendered scene exactly.
const HUD_FRAGMENT = `let src = textureSample(atlasTex, atlasSamp, in.uv);
if (src.a < 0.5) { discard; }
let idx = floor(src.r * 255.0 + 0.5);
let lut = textureSample(colormapTex, colormapSamp, vec2<f32>((idx + 0.5) / 256.0, 0.5 / 34.0));
return vec4<f32>(lut.rgb, 1.0);`;

/** One decoded HUD patch placed in the shared atlas. */
interface Glyph {
    frameIndex: number;
    width: number;
    height: number;
    leftOffset: number;
    topOffset: number;
}

export class DoomHud {
    private readonly atlas: SpriteAtlas;
    private readonly glyphs = new Map<string, Glyph>();
    private readonly layer: Sprite2DLayer;
    private readonly renderer: SpriteRenderer;
    private registered = false;
    private readonly achievable: ReadonlySet<Weapon>;

    // Non-STBAR DOM overlays (no WAD lump): crosshair, damage tint, death prompt.
    private readonly crosshair: HTMLDivElement;
    private readonly painEl: HTMLDivElement;
    private readonly deathEl: HTMLDivElement;

    constructor(
        private readonly engine: EngineContext,
        wad: Wad,
        private readonly player: Player,
        colormapTex: Texture2D,
        achievableWeapons: ReadonlySet<Weapon>
    ) {
        this.achievable = achievableWeapons;
        this.atlas = this.buildAtlas(wad);

        const customShader = createSprite2DCustomShader({
            fragment: HUD_FRAGMENT,
            extraTextures: [{ name: "colormap", texture: colormapTex }],
        });
        // Pivot [0,0]: each sprite's `positionPx` is its top-left corner, matching
        // the virtual-frame placement computed in `blit`.
        this.layer = createSprite2DLayer(this.atlas, { depth: "none", blendMode: "alpha", pivot: [0, 0], capacity: 96, customShader });
        this.renderer = createSpriteRenderer(engine, { layers: [this.layer], clear: false });

        // Center crosshair (shows where autoaimed shots land — not a DOOM lump).
        const cross = document.createElement("div");
        cross.style.cssText = "position:fixed;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;pointer-events:none;z-index:51;opacity:.85";
        cross.innerHTML =
            `<div style="position:absolute;left:10px;top:0;width:2px;height:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;left:10px;bottom:0;width:2px;height:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;top:10px;left:0;height:2px;width:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;top:10px;right:0;height:2px;width:8px;background:#34ff34;box-shadow:0 0 2px #000"></div>` +
            `<div style="position:absolute;left:10px;top:10px;width:2px;height:2px;background:#34ff34"></div>`;
        this.crosshair = cross;

        // Full-screen red damage / pickup tint.
        const pain = document.createElement("div");
        pain.style.cssText = "position:fixed;inset:0;pointer-events:none;background:#ff0000;opacity:0;transition:opacity .1s linear;z-index:48";
        this.painEl = pain;

        // Death prompt (non-vanilla): hidden until the player is killed.
        const death = document.createElement("div");
        death.style.cssText = "position:fixed;left:50%;top:36%;transform:translateX(-50%);text-align:center;pointer-events:none;z-index:52;opacity:0;transition:opacity .4s linear;font-family:'Courier New',monospace";
        death.innerHTML =
            `<div style="color:${RED};font-weight:bold;font-size:52px;letter-spacing:4px;text-shadow:3px 3px 0 #000,0 0 16px rgba(210,29,18,.8)">YOU DIED</div>` +
            `<div style="margin-top:14px;color:#e8e8b0;font-weight:bold;font-size:18px;text-shadow:2px 2px 0 #000">Press SPACE to restart</div>`;
        this.deathEl = death;

        document.body.appendChild(pain);
        document.body.appendChild(cross);
        document.body.appendChild(death);
    }

    /** Decode every HUD patch lump into one palette-indexed atlas (R = index, A = coverage). */
    private buildAtlas(wad: Wad): SpriteAtlas {
        interface Pending {
            name: string;
            indices: Uint8Array;
            opaque: Uint8Array;
            w: number;
            h: number;
            left: number;
            top: number;
            ax: number;
            ay: number;
        }

        // Every lump the HUD might draw. Missing lumps are skipped gracefully.
        const names: string[] = ["STBAR", "STARMS", "STTPRCNT"];
        for (let d = 0; d <= 9; d++) {
            names.push(`STTNUM${d}`, `STYSNUM${d}`);
        }
        for (let k = 0; k <= 5; k++) names.push(`STKEYS${k}`);
        for (let b = 0; b <= 4; b++) names.push(`STFST${b}1`);
        names.push("STFDEAD0");
        // Small HUD font for pickup messages (ASCII 33..95 → STCFN033..STCFN095).
        for (let c = 33; c <= 95; c++) names.push(`STCFN${String(c).padStart(3, "0")}`);

        const pending: Pending[] = [];
        for (const name of names) {
            const idx = findLumpIndex(wad, name);
            if (idx < 0) continue;
            const img = decodePatch(getLump(wad, idx));
            pending.push({ name, indices: img.indices, opaque: img.opaque, w: img.width, h: img.height, left: img.leftOffset, top: img.topOffset, ax: 0, ay: 0 });
        }

        // Shelf packer: tallest-first into rows of fixed width.
        const items = pending.slice().sort((a, b) => b.h - a.h);
        const pad = 1;
        let x = pad;
        let y = pad;
        let shelfH = 0;
        let maxX = 0;
        for (const it of items) {
            if (x + it.w + pad > ATLAS_WIDTH) {
                x = pad;
                y += shelfH + pad;
                shelfH = 0;
            }
            it.ax = x;
            it.ay = y;
            x += it.w + pad;
            if (it.h > shelfH) shelfH = it.h;
            if (x > maxX) maxX = x;
        }
        const atlasW = nextPow2(maxX);
        const atlasH = nextPow2(y + shelfH + pad);

        const rgba = new Uint8Array(atlasW * atlasH * 4);
        for (const it of items) {
            for (let yy = 0; yy < it.h; yy++) {
                for (let xx = 0; xx < it.w; xx++) {
                    const si = yy * it.w + xx;
                    if (!it.opaque[si]) continue;
                    const di = ((it.ay + yy) * atlasW + (it.ax + xx)) * 4;
                    rgba[di] = it.indices[si]!;
                    rgba[di + 3] = 255;
                }
            }
        }
        const texture = createTexture2DFromPixels(this.engine, rgba, atlasW, atlasH, {
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
        });
        const frameSpecs: AtlasFrameSpec[] = items.map((it) => ({
            rectPx: [it.ax, it.ay, it.w, it.h] as [number, number, number, number],
            pivotPx: [it.left, it.top] as [number, number],
        }));
        items.forEach((it, i) => {
            this.glyphs.set(it.name, { frameIndex: i, width: it.w, height: it.h, leftOffset: it.left, topOffset: it.top });
        });
        return createSpriteAtlasFromFrames(texture, frameSpecs);
    }

    /** No-op retained for API compatibility; the message text is read from the player in `update`. */
    flashMessage(_text: string): void {
        // Pickup messages are sprite-rendered from `player.message` while
        // `player.messageTics > 0`; nothing extra to do here.
    }

    /** Rebuilds and re-uploads the whole status bar for the current player state. */
    update(): void {
        const p = this.player;

        // Lazily register the overlay on the first frame so it draws after the scene.
        if (!this.registered) {
            registerSpriteRenderer(this.renderer);
            this.registered = true;
        }

        clearSprite2DLayer(this.layer);

        // Status-bar background + ARMS panel.
        this.blit("STBAR", 0, ST_Y);
        this.blit("STARMS", ST_ARMSBGX, ST_Y);

        // Big counters: ammo (blank for ammo-less weapons), health %, armor %.
        const ammo = p.currentAmmo();
        if (ammo >= 0) this.drawNum("STTNUM", ammo, ST_AMMOX, ST_AMMOY);
        this.drawPercent(p.health, ST_HEALTHX, ST_HEALTHY);
        this.drawPercent(p.armor, ST_ARMORX, ST_ARMORY);

        // ARMS: light each owned, level-achievable slot's number yellow.
        for (const { slot, weapon } of ARMS_SLOTS) {
            if (!this.achievable.has(weapon) || !p.weaponsOwned.has(weapon)) continue;
            const i = slot - 2;
            const gx = ST_ARMSX + (i % 3) * ST_ARMSXSPACE;
            const gy = ST_ARMSY + Math.floor(i / 3) * ST_ARMSYSPACE;
            this.blit(`STYSNUM${slot}`, gx, gy);
        }

        // Marine face: front-facing patch by health band, or the death face.
        const band = Math.min(4, Math.max(0, Math.floor((100 - p.health) / 20)));
        this.blit(p.dead ? "STFDEAD0" : `STFST${band}1`, ST_FACESX, ST_FACESY);

        // Keys (blue / yellow / red, top to bottom); skull icon preferred when owned.
        this.drawKey(p.keys, Pickup.KEY_BLUE, Pickup.KEY_BLUE_SKULL, 0, 3, 0);
        this.drawKey(p.keys, Pickup.KEY_YELLOW, Pickup.KEY_YELLOW_SKULL, 1, 4, 1);
        this.drawKey(p.keys, Pickup.KEY_RED, Pickup.KEY_RED_SKULL, 2, 5, 2);

        // Per-type ammo list (now / max) for bullets, shells, rockets, cells.
        const rows: number[] = [0, 1, 3, 2]; // ammo[] index per displayed row
        for (let r = 0; r < rows.length; r++) {
            const idx = rows[r]!;
            const ry = ST_AMMO0Y + r * ST_AMMOYSPACE;
            this.drawNum("STYSNUM", p.ammo[idx]!, ST_AMMO_NOWX, ry);
            this.drawNum("STYSNUM", p.maxAmmo[idx]!, ST_AMMO_MAXX, ry);
        }

        // Pickup message (small HUD font) at top-left while active.
        if (p.messageTics > 0 && p.message) this.drawString(p.message, 2, 2);

        // DOM overlays react to state.
        this.painEl.style.opacity = (p.painFlash * 0.4).toFixed(2);
        this.deathEl.style.opacity = p.dead ? "1" : "0";
        this.crosshair.style.opacity = p.dead ? "0" : ".85";
    }

    /** Pick and draw a key icon (skull form if owned, else card) for one color row. */
    private drawKey(keys: ReadonlySet<Pickup>, card: Pickup, skull: Pickup, cardIdx: number, skullIdx: number, row: number): void {
        const hasSkull = keys.has(skull);
        const hasCard = keys.has(card);
        if (!hasSkull && !hasCard) return;
        this.blit(`STKEYS${hasSkull ? skullIdx : cardIdx}`, ST_KEYX, ST_KEY0Y + row * ST_KEYYSPACE);
    }

    /** Draw a non-negative integer right-aligned so its rightmost pixel sits at `rightX`. */
    private drawNum(prefix: string, value: number, rightX: number, y: number): void {
        const s = String(Math.max(0, value | 0));
        let total = 0;
        for (const ch of s) total += this.glyphs.get(prefix + ch)?.width ?? 0;
        let x = rightX - total;
        for (const ch of s) {
            const g = this.glyphs.get(prefix + ch);
            if (!g) continue;
            this.blit(prefix + ch, x, y);
            x += g.width;
        }
    }

    /** Draw a percent readout: the number right-aligned to `x`, then `%` at `x`. */
    private drawPercent(value: number, x: number, y: number): void {
        this.drawNum("STTNUM", value, x, y);
        this.blit("STTPRCNT", x, y);
    }

    /** Draw a string with the small HUD font (uppercased; unknown chars become spaces). */
    private drawString(text: string, vx: number, vy: number): void {
        let x = vx;
        const spaceW = this.glyphs.get("STCFN065")?.width ?? 4; // 'A' width as a fallback advance
        for (const raw of text.toUpperCase()) {
            const code = raw.charCodeAt(0);
            if (code === 32 || code < 33 || code > 95) {
                x += spaceW;
                continue;
            }
            const name = `STCFN${String(code).padStart(3, "0")}`;
            const g = this.glyphs.get(name);
            if (!g) {
                x += spaceW;
                continue;
            }
            this.blit(name, x, vy);
            x += g.width + 1;
        }
    }

    /** Add one HUD patch to the layer at virtual coords, honoring its pivot offsets. */
    private blit(name: string, vx: number, vy: number): void {
        const g = this.glyphs.get(name);
        if (!g) return;
        const canvas = this.engine.canvas;
        const scale = canvas.height / FRAME_H;
        const frameLeft = (canvas.width - FRAME_W * scale) / 2;
        const sx = frameLeft + (vx - g.leftOffset) * scale;
        const sy = (vy - g.topOffset) * scale;
        addSprite2DIndex(this.layer, {
            positionPx: [sx, sy],
            sizePx: [g.width * scale, g.height * scale],
            frame: g.frameIndex,
            visible: true,
        });
    }

    dispose(): void {
        if (this.registered) {
            disposeSpriteRenderer(this.renderer);
            this.registered = false;
        }
        this.crosshair.remove();
        this.deathEl.remove();
        this.painEl.remove();
    }
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
