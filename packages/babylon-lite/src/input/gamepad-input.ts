/** One copied gamepad button; independent of the browser's live object. */
export interface GamepadButtonState {
    /** Analog value in the browser's zero-to-one range. */
    value: number;
    /** Whether the device considers the button pressed. */
    pressed: boolean;
    /** Whether the device reports touch contact. */
    touched: boolean;
}

/** Application-owned gamepad snapshot. Unknown mappings remain explicit. */
export interface GamepadState {
    /** Browser-provided device identifier. */
    id: string;
    /** Browser slot index. */
    index: number;
    /** Only standard guarantees standard button/axis positions. */
    mapping: GamepadMappingType;
    /** Browser-provided update timestamp. */
    timestamp: number;
    /** Copied raw axis values; the application chooses dead zones. */
    axes: number[];
    /** Copied button values, pressed state and touch state. */
    buttons: GamepadButtonState[];
}

/**
 * Copy one browser gamepad slot, with no listeners or per-frame registration.
 * @param index - Nonnegative integer navigator slot; defaults to zero.
 * @returns A fresh snapshot, or null for unavailable, denied or disconnected input.
 */
export function readGamepad(index = 0): GamepadState | null {
    if (!Number.isInteger(index) || index < 0) {
        throw new RangeError("Gamepad index must be a nonnegative integer.");
    }
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
        return null;
    }
    let pads: (Gamepad | null)[];
    try {
        pads = navigator.getGamepads();
    } catch {
        return null;
    }
    const pad = pads[index];
    if (!pad?.connected) {
        return null;
    }
    return {
        id: pad.id,
        index: pad.index,
        mapping: pad.mapping,
        timestamp: pad.timestamp,
        axes: Array.from(pad.axes),
        buttons: Array.from(pad.buttons, ({ value, pressed, touched }) => ({ value, pressed, touched })),
    };
}
