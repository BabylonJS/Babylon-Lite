// DOOM status bar rendered from the real WAD STBAR graphics.
//
// The classic status bar (STBAR) and all of its widgets — the big red counters,
// the ARMS panel, the animated face, the keys and the per-type ammo list — are
// decoded straight from the IWAD's UI lumps and blitted onto a 2D canvas overlay
// (palette 0, nearest sampling), exactly like the weapon view. This keeps it out
// of the WebGPU bundle and away from the parity-tested engine while looking
// pixel-faithful. Widget coordinates come from public DOOM documentation
// (st_stuff.c layout constants); no GPL Doom source is used.
//
// A handful of feedback effects that have no STBAR equivalent — the full-screen
// pain/pickup tint, the pickup message line, a center crosshair (our addition,
// since DOOM has none) and the death prompt — stay as lightweight DOM overlays.

import type { Wad } from "../wad/wad-file.js";
import { findLumpIndex, getLump } from "../wad/wad-file.js";
import { decodePatch } from "../wad/graphics.js";
import { parsePlaypal } from "../wad/palette.js";
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

/** A decoded UI patch ready to blit: its pixel canvas plus pivot offsets. */
interface DecodedPatch {
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    leftOffset: number;
    topOffset: number;
}

export class DoomHud {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly palette: Uint8Array;
    private readonly cache = new Map<string, DecodedPatch | null>();

    private readonly crosshair: HTMLDivElement;
    private readonly messageEl: HTMLDivElement;
    private readonly painEl: HTMLDivElement;
    private readonly deathEl: HTMLDivElement;

    /** Advance widths (px) for the tall (STTNUM) and small (STYSNUM) digit fonts. */
    private readonly tallW: number;
    private readonly shortW: number;
    private faceTime = 0;

    constructor(private readonly wad: Wad, private readonly player: Player) {
        this.palette = parsePlaypal(wad); // palette 0 used (full-bright UI)

        // Red damage / pickup full-screen tint.
        const pain = document.createElement("div");
        pain.style.cssText = "position:fixed;inset:0;pointer-events:none;background:#ff0000;opacity:0;transition:opacity .1s linear;z-index:48";
        this.painEl = pain;

        // Pickup / status message line.
        const message = document.createElement("div");
        message.style.cssText = "position:fixed;left:12px;top:10px;color:#e8e8b0;font:bold 18px 'Courier New',monospace;text-shadow:2px 2px 0 #000;opacity:0;transition:opacity .3s linear;z-index:51";
        this.messageEl = message;

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

        // Status-bar canvas, drawn above the weapon overlay (z-index 47).
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;image-rendering:pixelated";
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d")!;

        document.body.appendChild(pain);
        document.body.appendChild(cross);
        document.body.appendChild(death);
        document.body.appendChild(message);
        document.body.appendChild(canvas);

        this.tallW = this.decode("STTNUM0")?.width ?? 14;
        this.shortW = this.decode("STYSNUM0")?.width ?? 4;
    }

    /** Decodes a UI lump to a pixel canvas (palette 0, full-bright). Cached. */
    private decode(name: string): DecodedPatch | null {
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
        const dec: DecodedPatch = { canvas: c, width: img.width, height: img.height, leftOffset: img.leftOffset, topOffset: img.topOffset };
        this.cache.set(name, dec);
        return dec;
    }

    /** Blits one patch at virtual (vx,vy), honoring its pivot offsets. */
    private drawPatch(name: string, vx: number, vy: number, scale: number, frameLeft: number): void {
        const p = this.decode(name);
        if (!p) return;
        const dx = frameLeft + (vx - p.leftOffset) * scale;
        const dy = (vy - p.topOffset) * scale;
        this.ctx.drawImage(p.canvas, dx, dy, p.width * scale, p.height * scale);
    }

