/**
 * Antigravity Racer — input: keyboard (layout-independent) + gamepad, per player.
 *
 * Keyboard uses `KeyboardEvent.code` (physical key position) for WASD/arrows, so
 * it works identically on QWERTY and AZERTY without special-casing — an AZERTY
 * user's physical Z/Q/S/D keys (in the same location as QWERTY's W/A/S/D) already
 * report `KeyW`/`KeyA`/`KeyS`/`KeyD`. `event.key` (the logical/label value) is
 * ADDITIONALLY checked for 'z'/'q' so the familiar French labels work even if a
 * browser ever reports something unexpected for `.code`.
 *
 * Gamepads are polled once per frame (`poll()`), not event-driven — required for
 * analog stick reads — with edge-detected buttons for pause/camera/confirm/cancel
 * and a small deadzone on the steering axis. Key/button state is fully cleared on
 * window blur or tab hide so nothing "sticks" when focus is lost mid-press.
 */

import type { ShipControls } from "./simulation.js";

const P1_LEFT_CODES = new Set(["KeyA"]);
const P1_RIGHT_CODES = new Set(["KeyD"]);
const P1_ACCEL_CODES = new Set(["KeyW"]);
const P1_LEFT_KEYS = new Set(["q"]); // French AZERTY label fallback
const P1_ACCEL_KEYS = new Set(["z"]); // French AZERTY label fallback
const P1_CAMERA_CODES = new Set(["KeyC"]);

const P2_LEFT_CODES = new Set(["ArrowLeft"]);
const P2_RIGHT_CODES = new Set(["ArrowRight"]);
const P2_ACCEL_CODES = new Set(["ArrowUp"]);
const P2_CAMERA_CODES = new Set(["ShiftRight", "ControlRight"]);

const PAUSE_CODES = new Set(["Escape"]);
const CONFIRM_CODES = new Set(["Enter", "Space"]);

const GAMEPAD_DEADZONE = 0.18;
/** Analog steering past this (post-deadzone) magnitude counts as the matching digital direction.
 *  The simulation's steering is binary (the playground's key map), so an analog stick expresses
 *  INTENT here rather than changing the physics. */
const GAMEPAD_STEER_THRESHOLD = 0.35;
// Standard gamepad mapping button/axis indices.
const BTN_A = 0;
const BTN_B = 1;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_RT = 7;
const BTN_START = 9;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const AXIS_RSTICK_X = 2;
const AXIS_RSTICK_Y = 3;

/** Deadzone-clamp then rescale so the deadzone doesn't clip the usable analog range. */
function applyDeadzone(raw: number, deadzone: number): number {
    if (Math.abs(raw) < deadzone) {
        return 0;
    }
    return Math.sign(raw) * ((Math.abs(raw) - deadzone) / (1 - deadzone));
}

export interface InputSystem {
    /** Re-sample connected gamepads. Call once per rendered frame before reading axes/edges. */
    poll(): void;
    /** Binary steering/accelerate intent for a player slot, merging keyboard and gamepad. */
    getControls(playerSlot: 0 | 1): ShipControls;
    /** True once on the frame pause was newly pressed (Escape, or gamepad Start on either pad). */
    consumePauseToggle(): boolean;
    /** True once when the given player's camera-cycle control was newly pressed. */
    consumeCameraToggle(playerSlot: 0 | 1): boolean;
    /** True once when a menu "confirm" control was newly pressed (Enter/Space, or gamepad A on any pad). */
    consumeConfirm(): boolean;
    /** True once when a menu "cancel/back" control was newly pressed (Escape, or gamepad B on any pad). */
    consumeCancel(): boolean;
    /** True once when D-pad/arrow up was newly pressed, for menu list navigation. */
    consumeMenuUp(): boolean;
    /** True once when D-pad/arrow down was newly pressed, for menu list navigation. */
    consumeMenuDown(): boolean;
    /**
     * True once when gamepad D-pad up was newly pressed. Gamepad-only — unlike
     * `consumeMenuUp` this ignores the keyboard Up arrow, so it's safe to use for
     * track-editor point cycling without also firing on every ArrowUp keystroke
     * used there for continuous nudging.
     */
    consumeDpadUp(): boolean;
    /** True once when gamepad D-pad down was newly pressed. Gamepad-only, see `consumeDpadUp`. */
    consumeDpadDown(): boolean;
    /**
     * Clears any pending confirm/cancel/menu-up/menu-down/D-pad-cycle edges.
     * Call whenever a UI list (main menu, pause overlay) or the track editor
     * becomes active or inactive, so a stale press latched while a different
     * mode owned the input (e.g. gamepad A held down to accelerate while
     * racing) can never fire an unrelated action the instant that surface
     * appears or disappears.
     */
    resetNavEdges(): void;
    /**
     * Right-stick axes for the given pad slot, deadzone-applied and clamped to
     * [-1, 1]. `{x: 0, y: 0}` if no pad is connected in that slot or the pad
     * reports fewer than 4 axes. Intended for track-editor point nudging.
     */
    getRightStick(playerSlot: 0 | 1): { x: number; y: number };
    /** Whether any gamepad is currently connected (for contextual control hints). */
    hasGamepad(): boolean;
    dispose(): void;
}

