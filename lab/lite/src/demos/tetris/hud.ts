/**
 * DOM HUD: score / level / lines display, next-piece preview, controls help,
 * pause + game-over overlays. Sits above the canvas as plain HTML so the
 * playfield never has to render text.
 */

import { previewCells, type GameState } from "./game.js";
import { PIECE_COLORS } from "./pieces.js";

const COLOR_RGB = (rgb: readonly [number, number, number]): string => `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;

export interface TetrisHud {
    render(game: GameState): void;
    /** Wire up restart-button click; runs `cb()` and clears the overlay. */
    onRestart(cb: () => void): void;
    /** Wire up the block-style toggle (button click). */
    onToggleMode(cb: () => void): void;
    /** Reflect the active block style on the toggle button label. */
    setMode(mode: "pets" | "arcade" | "smooth"): void;
    /** Wire up the sound mute toggle (button click). */
    onToggleMute(cb: () => void): void;
    /** Reflect the mute state on the sound button label. */
    setMuted(muted: boolean): void;
}

export function createTetrisHud(root: HTMLElement): TetrisHud {
    const wrap = document.createElement("div");
    wrap.style.cssText = [
        "position:fixed",
        "inset:0",
        "pointer-events:none",
        "z-index:20",
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "color:#f4ece9",
    ].join(";");

    const panel = document.createElement("div");
    panel.style.cssText = [
        "position:absolute",
        "top:16px",
        "right:16px",
        "min-width:180px",
        "padding:14px 16px",
        "background:rgba(10,12,20,0.75)",
        "border:1px solid rgba(255,255,255,0.08)",
        "border-radius:10px",
        "backdrop-filter:blur(8px)",
        "-webkit-backdrop-filter:blur(8px)",
        "font-variant-numeric:tabular-nums",
    ].join(";");
    wrap.appendChild(panel);

    const title = document.createElement("div");
    title.textContent = "TETRIS";
    title.style.cssText = "font-size:1.4rem;font-weight:700;letter-spacing:0.18em;margin-bottom:10px;color:#fff;";
    panel.appendChild(title);

    const stat = (label: string): { row: HTMLDivElement; val: HTMLSpanElement } => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;margin:4px 0;font-size:0.95rem;";
        const lab = document.createElement("span");
        lab.textContent = label;
        lab.style.color = "#9ba3b6";
        const val = document.createElement("span");
        val.textContent = "0";
        val.style.color = "#fff";
        val.style.fontWeight = "600";
        row.appendChild(lab);
        row.appendChild(val);
        panel.appendChild(row);
        return { row, val };
    };

    const score = stat("SCORE");
    const lines = stat("LINES");
    const level = stat("LEVEL");

    const previewLabel = document.createElement("div");
    previewLabel.textContent = "NEXT";
    previewLabel.style.cssText = "color:#9ba3b6;font-size:0.85rem;margin-top:12px;letter-spacing:0.1em;";
    panel.appendChild(previewLabel);

    const preview = document.createElement("div");
    preview.style.cssText = [
        "display:grid",
        "grid-template-columns:repeat(4,18px)",
        "grid-template-rows:repeat(4,18px)",
        "gap:2px",
        "margin-top:6px",
        "padding:6px",
        "background:rgba(0,0,0,0.25)",
        "border-radius:6px",
        "justify-content:center",
    ].join(";");
    panel.appendChild(preview);

    const previewCellsEls: HTMLDivElement[] = [];
    for (let i = 0; i < 16; i++) {
        const c = document.createElement("div");
        c.style.cssText = "width:18px;height:18px;border-radius:3px;background:rgba(255,255,255,0.04);";
        preview.appendChild(c);
        previewCellsEls.push(c);
    }

    // Block-style toggle: switch between cute Cube Pets and classic arcade cubes.
    const modeBtn = document.createElement("button");
    modeBtn.style.cssText = [
        "margin-top:14px",
        "width:100%",
        "padding:8px 10px",
        "font:600 0.8rem/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "letter-spacing:0.08em",
        "color:#f4ece9",
        "background:rgba(255,255,255,0.06)",
        "border:1px solid rgba(255,255,255,0.12)",
        "border-radius:8px",
        "cursor:pointer",
        "pointer-events:auto",
    ].join(";");
    panel.appendChild(modeBtn);

    // Sound mute toggle.
    const soundBtn = document.createElement("button");
    soundBtn.style.cssText = [
        "margin-top:8px",
        "width:100%",
        "padding:8px 10px",
        "font:600 0.8rem/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "letter-spacing:0.08em",
        "color:#f4ece9",
        "background:rgba(255,255,255,0.06)",
        "border:1px solid rgba(255,255,255,0.12)",
        "border-radius:8px",
        "cursor:pointer",
        "pointer-events:auto",
    ].join(";");
    panel.appendChild(soundBtn);

    const help = document.createElement("div");
    help.style.cssText = [
        "position:absolute",
        "left:16px",
        "bottom:16px",
        "padding:10px 14px",
        "background:rgba(10,12,20,0.7)",
        "border:1px solid rgba(255,255,255,0.06)",
        "border-radius:10px",
        "font-size:0.78rem",
        "line-height:1.5",
        "color:#cbd2e0",
    ].join(";");
    help.innerHTML = [
        "<div style='color:#fff;font-weight:600;margin-bottom:4px;letter-spacing:0.08em;'>CONTROLS</div>",
        "<div>← / → &nbsp;&nbsp; move</div>",
        "<div>↑ / X &nbsp;&nbsp; rotate CW</div>",
        "<div>Z &nbsp;&nbsp; rotate CCW</div>",
        "<div>↓ &nbsp;&nbsp; soft drop</div>",
        "<div>Space &nbsp;&nbsp; hard drop</div>",
        "<div>M &nbsp;&nbsp; pets / arcade / smooth</div>",
        "<div>S &nbsp;&nbsp; sound on / off</div>",
        "<div>P &nbsp;&nbsp; pause &nbsp;·&nbsp; R &nbsp;&nbsp; restart</div>",
    ].join("");
    wrap.appendChild(help);

    // Pause / game-over overlay.
    const overlay = document.createElement("div");
    overlay.style.cssText = [
        "position:absolute",
        "inset:0",
        "display:none",
        "align-items:center",
        "justify-content:center",
        "flex-direction:column",
        "gap:14px",
        "background:rgba(5,7,15,0.55)",
        "pointer-events:auto",
    ].join(";");
    const overlayTitle = document.createElement("div");
    overlayTitle.style.cssText = "font-size:3rem;font-weight:800;letter-spacing:0.25em;color:#fff;text-shadow:0 4px 24px rgba(0,0,0,0.6);";
    const overlaySub = document.createElement("div");
    overlaySub.style.cssText = "font-size:1rem;color:#cbd2e0;";
    const restartBtn = document.createElement("button");
    restartBtn.textContent = "RESTART";
    restartBtn.style.cssText = [
        "margin-top:8px",
        "padding:10px 22px",
        "font:600 0.95rem/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "letter-spacing:0.15em",
        "color:#0b0809",
        "background:#f4ece9",
        "border:none",
        "border-radius:8px",
        "cursor:pointer",
    ].join(";");
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlaySub);
    overlay.appendChild(restartBtn);
    wrap.appendChild(overlay);

    root.appendChild(wrap);

    let restartCb: (() => void) | null = null;
    restartBtn.addEventListener("click", () => {
        if (restartCb) {
            restartCb();
        }
    });

    let toggleModeCb: (() => void) | null = null;
    modeBtn.addEventListener("click", () => {
        if (toggleModeCb) {
            toggleModeCb();
        }
    });

    let toggleMuteCb: (() => void) | null = null;
    soundBtn.addEventListener("click", () => {
        if (toggleMuteCb) {
            toggleMuteCb();
        }
    });

    const MODE_LABEL: Record<"pets" | "arcade" | "smooth", string> = {
        pets: "STYLE: PETS",
        arcade: "STYLE: ARCADE",
        smooth: "STYLE: SMOOTH",
    };
    function setMode(mode: "pets" | "arcade" | "smooth"): void {
        modeBtn.textContent = MODE_LABEL[mode];
    }
    setMode("smooth");

    function setMuted(muted: boolean): void {
        soundBtn.textContent = muted ? "SOUND: OFF" : "SOUND: ON";
    }
    setMuted(false);

    let lastVersion = -1;
    let lastOver = false;
    let lastPaused = false;
    let lastNext: number = -1;

    function render(game: GameState): void {
        if (game.version === lastVersion && game.over === lastOver && game.paused === lastPaused) {
            return;
        }
        lastVersion = game.version;
        lastOver = game.over;
        lastPaused = game.paused;

        score.val.textContent = String(game.score);
        lines.val.textContent = String(game.lines);
        level.val.textContent = String(game.level);

        if (game.next !== lastNext) {
            lastNext = game.next;
            const color = COLOR_RGB(PIECE_COLORS[game.next]!);
            for (const c of previewCellsEls) {
                c.style.background = "rgba(255,255,255,0.04)";
            }
            for (const [dx, dy] of previewCells(game.next)) {
                const idx = dy * 4 + dx;
                const el = previewCellsEls[idx];
                if (el) {
                    el.style.background = color;
                    el.style.boxShadow = `0 0 10px ${color}55`;
                }
            }
        }

        if (game.over) {
            overlay.style.display = "flex";
            overlayTitle.textContent = "GAME OVER";
            overlaySub.textContent = `Final score: ${game.score}`;
        } else if (game.paused) {
            overlay.style.display = "flex";
            overlayTitle.textContent = "PAUSED";
            overlaySub.textContent = "Press P to resume";
            restartBtn.style.display = "none";
        } else {
            overlay.style.display = "none";
            restartBtn.style.display = "inline-block";
        }
    }

    function onRestart(cb: () => void): void {
        restartCb = cb;
    }

    function onToggleMode(cb: () => void): void {
        toggleModeCb = cb;
    }

    function onToggleMute(cb: () => void): void {
        toggleMuteCb = cb;
    }

    return { render, onRestart, onToggleMode, setMode, onToggleMute, setMuted };
}
