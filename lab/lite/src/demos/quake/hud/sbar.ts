// Authentic Quake status bar (sbar + ibar), reimplemented clean-room from the
// documented WinQuake sbar.c layout (coordinates are factual data, not code).
//
// The graphics come from `gfx.wad` (TYP_QPIC lumps): SBAR/IBAR backgrounds,
// NUM_/ANUM_ digit fonts, FACE/FACE_P animation frames, SB_* ammo/armor icons
// and INV_/INV2_ weapon icons. Pixels are decoded through the Quake palette
// (index 255 = transparent) onto off-screen canvases, then blitted with
// nearest-neighbour scaling onto a full-screen overlay canvas anchored to the
// bottom-centre of the viewport.

import { indicesToRgba, type Palette } from "../palette.js";
import { parseWad2, readQpic, TYP_QPIC, type Wad2 } from "../render/wad2.js";
import { demoAssetUrl } from "../../demo-asset-url.js";

const BAR_W = 320;
const BAR_H = 24;
const DIGIT_ADVANCE = 24; // each NUM_/ANUM_ pic is 24px wide

export interface SbarWeaponSlot {
    /** Base lump name without the INV_/INV2_ prefix (e.g. "SHOTGUN"). */
    invIcon: string;
    /** X offset within the ibar in 320-wide bar pixels. */
    ibarSlotX: number;
    /** True if this is the currently-selected weapon (uses INV2_ icon). */
    selected: boolean;
}

export interface SbarStats {
    health: number;
    armor: number;
    ammo: number;
    kills: number;
    total: number;
    /** Owned weapons drawn on the ibar; empty falls back to the lone shotgun. */
    weapons?: SbarWeaponSlot[];
    /** sbar ammo-count icon lump for the active weapon (defaults to SB_SHELLS). */
    ammoIcon?: string;
}

export class SbarHud {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly cache = new Map<string, HTMLCanvasElement | null>();
    private scale = 2;
    private stats: SbarStats = { health: 100, armor: 0, ammo: 0, kills: 0, total: 0 };
    private lastHealth = 100;
    private painUntil = 0;
    private painTimer = 0;

    private constructor(
        private readonly wad: Wad2,
        private readonly palette: Palette
    ) {
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9998;image-rendering:pixelated;";
        document.body.appendChild(canvas);
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d")!;
        this.resize();
        window.addEventListener("resize", () => this.resize());
    }

    /** Load gfx.wad and build the overlay; resolves null if the asset is missing. */
    static async create(palette: Palette): Promise<SbarHud | null> {
        try {
            const res = await fetch(demoAssetUrl("./librequake/gfx.wad", import.meta.url));
            if (!res.ok) return null;
            const wad = parseWad2(await res.arrayBuffer());
            return new SbarHud(wad, palette);
        } catch {
            return null;
        }
    }

    setStats(stats: SbarStats): void {
        if (stats.health < this.lastHealth && stats.health > 0) {
            this.painUntil = performance.now() + 500;
            window.clearTimeout(this.painTimer);
            // Redraw once the pain face expires so the normal face returns.
            this.painTimer = window.setTimeout(() => this.draw(), 520);
        }
        this.lastHealth = stats.health;
        this.stats = stats;
        this.draw();
    }

    private resize(): void {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        // Size the 320px-wide bar to roughly a third of the viewport, snapped to
        // an integer scale (1-3) so the pixel art stays crisp. Scale 1 keeps the
        // bar compact on smaller windows so the weapon viewmodel stays visible.
        const target = (window.innerWidth * 0.34) / BAR_W;
        this.scale = Math.max(1, Math.min(3, Math.round(target)));
        this.draw();
    }

    /** Decode a QPIC lump to an off-screen canvas, caching the result. */
    private pic(name: string, transparent = true): HTMLCanvasElement | null {
        const key = name.toUpperCase();
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        const lump = this.wad.get(key);
        if (!lump || lump.type !== TYP_QPIC) {
            this.cache.set(key, null);
            return null;
        }
        const q = readQpic(lump);
        const rgba = indicesToRgba(q.indices, this.palette, transparent);
        const cv = document.createElement("canvas");
        cv.width = q.width;
        cv.height = q.height;
        cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), q.width, q.height), 0, 0);
        this.cache.set(key, cv);
        return cv;
    }

    private blit(name: string, rx: number, ry: number, ox: number, oy: number, transparent = true): void {
        const pic = this.pic(name, transparent);
        if (!pic) return;
        const s = this.scale;
        this.ctx.drawImage(pic, ox + rx * s, oy + ry * s, pic.width * s, pic.height * s);
    }

    /** Right-justified number, mirroring Sbar_DrawNum (white NUM_ or gold ANUM_). */
    private drawNum(ox: number, oy: number, x: number, y: number, value: number, digits: number, alt: boolean): void {
        let str = String(Math.max(0, Math.floor(value)));
        if (str.length > digits) str = str.slice(str.length - digits);
        let dx = x + (digits - str.length) * DIGIT_ADVANCE;
        const prefix = alt ? "ANUM_" : "NUM_";
        for (const ch of str) {
            this.blit(prefix + ch, dx, y, ox, oy);
            dx += DIGIT_ADVANCE;
        }
    }

    private faceName(health: number, pain: boolean): string {
        let idx: number;
        if (health >= 100) idx = 4;
        else if (health <= 0) idx = 0;
        else idx = Math.max(0, Math.min(4, Math.floor(health / 20)));
        return (pain ? "FACE_P" : "FACE") + (idx + 1);
    }

    private draw(): void {
        const { ctx, canvas } = this;
        const s = this.scale;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const ox = Math.floor((canvas.width - BAR_W * s) / 2);
        const sbarY = canvas.height - BAR_H * s;

        // --- Status bar ---
        // The inventory bar (IBAR) is intentionally not drawn: it stacked a second
        // 24px row above the sbar and hid the low-hanging weapon viewmodels (the
        // nailguns especially). The active weapon is already obvious from the held
        // viewmodel, so the weapon icons add little here.
        this.blit("SBAR", 0, 0, ox, sbarY, false);

        // Armor icon + count.
        const armor = Math.max(0, Math.round(this.stats.armor));
        if (armor > 0) {
            const icon = armor >= 200 ? "SB_ARMOR3" : armor >= 150 ? "SB_ARMOR2" : "SB_ARMOR1";
            this.blit(icon, 0, 0, ox, sbarY);
            this.drawNum(ox, sbarY, 24, 0, armor, 3, armor <= 25);
        }

        // Face (health bracket, pain frame briefly after taking damage).
        const health = Math.max(0, Math.ceil(this.stats.health));
        const pain = performance.now() < this.painUntil;
        this.blit(this.faceName(health, pain), 112, 0, ox, sbarY);

        // Health count.
        this.drawNum(ox, sbarY, 136, 0, health, 3, health <= 25);

        // Ammo icon + count for the active weapon.
        this.blit(this.stats.ammoIcon ?? "SB_SHELLS", 0, 0, ox + 224 * s, sbarY);
        this.drawNum(ox, sbarY, 248, 0, this.stats.ammo, 3, this.stats.ammo <= 10);

        // Kill counter is not part of the classic sbar; show it subtly above-left
        // so combat progress feedback is preserved.
        ctx.font = `${Math.round(7 * s)}px monospace`;
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(255,255,238,0.85)";
        ctx.shadowColor = "#000";
        ctx.shadowBlur = 4 * s;
        ctx.fillText(`KILLS ${this.stats.kills}/${this.stats.total}`, ox, sbarY - 12 * s);
        ctx.shadowBlur = 0;
    }
}