export function createInputSystem(): InputSystem {
    const keysDown = new Set<string>();
    const logicalKeysDown = new Set<string>();
    let pauseEdge = false;
    let confirmEdge = false;
    let cancelEdge = false;
    let menuUpEdge = false;
    let menuDownEdge = false;
    let dpadUpEdge = false;
    let dpadDownEdge = false;
    const cameraEdge: [boolean, boolean] = [false, false];
    let gamepadConnected = false;
    const sampledPads: (Gamepad | null)[] = [null, null];
    const previousButtons = [new Uint8Array(32), new Uint8Array(32)];
    const noPads: readonly (Gamepad | null)[] = [];

    const onKeyDown = (e: KeyboardEvent): void => {
        const wasDown = keysDown.has(e.code);
        keysDown.add(e.code);
        logicalKeysDown.add(e.key.toLowerCase());
        if (!wasDown) {
            if (PAUSE_CODES.has(e.code)) {
                pauseEdge = true;
                cancelEdge = true;
            }
            if (CONFIRM_CODES.has(e.code)) {
                confirmEdge = true;
            }
            if (P1_CAMERA_CODES.has(e.code)) {
                cameraEdge[0] = true;
            }
            if (P2_CAMERA_CODES.has(e.code)) {
                cameraEdge[1] = true;
            }
            if (e.code === "ArrowUp") {
                menuUpEdge = true;
            }
            if (e.code === "ArrowDown") {
                menuDownEdge = true;
            }
        }
        // Prevent the page from scrolling on arrows/space while playing.
        if (e.code.startsWith("Arrow") || e.code === "Space") {
            e.preventDefault();
        }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        keysDown.delete(e.code);
        logicalKeysDown.delete(e.key.toLowerCase());
    };
    const clearAll = (): void => {
        keysDown.clear();
        logicalKeysDown.clear();
    };
    const onGamepadConnected = (): void => {
        gamepadConnected = true;
    };
    const onGamepadDisconnected = (e: GamepadEvent): void => {
        if (e.gamepad.index < sampledPads.length) {
            sampledPads[e.gamepad.index] = null;
            previousButtons[e.gamepad.index]!.fill(0);
        }
    };
    const onVisibilityChange = (): void => {
        if (document.hidden) {
            clearAll();
        }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearAll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("gamepadconnected", onGamepadConnected);
    window.addEventListener("gamepaddisconnected", onGamepadDisconnected);

    function poll(): void {
        const pads = navigator.getGamepads?.() ?? noPads;
        let anyConnected = false;
        sampledPads[0] = pads[0] ?? null;
        sampledPads[1] = pads[1] ?? null;
        for (let padIndex = 0; padIndex < sampledPads.length; padIndex++) {
            const pad = sampledPads[padIndex];
            if (!pad) {
                continue;
            }
            anyConnected = true;
            const playerSlot: 0 | 1 = pad.index === 0 ? 0 : 1;
            const prev = previousButtons[playerSlot]!;
            const buttonCount = Math.min(pad.buttons.length, prev.length);
            for (let b = 0; b < buttonCount; b++) {
                const pressed = pad.buttons[b]!.pressed;
                const was = prev[b] !== 0;
                if (pressed && !was) {
                    if (b === BTN_START) {
                        pauseEdge = true;
                    }
                    if (b === BTN_A) {
                        confirmEdge = true;
                    }
                    if (b === BTN_B) {
                        cancelEdge = true;
                    }
                    if (b === BTN_LB || b === BTN_RB) {
                        cameraEdge[playerSlot] = true;
                    }
                    if (b === DPAD_UP) {
                        menuUpEdge = true;
                        dpadUpEdge = true;
                    }
                    if (b === DPAD_DOWN) {
                        menuDownEdge = true;
                        dpadDownEdge = true;
                    }
                }
                prev[b] = pressed ? 1 : 0;
            }
        }
        gamepadConnected = anyConnected;
    }

    // Reusable per-slot control objects to avoid per-tick allocations.
    const _kbControls: [ShipControls, ShipControls] = [
        { left: false, right: false, accelerate: false },
        { left: false, right: false, accelerate: false },
    ];
    const _gpControls: [ShipControls, ShipControls] = [
        { left: false, right: false, accelerate: false },
        { left: false, right: false, accelerate: false },
    ];
    const _rightSticks: [{ x: number; y: number }, { x: number; y: number }] = [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
    ];

    function readKeyboardControls(
        playerSlot: 0 | 1,
        leftCodes: Set<string>,
        rightCodes: Set<string>,
        accelCodes: Set<string>,
        leftKeys?: Set<string>,
        accelKeys?: Set<string>
    ): ShipControls {
        const out = _kbControls[playerSlot];
        out.left = isAnyDown(leftCodes) || (!!leftKeys && isAnyLogicalDown(leftKeys));
        out.right = isAnyDown(rightCodes);
        out.accelerate = isAnyDown(accelCodes) || (!!accelKeys && isAnyLogicalDown(accelKeys));
        return out;
    }
    function isAnyDown(codes: Set<string>): boolean {
        for (const c of codes) {
            if (keysDown.has(c)) {
                return true;
            }
        }
        return false;
    }
    function isAnyLogicalDown(keys: Set<string>): boolean {
        for (const k of keys) {
            if (logicalKeysDown.has(k)) {
                return true;
            }
        }
        return false;
    }

    function gamepadControlsFor(playerSlot: 0 | 1): ShipControls | null {
        const pad = sampledPads[playerSlot];
        if (!pad) {
            return null;
        }
        const analog = applyDeadzone(pad.axes[0] ?? 0, GAMEPAD_DEADZONE);
        const out = _gpControls[playerSlot];
        out.left = !!pad.buttons[DPAD_LEFT]?.pressed || analog <= -GAMEPAD_STEER_THRESHOLD;
        out.right = !!pad.buttons[DPAD_RIGHT]?.pressed || analog >= GAMEPAD_STEER_THRESHOLD;
        out.accelerate = !!(pad.buttons[BTN_RT]?.pressed || pad.buttons[BTN_A]?.pressed);
        return out;
    }

    function getRightStick(playerSlot: 0 | 1): { x: number; y: number } {
        const out = _rightSticks[playerSlot];
        const pad = sampledPads[playerSlot];
        if (!pad || pad.axes.length <= AXIS_RSTICK_Y) {
            out.x = 0;
            out.y = 0;
            return out;
        }
        const x = applyDeadzone(pad.axes[AXIS_RSTICK_X] ?? 0, GAMEPAD_DEADZONE);
        const y = applyDeadzone(pad.axes[AXIS_RSTICK_Y] ?? 0, GAMEPAD_DEADZONE);
        out.x = Math.max(-1, Math.min(1, x));
        out.y = Math.max(-1, Math.min(1, y));
        return out;
    }

    function getControls(playerSlot: 0 | 1): ShipControls {
        const gp = gamepadControlsFor(playerSlot);
        if (gp && (gp.left || gp.right || gp.accelerate)) {
            return gp;
        }
        if (playerSlot === 0) {
            return readKeyboardControls(0, P1_LEFT_CODES, P1_RIGHT_CODES, P1_ACCEL_CODES, P1_LEFT_KEYS, P1_ACCEL_KEYS);
        }
        return readKeyboardControls(1, P2_LEFT_CODES, P2_RIGHT_CODES, P2_ACCEL_CODES);
    }

    return {
        poll,
        getControls,
        consumePauseToggle(): boolean {
            const v = pauseEdge;
            pauseEdge = false;
            return v;
        },
        consumeCameraToggle(playerSlot: 0 | 1): boolean {
            const v = cameraEdge[playerSlot];
            cameraEdge[playerSlot] = false;
            return v;
        },
        consumeConfirm(): boolean {
            const v = confirmEdge;
            confirmEdge = false;
            return v;
        },
        consumeCancel(): boolean {
            const v = cancelEdge;
            cancelEdge = false;
            return v;
        },
        consumeMenuUp(): boolean {
            const v = menuUpEdge;
            menuUpEdge = false;
            return v;
        },
        consumeMenuDown(): boolean {
            const v = menuDownEdge;
            menuDownEdge = false;
            return v;
        },
        consumeDpadUp(): boolean {
            const v = dpadUpEdge;
            dpadUpEdge = false;
            return v;
        },
        consumeDpadDown(): boolean {
            const v = dpadDownEdge;
            dpadDownEdge = false;
            return v;
        },
        resetNavEdges(): void {
            confirmEdge = false;
            cancelEdge = false;
            menuUpEdge = false;
            menuDownEdge = false;
            dpadUpEdge = false;
            dpadDownEdge = false;
        },
        getRightStick,
        hasGamepad(): boolean {
            return gamepadConnected;
        },
        dispose(): void {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", clearAll);
            document.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("gamepadconnected", onGamepadConnected);
            window.removeEventListener("gamepaddisconnected", onGamepadDisconnected);
            clearAll();
        },
    };
}
