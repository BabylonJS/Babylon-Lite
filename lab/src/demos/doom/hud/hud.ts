// DOOM status-bar HUD rendered with DOM/CSS so it costs nothing in the WebGPU
// bundle and never touches the parity-tested engine. Styled to evoke the classic
// STBAR: a steel bar with large red counters, an ARMS panel, a face box, and the
// per-type ammo list, plus a center crosshair for aiming.

import type { Player } from "../player/player.js";
import { Weapon } from "../player/player.js";
import { Pickup } from "../mobj/info.js";

const RED = "#d21d12";
const STEEL = "#4f4f4f";
const STEEL_DARK = "#2c2c2c";

export class DoomHud {
    private readonly root: HTMLDivElement;
    private readonly crosshair: HTMLDivElement;
    private readonly messageEl: HTMLDivElement;
    private readonly painEl: HTMLDivElement;

    private readonly ammoBig: HTMLSpanElement;
    private readonly healthEl: HTMLSpanElement;
    private readonly armorEl: HTMLSpanElement;
    private readonly armsCells: HTMLSpanElement[] = [];
    private readonly ammoNow: HTMLSpanElement[] = [];
    private readonly ammoMax: HTMLSpanElement[] = [];
    private readonly keyDots: HTMLDivElement[] = [];
    private readonly faceEl: HTMLDivElement;

    constructor(private readonly player: Player) {
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

        // Status bar container, centered like the original 320-wide STBAR.
        // The status bar is centered with left:50% + translateX(-50%) so it stays
        // centered regardless of the host page's layout / horizontal overflow
        // (flex justify-content was being defeated by the demo page container).
        const root = document.createElement("div");
        root.style.cssText = [
            "position:fixed",
            "left:50%",
            "bottom:0",
            "transform:translateX(-50%)",
            "box-sizing:border-box",
            "display:flex",
            "align-items:stretch",
            "justify-content:center",
            "gap:6px",
            "width:100%",
            "max-width:860px",
            "padding:6px 10px",
            `background:linear-gradient(180deg,${STEEL} 0%,${STEEL_DARK} 100%)`,
            "border-top:2px solid #6b6b6b",
            "box-shadow:inset 0 2px 0 #7a7a7a, inset 0 -2px 0 #1a1a1a",
            "pointer-events:none",
            "z-index:50",
            "font-family:'Courier New',monospace",
        ].join(";");

        this.ammoBig = DoomHud.bigNumber();
        this.healthEl = DoomHud.bigNumber();
        this.armorEl = DoomHud.bigNumber();
        this.faceEl = DoomHud.makeFace();

        root.appendChild(DoomHud.panel("AMMO", this.ammoBig, ""));
        root.appendChild(DoomHud.panel("HEALTH", this.healthEl, "%"));
        root.appendChild(this.makeArms());
        root.appendChild(this.makeFacePanel());
        root.appendChild(DoomHud.panel("ARMOR", this.armorEl, "%"));
        root.appendChild(this.makeAmmoList());

        document.body.appendChild(pain);
        document.body.appendChild(cross);
        document.body.appendChild(message);
        document.body.appendChild(root);
        this.root = root;
    }

    private static bevel(): string {
        return "background:#1b1b1b;border:2px solid #111;box-shadow:inset 2px 2px 0 #000,inset -1px -1px 0 #333;border-radius:2px";
    }

    private static bigNumber(): HTMLSpanElement {
        const s = document.createElement("span");
        s.textContent = "0";
        s.style.cssText = `color:${RED};font-weight:bold;font-size:40px;line-height:1;text-shadow:0 0 6px rgba(210,29,18,.6),2px 2px 0 #000;font-variant-numeric:tabular-nums`;
        return s;
    }

