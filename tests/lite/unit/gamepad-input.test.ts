import { afterEach, describe, expect, it, vi } from "vitest";
import { readGamepad } from "../../../packages/babylon-lite/src/input/gamepad-input";

afterEach(() => vi.unstubAllGlobals());

describe("standalone gamepad snapshots", () => {
    it("reads a chosen slot and owns all axes and button state", () => {
        const button = { value: 0.6, pressed: true, touched: true };
        const pad = { id: "test pad", index: 1, mapping: "standard", timestamp: 12, connected: true, axes: [-0.5, 0.25], buttons: [button] };
        vi.stubGlobal("navigator", { getGamepads: () => [null, pad] });
        const snapshot = readGamepad(1)!;
        expect(snapshot).toEqual({ id: "test pad", index: 1, mapping: "standard", timestamp: 12, axes: [-0.5, 0.25], buttons: [button] });
        pad.axes[0] = 1;
        button.value = 0;
        expect(snapshot.axes[0]).toBe(-0.5);
        expect(snapshot.buttons[0]?.value).toBe(0.6);
        snapshot.axes[1] = 1;
        expect(pad.axes[1]).toBe(0.25);
        pad.connected = false;
        expect(readGamepad(1)).toBeNull();
    });

    it("keeps unknown device mappings explicit instead of guessing layouts", () => {
        vi.stubGlobal("navigator", { getGamepads: () => [{ connected: true, id: "other", index: 0, mapping: "", timestamp: 0, axes: [], buttons: [] }] });
        expect(readGamepad()?.mapping).toBe("");
    });

    it("handles missing API, empty slots, disconnection and denied access", () => {
        vi.stubGlobal("navigator", undefined);
        expect(readGamepad()).toBeNull();
        vi.stubGlobal("navigator", {});
        expect(readGamepad()).toBeNull();
        vi.stubGlobal("navigator", { getGamepads: () => [null] });
        expect(readGamepad()).toBeNull();
        vi.stubGlobal("navigator", {
            getGamepads: () => {
                throw new DOMException("Blocked", "SecurityError");
            },
        });
        expect(readGamepad()).toBeNull();
    });

    it.each([-1, 0.5, NaN, Infinity])("rejects an invalid slot %s", (slot) => {
        expect(() => readGamepad(slot)).toThrow(RangeError);
    });
});
