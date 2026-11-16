import { describe, expect, it } from "vitest";

import { DeviceSourceManager, DeviceType, EventConstants, PointerInput } from "../src/events/device-input";
import type { DeviceSourceEvent } from "../src/events/device-input";
import type { AbstractEngine } from "../src/engine/engine";
import { LiteCompatError } from "../src/error";

describe("DeviceInput API", () => {
    it("preserves Babylon.js device and pointer enum values", () => {
        expect(DeviceType.Keyboard).toBe(1);
        expect(DeviceType.DualSense).toBe(7);
        expect(PointerInput.Horizontal).toBe(0);
        expect(PointerInput.MouseWheelZ).toBe(9);
        expect(PointerInput.Move).toBe(12);
        expect(EventConstants.DOM_DELTA_PAGE).toBe(2);
    });

    it("preserves Babylon.js inputIndex event typing", () => {
        const acceptKeyboardEvent = (event: DeviceSourceEvent<DeviceType.Keyboard>): number => event.inputIndex;
        expect(acceptKeyboardEvent).toBeTypeOf("function");
    });

    it("names the input-management lifecycle blocker", () => {
        expect(() => new DeviceSourceManager({} as AbstractEngine)).toThrow(LiteCompatError);
        expect(() => new DeviceSourceManager({} as AbstractEngine)).toThrow(/multi-device slot classification/);
    });
});