    /** A labelled bezeled panel showing one big counter. */
    private static panel(label: string, value: HTMLElement, suffix: string): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:4px 8px;min-width:96px;" + DoomHud.bevel();
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:baseline";
        row.appendChild(value);
        if (suffix) {
            const suf = document.createElement("span");
            suf.textContent = suffix;
            suf.style.cssText = `color:${RED};font-weight:bold;font-size:20px;margin-left:2px;text-shadow:2px 2px 0 #000`;
            row.appendChild(suf);
        }
        const l = document.createElement("span");
        l.textContent = label;
        l.style.cssText = "font-size:11px;font-weight:bold;letter-spacing:2px;color:#c8a06a";
        wrap.appendChild(row);
        wrap.appendChild(l);
        return wrap;
    }

    /** ARMS panel: weapon slots 2-7, lit when owned. */
    private makeArms(): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px 8px;" + DoomHud.bevel();
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(3,18px);grid-auto-rows:16px;gap:1px 6px";
        for (let slot = 2; slot <= 7; slot++) {
            const cell = document.createElement("span");
            cell.textContent = String(slot);
            cell.style.cssText = "font-weight:bold;font-size:15px;text-align:center;line-height:16px";
            this.armsCells.push(cell);
            grid.appendChild(cell);
        }
        const l = document.createElement("span");
        l.textContent = "ARMS";
        l.style.cssText = "font-size:11px;font-weight:bold;letter-spacing:2px;color:#c8a06a";
        wrap.appendChild(grid);
        wrap.appendChild(l);
        return wrap;
    }

    private static makeFace(): HTMLDivElement {
        const face = document.createElement("div");
        face.style.cssText = "position:relative;width:34px;height:38px;background:#c89a6a;border-radius:4px 4px 6px 6px;transition:filter .15s linear";
        face.innerHTML =
            `<div style="position:absolute;top:0;left:0;right:0;height:9px;background:#6b3f25;border-radius:4px 4px 0 0"></div>` +
            `<div style="position:absolute;top:13px;left:7px;width:6px;height:6px;background:#fff;border-radius:50%"></div>` +
            `<div style="position:absolute;top:13px;right:7px;width:6px;height:6px;background:#fff;border-radius:50%"></div>` +
            `<div style="position:absolute;top:15px;left:9px;width:3px;height:3px;background:#000;border-radius:50%"></div>` +
            `<div style="position:absolute;top:15px;right:9px;width:3px;height:3px;background:#000;border-radius:50%"></div>` +
            `<div style="position:absolute;bottom:6px;left:10px;right:10px;height:3px;background:#7a3b2a;border-radius:2px"></div>`;
        return face;
    }

    private makeFacePanel(): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;justify-content:center;padding:4px 10px;" + DoomHud.bevel();
        const col = document.createElement("div");
        col.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px";
        col.appendChild(this.faceEl);
        const keys = document.createElement("div");
        keys.style.cssText = "display:flex;gap:4px;height:8px";
        for (const color of ["#2b6bff", "#ffd23b", "#ff3b3b"]) {
            const dot = document.createElement("div");
            dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${color};opacity:.15;box-shadow:0 0 2px #000`;
            this.keyDots.push(dot);
            keys.appendChild(dot);
        }
        col.appendChild(keys);
        wrap.appendChild(col);
        return wrap;
    }

    /** Per-type ammo counts (now/max) on the right. */
    private makeAmmoList(): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:grid;grid-template-columns:auto auto auto auto;align-items:center;gap:1px 6px;padding:4px 10px;" + DoomHud.bevel();
        // Display order: bullets, shells, rockets, cells. Player.ammo indices:
        // 0=bullets, 1=shells, 2=cells, 3=rockets.
        const rows: [string, number][] = [["BULL", 0], ["SHEL", 1], ["RCKT", 3], ["CELL", 2]];
        for (const [label, idx] of rows) {
            const l = document.createElement("span");
            l.textContent = label;
            l.style.cssText = "font-size:11px;font-weight:bold;color:#c8a06a";
            const now = document.createElement("span");
            now.style.cssText = `color:${RED};font-weight:bold;font-size:14px;text-align:right;font-variant-numeric:tabular-nums`;
            const slash = document.createElement("span");
            slash.textContent = "/";
            slash.style.cssText = "color:#8a8a8a;font-size:12px";
            const max = document.createElement("span");
            max.style.cssText = "color:#e0c080;font-weight:bold;font-size:14px;text-align:right;font-variant-numeric:tabular-nums";
            this.ammoNow[idx] = now;
            this.ammoMax[idx] = max;
            wrap.appendChild(l);
            wrap.appendChild(now);
            wrap.appendChild(slash);
            wrap.appendChild(max);
        }
        return wrap;
    }

    flashMessage(text: string): void {
        this.messageEl.textContent = text;
        this.messageEl.style.opacity = "1";
    }

    update(): void {
        const p = this.player;
        const ammo = p.currentAmmo();
        this.ammoBig.textContent = ammo < 0 ? "--" : String(ammo);
        this.healthEl.textContent = String(p.health);
        this.armorEl.textContent = String(p.armor);

        // ARMS: slot N (2..7) -> weapon index N-1.
        const armsWeapons = [Weapon.PISTOL, Weapon.SHOTGUN, Weapon.CHAINGUN, Weapon.ROCKET, Weapon.PLASMA, Weapon.BFG];
        for (let i = 0; i < this.armsCells.length; i++) {
            const owned = p.weaponsOwned.has(armsWeapons[i]);
            this.armsCells[i].style.color = owned ? RED : "#555";
            this.armsCells[i].style.textShadow = owned ? "1px 1px 0 #000" : "none";
        }

        for (let i = 0; i < 4; i++) {
            if (this.ammoNow[i]) this.ammoNow[i].textContent = String(p.ammo[i]);
            if (this.ammoMax[i]) this.ammoMax[i].textContent = String(p.maxAmmo[i]);
        }

        const hasBlue = p.keys.has(Pickup.KEY_BLUE) || p.keys.has(Pickup.KEY_BLUE_SKULL);
        const hasYellow = p.keys.has(Pickup.KEY_YELLOW) || p.keys.has(Pickup.KEY_YELLOW_SKULL);
        const hasRed = p.keys.has(Pickup.KEY_RED) || p.keys.has(Pickup.KEY_RED_SKULL);
        this.keyDots[0].style.opacity = hasBlue ? "1" : "0.15";
        this.keyDots[1].style.opacity = hasYellow ? "1" : "0.15";
        this.keyDots[2].style.opacity = hasRed ? "1" : "0.15";

        // Face reacts to state: dead, hurt, or healthy.
        this.faceEl.style.filter = p.health <= 0
            ? "grayscale(1) brightness(.5)"
            : p.painFlash > 0.2 ? "brightness(1.25) sepia(.5) hue-rotate(-20deg)" : "none";

        this.messageEl.style.opacity = p.messageTics > 0 ? "1" : "0";
        this.painEl.style.opacity = (p.painFlash * 0.4).toFixed(2);
    }

    dispose(): void {
        this.root.remove();
        this.crosshair.remove();
        this.messageEl.remove();
        this.painEl.remove();
    }
}
