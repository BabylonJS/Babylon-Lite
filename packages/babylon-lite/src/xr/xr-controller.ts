/**
 * Controller button + axis mapping — a tree-shakable reader for the WebXR
 * `xr-standard` gamepad profile, ported from Babylon.js
 * `WebXRControllerComponent`/`WebXRMotionController` (minus the online GLB motion
 * controller models, which are not lite-compatible).
 *
 * Pure data + a single free function ({@link readXrController}); it depends only on
 * the `Gamepad` a source exposes, so importing it drags in no scene or mesh code.
 * Nothing polls automatically — the app calls {@link readXrController} each frame
 * for the sources it cares about.
 */

import type { XrHandedness } from "./xr-support.js";
import type { XrInputSource } from "./xr-input.js";

/** State of a single controller button/trigger for the current frame. */
export interface XrButtonState {
    /** True while the button is fully pressed. */
    pressed: boolean;
    /** True while the button is touched (capacitive), if the hardware reports it. */
    touched: boolean;
    /** Analog value in `[0, 1]` (1 for digital buttons when pressed). */
    value: number;
}

/**
 * Decoded `xr-standard` controller state for one input source. Every field is
 * nullable because a given device may not expose that button/axis pair; callers
 * should null-check before reading. Index conventions follow the WebXR
 * `xr-standard` gamepad mapping.
 */
export interface XrControllerComponents {
    /** `"left"`, `"right"`, or `"none"`. */
    readonly handedness: XrHandedness;
    /** Primary trigger — `buttons[0]`. */
    readonly trigger: XrButtonState | null;
    /** Grip / squeeze — `buttons[1]`. */
    readonly squeeze: XrButtonState | null;
    /** Touchpad press — `buttons[2]`. */
    readonly touchpad: XrButtonState | null;
    /** Thumbstick press — `buttons[3]`. */
    readonly thumbstick: XrButtonState | null;
    /** Primary face button (A / X) — `buttons[4]`. */
    readonly buttonA: XrButtonState | null;
    /** Secondary face button (B / Y) — `buttons[5]`. */
    readonly buttonB: XrButtonState | null;
    /** Touchpad `[x, y]` in `[-1, 1]` — `axes[0], axes[1]`. */
    readonly touchpadAxes: readonly [number, number] | null;
    /** Thumbstick `[x, y]` in `[-1, 1]` — `axes[2], axes[3]`. */
    readonly thumbstickAxes: readonly [number, number] | null;
}

/** @internal Read one `GamepadButton` into a plain {@link XrButtonState}. */
function readButton(buttons: readonly GamepadButton[], index: number): XrButtonState | null {
    const b = buttons[index];
    if (!b) {
        return null;
    }
    return { pressed: b.pressed, touched: b.touched, value: b.value };
}

/** @internal Read an `[x, y]` axis pair, or null when either axis is absent. */
function readAxes(axes: readonly number[], xIndex: number, yIndex: number): [number, number] | null {
    const x = axes[xIndex];
    const y = axes[yIndex];
    if (x === undefined || y === undefined) {
        return null;
    }
    return [x, y];
}

/**
 * Decode an input source's `xr-standard` gamepad into structured button/axis
 * state for the current frame. Returns `null` when the source exposes no gamepad
 * (e.g. a gaze or hand-tracking source). The result is a fresh snapshot each call,
 * so it is safe to diff against the previous frame's snapshot for edge detection.
 *
 * @param input - The tracked input source (from {@link XrInputManager}).
 * @returns The decoded components, or `null` when there is no gamepad.
 */
export function readXrController(input: XrInputSource): XrControllerComponents | null {
    const gp = input.gamepad;
    if (!gp) {
        return null;
    }
    const buttons = gp.buttons as unknown as readonly GamepadButton[];
    const axes = gp.axes as unknown as readonly number[];
    return {
        handedness: input.handedness,
        trigger: readButton(buttons, 0),
        squeeze: readButton(buttons, 1),
        touchpad: readButton(buttons, 2),
        thumbstick: readButton(buttons, 3),
        buttonA: readButton(buttons, 4),
        buttonB: readButton(buttons, 5),
        touchpadAxes: readAxes(axes, 0, 1),
        thumbstickAxes: readAxes(axes, 2, 3),
    };
}
