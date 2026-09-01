/**
 * Antigravity Racer — main menu (DOM/CSS).
 *
 * Plain focusable `<button>` elements — Tab/Shift+Tab and Enter/Space already
 * work natively. `pollGamepadNav` additionally lets a gamepad move focus
 * (D-pad up/down) and "click" the focused button (gamepad A / Enter), so the
 * menu is fully keyboard- AND gamepad-navigable.
 */

import type { InputSystem } from "./input.js";
import { createButtonListNav, type ButtonListNav } from "./gamepad-list-nav.js";

export interface MainMenuHandlers {
    onTestTrack(): void;
    onRace1P(): void;
    onRace2P(): void;
    onDemo(): void;
    onEditor(): void;
}

export interface MainMenu {
    readonly root: HTMLElement;
    show(input: InputSystem): void;
    hide(input: InputSystem): void;
    /** Whether the menu is currently shown. Callers should only poll gamepad nav while true. */
    isVisible(): boolean;
    /** Move focus / activate the focused item from gamepad input. Call once per frame while shown. */
    pollGamepadNav(input: InputSystem): void;
    dispose(): void;
}

/** Attribution for the third-party art the demo ships. */
const CREDIT_HTML =
    'Native Babylon Lite port of Cédric Guillemet&rsquo;s antigravity racing playground (WVPVWL). Track textures by <a href="https://github.com/PatrickRyanMS" target="_blank" rel="noopener">Patrick Ryan</a>, used with his permission &mdash; he owns the rights to the road artwork and granted this demo the right to redistribute it. Ship &ldquo;RHS-X&rdquo; by <a href="https://sketchfab.com/alone5" target="_blank" rel="noopener">Hassan Bassassi</a>, rock &ldquo;Obj_Nat_Rock_01&rdquo; by <a href="https://sketchfab.com/SaschaHenrichs" target="_blank" rel="noopener">SaschaHenrichs</a> — both <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. The terrain height map and ground texture are loaded from playground.babylonjs.com at runtime.';

export function createMainMenu(handlers: MainMenuHandlers): MainMenu {
    const root = document.createElement("div");
    root.className = "ag-menu";
    root.innerHTML = `
        <div class="ag-menu-panel">
            <div class="ag-menu-kicker">BABYLON LITE DEMO</div>
            <h1 class="ag-menu-title">ANTIGRAVITY<span>RACER</span></h1>
            <p class="ag-menu-tagline">Bank through a floating loop track. Boost off the energy strips. Beat the field.</p>
            <div class="ag-menu-buttons">
                <button type="button" class="ag-btn ag-btn-primary" data-action="race1p">🏁 Race (1 Player)</button>
                <button type="button" class="ag-btn" data-action="race2p">🎮 Split-Screen (2 Players)</button>
                <button type="button" class="ag-btn" data-action="test">🛠 Test Track (no opponents)</button>
                <button type="button" class="ag-btn" data-action="demo">📺 Attract Mode</button>
                <button type="button" class="ag-btn" data-action="editor">✏️ Track Editor</button>
            </div>
            <div class="ag-menu-hint" id="ag-menu-hint">Keyboard: <b>WASD</b>/<b>ZQSD</b> + arrows · Gamepad supported</div>
            <div class="ag-menu-credit"></div>
        </div>
    `;
    // Set separately from a plain quoted string: the demo bundler's WGSL template-literal
    // minifier treats `//` inside a BACKTICK template as a comment start and would eat the
    // rest of the line (including every href). Quoted strings are skipped untouched.
    root.querySelector(".ag-menu-credit")!.innerHTML = CREDIT_HTML;
    document.body.appendChild(root);

    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".ag-btn"));
    const actions: Record<string, () => void> = {
        race1p: handlers.onRace1P,
        race2p: handlers.onRace2P,
        test: handlers.onTestTrack,
        demo: handlers.onDemo,
        editor: handlers.onEditor,
    };
    for (const btn of buttons) {
        btn.addEventListener("click", () => {
            const action = btn.dataset.action;
            if (action && actions[action]) {
                actions[action]!();
            }
        });
    }

    const listNav: ButtonListNav = createButtonListNav(buttons);

    let visible = false;

    function show(input: InputSystem): void {
        visible = true;
        root.style.display = "flex";
        listNav.activate(input);
        const hint = root.querySelector<HTMLElement>("#ag-menu-hint");
        if (hint) {
            hint.textContent = "Keyboard: WASD/ZQSD + arrows · Enter to select · Gamepad: D-pad + A";
        }
    }
    function hide(input: InputSystem): void {
        visible = false;
        root.style.display = "none";
        listNav.deactivate(input);
    }
    function isVisible(): boolean {
        return visible;
    }

    function pollGamepadNav(input: InputSystem): void {
        listNav.poll(input);
    }

    function dispose(): void {
        root.remove();
    }

    return { root, show, hide, isVisible, pollGamepadNav, dispose };
}