    /**
     * Draws an integer right-justified so its rightmost edge sits at virtual `rightX`.
     * `prefix` (e.g. "STTNUM"/"STYSNUM") + digit picks the font lump.
     */
    private drawNum(value: number, rightX: number, y: number, prefix: string, advance: number, maxDigits: number, scale: number, frameLeft: number): void {
        let v = Math.max(0, Math.floor(value));
        let x = rightX;
        let n = 0;
        do {
            x -= advance;
            this.drawPatch(`${prefix}${v % 10}`, x, y, scale, frameLeft);
            v = Math.floor(v / 10);
            n++;
        } while (v > 0 && n < maxDigits);
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
        this.messageEl.textContent = text;
        this.messageEl.style.opacity = "1";
    }

    update(dt: number): void {
        this.faceTime += dt;
        this.resize();
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.imageSmoothingEnabled = false;

        const p = this.player;
        const scale = this.canvas.height / FRAME_H;
        const frameLeft = (this.canvas.width - FRAME_W * scale) / 2;

        // Background bar + the ARMS panel overlay.
        this.drawPatch("STBAR", 0, BAR_Y, scale, frameLeft);
        this.drawPatch("STARMS", 104, BAR_Y, scale, frameLeft);

        // Ready-weapon ammo (tall, right-justified). Skip for ammo-less weapons.
        const ready = p.currentAmmo();
        if (ready >= 0) this.drawNum(ready, 44, 171, "STTNUM", this.tallW, 3, scale, frameLeft);

        // Health + armor percentages (tall number then a '%').
        this.drawNum(p.health, 90, 171, "STTNUM", this.tallW, 3, scale, frameLeft);
        this.drawPatch("STTPRCNT", 90, 171, scale, frameLeft);
        this.drawNum(p.armor, 221, 171, "STTNUM", this.tallW, 3, scale, frameLeft);
        this.drawPatch("STTPRCNT", 221, 171, scale, frameLeft);

        // ARMS: light owned slots with the yellow digit over the baked-in grey.
        for (let i = 0; i < ARMS_WEAPONS.length; i++) {
            if (!p.weaponsOwned.has(ARMS_WEAPONS[i]!)) continue;
            const x = 111 + (i % 3) * 12;
            const ry = 172 + Math.floor(i / 3) * 10;
            this.drawPatch(`STYSNUM${i + 2}`, x, ry, scale, frameLeft);
        }

        // Face.
        this.drawPatch(this.faceLump(), 143, BAR_Y, scale, frameLeft);

        // Keys: combined card+skull icon if both are held.
        for (let c = 0; c < KEY_ROWS.length; c++) {
            const [card, skull, ky] = KEY_ROWS[c]!;
            const hasCard = p.keys.has(card);
            const hasSkull = p.keys.has(skull);
            let lump: string | null = null;
            if (hasCard && hasSkull) lump = `STKEYS${c + 6}`;
            else if (hasSkull) lump = `STKEYS${c + 3}`;
            else if (hasCard) lump = `STKEYS${c}`;
            if (lump) this.drawPatch(lump, 239, ky, scale, frameLeft);
        }

        // Per-type ammo list: current (right edge 288) and max (right edge 314).
        for (const [idx, ay] of AMMO_ROWS) {
            this.drawNum(p.ammo[idx]!, 288, ay, "STYSNUM", this.shortW, 3, scale, frameLeft);
            this.drawNum(p.maxAmmo[idx]!, 314, ay, "STYSNUM", this.shortW, 3, scale, frameLeft);
        }

        // DOM feedback overlays.
        this.messageEl.style.opacity = p.messageTics > 0 ? "1" : "0";
        this.painEl.style.opacity = (p.painFlash * 0.4).toFixed(2);
        this.deathEl.style.opacity = p.dead ? "1" : "0";
        this.crosshair.style.opacity = p.dead ? "0" : ".85";
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
        this.crosshair.remove();
        this.deathEl.remove();
        this.messageEl.remove();
        this.painEl.remove();
    }
}
