/**
 * Racer lap timing — detects the car crossing the start/finish line and the
 * checkpoints (by position), times each lap, and shows a small HUD with the
 * current / last / best lap. A lap only counts once every checkpoint has been
 * crossed since the previous finish, so the line can't be hopped.
 */

import type { TriggerZone } from "./track.js";

/** True when world point (x, z) is inside an axis-aligned zone. */
function inZone(x: number, z: number, zone: TriggerZone): boolean {
    return Math.abs(x - zone.cx) <= zone.sx / 2 && Math.abs(z - zone.cz) <= zone.sz / 2;
}

/** Format milliseconds as `M:SS.cc`, or an em-dash placeholder when there's no time yet. */
function formatTime(ms: number): string {
    if (!isFinite(ms)) {
        return "—:——.——";
    }
    const cs = Math.floor(ms / 10);
    const centis = cs % 100;
    const secs = Math.floor(cs / 100) % 60;
    const mins = Math.floor(cs / 6000);
    return `${mins}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/** Tracks lap progress from the car's position and renders the lap HUD. */
export class RaceTimer {
    private readonly _finish: TriggerZone;
    private readonly _checkpoints: readonly TriggerZone[];
    private readonly _cpHit: boolean[];
    private readonly _inCp: boolean[];
    private _inFinish = false;

    private _started = false;
    private _lapStart = 0;
    private _last = Infinity;
    private _best = Infinity;
    private _lap = 0;

    private readonly _lapEl: HTMLElement;
    private readonly _curEl: HTMLElement;
    private readonly _lastEl: HTMLElement;
    private readonly _bestEl: HTMLElement;

    constructor(finish: TriggerZone, checkpoints: readonly TriggerZone[]) {
        this._finish = finish;
        this._checkpoints = checkpoints;
        this._cpHit = checkpoints.map(() => false);
        this._inCp = checkpoints.map(() => false);
        const hud = this._buildHud();
        this._lapEl = hud.lap;
        this._curEl = hud.cur;
        this._lastEl = hud.last;
        this._bestEl = hud.best;
        this._render();
    }

    /** Start timing — called on GO when the countdown ends. */
    arm(nowMs: number): void {
        this._started = true;
        this._lapStart = nowMs;
        this._lap = 1;
        this._cpHit.fill(false);
        this._inFinish = false;
        this._render();
    }

    /** Advance one frame from the car's world position and the current time (ms). */
    update(x: number, z: number, nowMs: number): void {
        if (!this._started) {
            return; // held during the countdown
        }
        for (let i = 0; i < this._checkpoints.length; i++) {
            const inside = inZone(x, z, this._checkpoints[i]!);
            if (inside && !this._inCp[i]) {
                this._cpHit[i] = true;
            }
            this._inCp[i] = inside;
        }
        const inFin = inZone(x, z, this._finish);
        if (inFin && !this._inFinish && this._cpHit.every(Boolean)) {
            this._completeLap(nowMs);
        }
        this._inFinish = inFin;
        this._curEl.textContent = formatTime(nowMs - this._lapStart);
    }

    private _completeLap(nowMs: number): void {
        const t = nowMs - this._lapStart;
        this._last = t;
        this._best = Math.min(this._best, t);
        this._lap++;
        this._lapStart = nowMs;
        this._cpHit.fill(false);
        this._render();
    }

    private _render(): void {
        this._lapEl.textContent = this._started ? `LAP ${this._lap}` : "LAP —";
        this._lastEl.textContent = formatTime(this._last);
        this._bestEl.textContent = formatTime(this._best);
        if (!this._started) {
            this._curEl.textContent = formatTime(Infinity);
        }
    }

    private _buildHud(): { lap: HTMLElement; cur: HTMLElement; last: HTMLElement; best: HTMLElement } {
        const panel = document.createElement("div");
        panel.style.cssText =
            "position:fixed;top:12px;left:12px;z-index:10;padding:10px 14px;border-radius:10px;background:rgba(0,0,0,0.45);color:#fff;backdrop-filter:blur(3px);font:600 13px system-ui,sans-serif;min-width:132px;";
        const lap = document.createElement("div");
        lap.style.cssText = "font-size:15px;color:#ffd27f;margin-bottom:2px;";
        const cur = document.createElement("div");
        cur.style.cssText = "font-variant-numeric:tabular-nums;font-size:24px;line-height:1.1;";
        panel.append(lap, cur);

        const row = (label: string): HTMLElement => {
            const wrap = document.createElement("div");
            wrap.style.cssText = "display:flex;justify-content:space-between;gap:14px;opacity:0.85;font-size:12px;margin-top:3px;";
            const l = document.createElement("span");
            l.textContent = label;
            const v = document.createElement("span");
            v.style.cssText = "font-variant-numeric:tabular-nums;";
            wrap.append(l, v);
            panel.appendChild(wrap);
            return v;
        };
        const last = row("LAST");
        const best = row("BEST");

        document.body.appendChild(panel);
        return { lap, cur, last, best };
    }
}

/**
 * Play a 3‑2‑1‑GO! start countdown as a centred overlay, invoking `onGo` the moment "GO!"
 * appears. Each step pops in and fades; the overlay removes itself after GO.
 */
export function startCountdown(onGo: () => void): void {
    const el = document.createElement("div");
    el.style.cssText =
        "position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;pointer-events:none;font:800 120px system-ui,sans-serif;text-shadow:0 4px 24px rgba(0,0,0,0.55);";
    document.body.appendChild(el);
    const steps = ["3", "2", "1", "GO!"];
    let i = 0;
    const tick = (): void => {
        if (i >= steps.length) {
            el.remove();
            return;
        }
        const label = steps[i]!;
        el.textContent = label;
        el.style.color = label === "GO!" ? "#7cfc66" : "#fff";
        el.animate(
            [
                { transform: "scale(0.5)", opacity: 0 },
                { transform: "scale(1)", opacity: 1, offset: 0.35 },
                { transform: "scale(1.2)", opacity: 0 },
            ],
            { duration: 700, easing: "ease-out" }
        );
        if (label === "GO!") {
            onGo();
        }
        i++;
        setTimeout(tick, 700);
    };
    tick();
}
