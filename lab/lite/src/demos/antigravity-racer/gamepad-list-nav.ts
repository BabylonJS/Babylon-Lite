/**
 * Antigravity Racer — shared gamepad/keyboard "button list" navigation.
 *
 * Both the main menu and the pause overlay are a vertical list of focusable
 * `<button>` elements that should move focus on D-pad/arrow up-down and
 * "click" the focused button on gamepad A / Enter. This is extracted once so
 * neither copy can drift, and so both surfaces get the same fix for a subtle
 * edge case: `activate`/`deactivate` bracket the list's visible lifetime and
 * drop any pending confirm/menu-nav edges at both ends. Without that, a
 * gamepad A press latched while a *different* mode owned the input (e.g. held
 * down to accelerate while racing) would sit as a stale "confirm" and
 * instantly click the first focused item the moment this list reappears.
 */

import type { InputSystem } from "./input.js";

export interface ButtonListNav {
    /** Focus the first button and discard any stale nav edges. Call when the list becomes visible. */
    activate(input: InputSystem): void;
    /** Discard any stale nav edges. Call when the list is hidden. */
    deactivate(input: InputSystem): void;
    /** Move focus (D-pad/arrow up/down) and click the focused button (gamepad A / Enter). Call once per frame while visible. */
    poll(input: InputSystem): void;
}

export function createButtonListNav(buttons: readonly HTMLButtonElement[]): ButtonListNav {
    let focusIndex = 0;
    const managedIndex = (element: Element | null): number => buttons.indexOf(element as HTMLButtonElement);
    const focusButton = (i: number): void => {
        if (buttons.length === 0) {
            return;
        }
        focusIndex = ((i % buttons.length) + buttons.length) % buttons.length;
        buttons[focusIndex]?.focus();
    };
    buttons.forEach((button, index) => {
        button.addEventListener("focus", () => {
            focusIndex = index;
        });
        button.addEventListener("pointerdown", () => {
            focusIndex = index;
        });
    });
    return {
        activate(input): void {
            input.resetNavEdges();
            focusButton(0);
        },
        deactivate(input): void {
            input.resetNavEdges();
        },
        poll(input): void {
            const activeIndex = managedIndex(document.activeElement);
            if (activeIndex >= 0) {
                focusIndex = activeIndex;
            }
            if (input.consumeMenuDown()) {
                focusButton(focusIndex + 1);
            } else if (input.consumeMenuUp()) {
                focusButton(focusIndex - 1);
            }
            if (input.consumeConfirm()) {
                const activeButtonIndex = managedIndex(document.activeElement);
                if (activeButtonIndex >= 0) {
                    buttons[activeButtonIndex]?.click();
                }
            }
        },
    };
}
