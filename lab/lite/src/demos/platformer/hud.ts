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
    /** Show/hide the title (attract) screen; hides the score bar while visible. */
    title: (visible: boolean) => void;
    /** Show the boss health bar with `hp` of `maxHp` pips; `maxHp <= 0` hides it. */
    boss: (hp: number, maxHp: number) => void;
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

    // ── Title / attract screen ────────────────────────────────────────────────
    // Keyframes for the rainbow logo shimmer + the blinking "press start" prompt.
    const style = document.createElement("style");
    style.textContent =
        "@keyframes pf-shimmer{0%{background-position:0% 0}100%{background-position:200% 0}}" +
        "@keyframes pf-blink{0%,49%{opacity:1}50%,100%{opacity:.05}}" +
        "@keyframes pf-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}";
    document.head.appendChild(style);

    const titleEl = document.createElement("div");
    titleEl.style.cssText =
        "position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;" +
        "gap:10px;z-index:30;pointer-events:none;text-align:center;" +
        "background:radial-gradient(120% 80% at 50% 38%,rgba(0,0,0,0) 40%,rgba(0,0,0,.35) 100%);";
    const titleLogo = document.createElement("div");
    titleLogo.textContent = "COSMIC RUN";
    titleLogo.style.cssText =
        "font:900 clamp(40px,9vw,82px) system-ui,sans-serif;letter-spacing:.04em;line-height:1;" +
        "background:linear-gradient(90deg,#ff5d5d,#ffd95d,#7dff5d,#5dd0ff,#b15dff,#ff5d5d);background-size:200% 100%;" +
        "-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-stroke:2px rgba(0,0,0,.5);" +
        "filter:drop-shadow(0 6px 0 rgba(0,0,0,.45));animation:pf-shimmer 3s linear infinite,pf-bob 3.2s ease-in-out infinite;";
    const titlePrompt = document.createElement("div");
    titlePrompt.textContent = "PRESS SPACE \u00B7 TAP \u24B6";
    titlePrompt.style.cssText =
        "margin-top:28px;font:800 clamp(15px,2.6vw,24px) system-ui,sans-serif;color:#ffd36b;" +
        "text-shadow:0 2px 0 #000;animation:pf-blink 1.1s steps(1,end) infinite;";
    titleEl.append(titleLogo, titlePrompt);

    // ── Boss health bar (shown only during the castle boss fight) ─────────────
    const bossBar = document.createElement("div");
    bossBar.style.cssText =
        "position:absolute;top:64px;left:0;right:0;display:none;justify-content:center;align-items:center;gap:10px;" +
        "z-index:22;pointer-events:none;";
    const bossLabel = document.createElement("span");
    bossLabel.textContent = "BOSS";
    bossLabel.style.cssText = "font:800 13px system-ui,sans-serif;letter-spacing:.18em;color:#ff7d7d;text-shadow:0 2px 0 #000;";
    const bossPips = document.createElement("div");
    bossPips.style.cssText = "display:flex;gap:6px;";
    bossBar.append(bossLabel, bossPips);

    host.append(bar, bannerEl, titleEl, bossBar);

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
        title(visible: boolean): void {
            titleEl.style.display = visible ? "flex" : "none";
            bar.style.display = visible ? "none" : "flex";
        },
        boss(hp: number, maxHp: number): void {
            if (maxHp <= 0) {
                bossBar.style.display = "none";
                return;
            }
            bossPips.replaceChildren();
            for (let i = 0; i < maxHp; i++) {
                const pip = document.createElement("span");
                const lit = i < hp;
                pip.style.cssText =
                    "width:22px;height:22px;border-radius:5px;border:2px solid rgba(0,0,0,.55);" +
                    (lit ? "background:linear-gradient(#ff8a5d,#ff4d4d);box-shadow:0 0 8px rgba(255,90,70,.7);" : "background:rgba(40,40,48,.7);");
                bossPips.appendChild(pip);
            }
            bossBar.style.display = "flex";
        },
        dispose(): void {
            bar.remove();
            bannerEl.remove();
            titleEl.remove();
            bossBar.remove();
            style.remove();
        },
    };
}
