/**
 * DOM HUD overlay for the platformer demo: score / coins / world / time / lives,
 * plus centred banner messages (Get Ready, Level Complete, Game Over). The engine
 * has no text/UI subsystem, so the HUD is plain DOM layered over the canvas — an
 * approach the demos explicitly permit.
 */

export interface HudModel {
    score: number;
    coins: number;
    lives: number;
    time: number;
    world: string;
}

export interface Hud {
    update: (m: HudModel) => void;
    /** Show a centred banner; pass null to clear it. */
    banner: (text: string | null, sub?: string) => void;
    dispose: () => void;
}

function cell(label: string, valueId: string): { wrap: HTMLElement; value: HTMLElement } {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:64px;";
    const l = document.createElement("span");
    l.textContent = label;
    l.style.cssText = "font:700 11px system-ui,sans-serif;letter-spacing:.12em;color:#ffd36b;text-shadow:0 1px 0 #000;";
    const v = document.createElement("span");
    v.id = valueId;
    v.style.cssText = "font:700 18px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;text-shadow:0 2px 0 #000;";
    wrap.appendChild(l);
    wrap.appendChild(v);
    return { wrap, value: v };
}

export function createHud(host: HTMLElement): Hud {
    const bar = document.createElement("div");
    bar.style.cssText =
        "position:absolute;top:0;left:0;right:0;display:flex;gap:22px;padding:12px 18px;z-index:20;" +
        "pointer-events:none;background:linear-gradient(to bottom,rgba(0,0,0,.35),rgba(0,0,0,0));";

    const score = cell("SCORE", "pf-score");
    const coins = cell("COINS", "pf-coins");
    const world = cell("WORLD", "pf-world");
    const time = cell("TIME", "pf-time");
    const lives = cell("LIVES", "pf-lives");
    bar.append(score.wrap, coins.wrap, world.wrap, time.wrap, lives.wrap);

    const bannerEl = document.createElement("div");
    bannerEl.style.cssText =
        "position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;" +
        "gap:8px;z-index:25;pointer-events:none;text-align:center;";
    const bannerMain = document.createElement("div");
    bannerMain.style.cssText = "font:800 40px system-ui,sans-serif;color:#fff;text-shadow:0 4px 0 #000,0 0 18px rgba(0,0,0,.6);";
    const bannerSub = document.createElement("div");
    bannerSub.style.cssText = "font:600 18px system-ui,sans-serif;color:#ffd36b;text-shadow:0 2px 0 #000;";
    bannerEl.append(bannerMain, bannerSub);

    host.append(bar, bannerEl);

    return {
        update(m: HudModel): void {
            score.value.textContent = m.score.toString().padStart(6, "0");
            coins.value.textContent = "\u00D7" + m.coins.toString().padStart(2, "0");
            world.value.textContent = m.world;
            time.value.textContent = Math.max(0, Math.ceil(m.time)).toString();
            lives.value.textContent = "\u00D7" + m.lives.toString();
        },
        banner(text: string | null, sub = ""): void {
            if (text === null) {
                bannerEl.style.display = "none";
                return;
            }
            bannerMain.textContent = text;
            bannerSub.textContent = sub;
            bannerEl.style.display = "flex";
        },
        dispose(): void {
            bar.remove();
            bannerEl.remove();
        },
    };
}
