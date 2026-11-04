import { describe, it, expect } from "vitest";

import { readXrController } from "../../../../packages/babylon-lite/src/xr/xr-controller";
import type { XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";
import type { XrHandedness } from "../../../../packages/babylon-lite/src/xr/xr-support";

function button(pressed: boolean, touched = pressed, value = pressed ? 1 : 0): GamepadButton {
    return { pressed, touched, value } as GamepadButton;
}

/** A full xr-standard gamepad: 6 buttons + 4 axes (touchpad x/y, thumbstick x/y). */
function fullGamepad(): Gamepad {
    return {
        buttons: [button(true, true, 0.7), button(false), button(false), button(true), button(true), button(false)],
        axes: [0.1, -0.2, 0.5, -0.9],
    } as unknown as Gamepad;
}

function makeSource(gamepad: Gamepad | null, handedness: XrHandedness = "right"): XrInputSource {
    return { handedness, gamepad } as unknown as XrInputSource;
}

describe("readXrController", () => {
    it("returns null when the source exposes no gamepad", () => {
        expect(readXrController(makeSource(null))).toBeNull();
    });

    it("maps the xr-standard buttons by index", () => {
        const c = readXrController(makeSource(fullGamepad()))!;
        expect(c.handedness).toBe("right");
        // trigger = buttons[0], with its analog value preserved.
        expect(c.trigger).toEqual({ pressed: true, touched: true, value: 0.7 });
        // squeeze = buttons[1], touchpad = buttons[2].
        expect(c.squeeze!.pressed).toBe(false);
        expect(c.touchpad!.pressed).toBe(false);
        // thumbstick press = buttons[3]; A/X = buttons[4]; B/Y = buttons[5].
        expect(c.thumbstick!.pressed).toBe(true);
        expect(c.buttonA!.pressed).toBe(true);
        expect(c.buttonB!.pressed).toBe(false);
    });

    it("maps the touchpad and thumbstick axis pairs", () => {
        const c = readXrController(makeSource(fullGamepad()))!;
        expect(c.touchpadAxes).toEqual([0.1, -0.2]);
        expect(c.thumbstickAxes).toEqual([0.5, -0.9]);
    });

    it("nulls out buttons and axes the device does not expose", () => {
        // A minimal gamepad: only trigger + squeeze, and only the touchpad axis pair.
        const gp = { buttons: [button(true), button(false)], axes: [0.3, 0.4] } as unknown as Gamepad;
        const c = readXrController(makeSource(gp, "left"))!;
        expect(c.handedness).toBe("left");
        expect(c.trigger!.pressed).toBe(true);
        expect(c.squeeze!.pressed).toBe(false);
        expect(c.touchpad).toBeNull();
        expect(c.thumbstick).toBeNull();
        expect(c.buttonA).toBeNull();
        expect(c.buttonB).toBeNull();
        expect(c.touchpadAxes).toEqual([0.3, 0.4]);
        expect(c.thumbstickAxes).toBeNull();
    });

    it("returns a fresh snapshot each call (safe to diff for edge detection)", () => {
        const src = makeSource(fullGamepad());
        const a = readXrController(src)!;
        const b = readXrController(src)!;
        expect(a).not.toBe(b);
        expect(a.trigger).not.toBe(b.trigger);
        expect(a.trigger).toEqual(b.trigger);
    });
});
