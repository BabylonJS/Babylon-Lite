/**
 * Antigravity Racer — race HUD + pause overlay, and the track-editor toolbar (DOM/CSS).
 *
 * The pause overlay's Resume/Restart/Main Menu buttons reuse `ButtonListNav`
 * (see gamepad-list-nav.ts) for D-pad up/down + gamepad A navigation, exactly
 * like the main menu — while staying plain focusable `<button>`s so mouse,
 * touch, Tab, and Enter/Space keep working unchanged.
 */

import type { ShipState } from "./simulation.js";
import type { InputSystem } from "./input.js";
import { createButtonListNav, type ButtonListNav } from "./gamepad-list-nav.js";

export interface RaceHud {
    readonly root: HTMLElement;
    /** Update one player pane's readout. */
    updatePlayer(paneIndex: number, ship: ShipState): void;
    setControlsHint(text: string): void;
    showPause(input: InputSystem): void;
    hidePause(input: InputSystem): void;
    isPaused(): boolean;
    /** Move focus / activate the focused pause-overlay button from gamepad input. Call once per frame while paused. */
    pollGamepadNav(input: InputSystem): void;
    onResume(cb: () => void): void;
    onRestart(cb: () => void): void;
    onMainMenu(cb: () => void): void;
    dispose(): void;
}

/** `paneCount` is 1 for single-player/demo, 2 for split-screen (one HUD strip per pane). */
export function createRaceHud(paneCount: 1 | 2): RaceHud {
    const root = document.createElement("div");
    root.className = "ag-hud";
    const speedLabels: string[] = [];
    for (let i = 0; i <= 255; i++) {
        speedLabels.push(String(i));
    }
    const panes: { speed: HTMLElement; value: number }[] = [];
    for (let i = 0; i < paneCount; i++) {
        const pane = document.createElement("div");
        pane.className = "ag-hud-pane";
        pane.style.left = paneCount === 2 ? `${i * 50}%` : "0";
        pane.style.width = paneCount === 2 ? "50%" : "100%";
        pane.innerHTML = `
            <div class="ag-hud-panel">
                <div class="ag-hud-speed"><span class="ag-hud-speed-val">0</span><span class="ag-hud-speed-unit">u/s</span></div>
            </div>
        `;
        root.appendChild(pane);
        panes.push({ speed: pane.querySelector(".ag-hud-speed-val")!, value: 0 });
    }

    const hint = document.createElement("div");
    hint.className = "ag-hud-hint";
    root.appendChild(hint);

    const pauseOverlay = document.createElement("div");
    pauseOverlay.className = "ag-overlay";
    pauseOverlay.style.display = "none";
    pauseOverlay.innerHTML = `
        <div class="ag-overlay-panel">
            <h2>PAUSED</h2>
            <div class="ag-menu-buttons">
                <button type="button" class="ag-btn ag-btn-primary" data-action="resume">▶ Resume</button>
                <button type="button" class="ag-btn" data-action="restart">↺ Restart</button>
                <button type="button" class="ag-btn" data-action="menu">🏠 Main Menu</button>
            </div>
            <div class="ag-menu-hint">Esc / Start to resume</div>
        </div>
    `;
    root.appendChild(pauseOverlay);
    document.body.appendChild(root);

    let resumeCb: (() => void) | null = null;
    let restartCb: (() => void) | null = null;
    let menuCb: (() => void) | null = null;
    pauseOverlay.querySelector('[data-action="resume"]')?.addEventListener("click", () => resumeCb?.());
    pauseOverlay.querySelector('[data-action="restart"]')?.addEventListener("click", () => restartCb?.());
    pauseOverlay.querySelector('[data-action="menu"]')?.addEventListener("click", () => menuCb?.());

    const pauseButtons = Array.from(pauseOverlay.querySelectorAll<HTMLButtonElement>(".ag-btn"));
    const pauseNav: ButtonListNav = createButtonListNav(pauseButtons);

    let paused = false;

    return {
        root,
        updatePlayer(paneIndex, ship): void {
            const pane = panes[paneIndex];
            if (!pane) {
                return;
            }
            // `velocity` is per 60 Hz tick, so ×60 reads as world units per second.
            const speed = Math.min(255, Math.round(Math.abs(ship.velocity) * 60));
            if (speed !== pane.value) {
                pane.speed.textContent = speedLabels[speed]!;
                pane.value = speed;
            }
        },
        setControlsHint(text: string): void {
            hint.textContent = text;
        },
        showPause(input): void {
            paused = true;
            pauseOverlay.style.display = "flex";
            pauseNav.activate(input);
        },
        hidePause(input): void {
            paused = false;
            pauseOverlay.style.display = "none";
            pauseNav.deactivate(input);
        },
        isPaused(): boolean {
            return paused;
        },
        pollGamepadNav(input): void {
            pauseNav.poll(input);
        },
        onResume(cb): void {
            resumeCb = cb;
        },
        onRestart(cb): void {
            restartCb = cb;
        },
        onMainMenu(cb): void {
            menuCb = cb;
        },
        dispose(): void {
            root.remove();
        },
    };
}

export interface EditorHud {
    readonly root: HTMLElement;
    setSelectedLabel(text: string): void;
    onTest(cb: () => void): void;
    onBackToMenu(cb: () => void): void;
    onResetTrack(cb: () => void): void;
    dispose(): void;
}

export function createEditorHud(): EditorHud {
    const root = document.createElement("div");
    root.className = "ag-editor-hud";
    root.innerHTML = `
        <div class="ag-editor-panel">
            <div class="ag-editor-title">TRACK EDITOR</div>
            <div class="ag-editor-selected" id="ag-editor-selected">No point selected</div>
            <div class="ag-editor-hint">Click + drag a marker to reshape the track · Tab / D-pad to cycle · Arrow keys/right stick nudge</div>
            <div class="ag-menu-buttons ag-editor-buttons">
                <button type="button" class="ag-btn ag-btn-primary" data-action="test">▶ Test Track</button>
                <button type="button" class="ag-btn" data-action="reset">↺ Reset Shape</button>
                <button type="button" class="ag-btn" data-action="menu">🏠 Main Menu</button>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    const selectedLabel = root.querySelector<HTMLElement>("#ag-editor-selected")!;
    let testCb: (() => void) | null = null;
    let menuCb: (() => void) | null = null;
    let resetCb: (() => void) | null = null;
    root.querySelector('[data-action="test"]')?.addEventListener("click", () => testCb?.());
    root.querySelector('[data-action="menu"]')?.addEventListener("click", () => menuCb?.());
    root.querySelector('[data-action="reset"]')?.addEventListener("click", () => resetCb?.());

    return {
        root,
        setSelectedLabel(text: string): void {
            selectedLabel.textContent = text;
        },
        onTest(cb): void {
            testCb = cb;
        },
        onBackToMenu(cb): void {
            menuCb = cb;
        },
        onResetTrack(cb): void {
            resetCb = cb;
        },
        dispose(): void {
            root.remove();
        },
    };
}
