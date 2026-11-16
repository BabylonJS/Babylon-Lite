import { describe, expect, it } from "vitest";
import { createPointerInput, disposePointerInput, resetPointerInput } from "../../../packages/babylon-lite/src/input/pointer-input";
import { inputFixture } from "./device-input-fixture";

describe("standalone pointer input", () => {
    it("records CSS-local positions and accumulates motion until reset", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointermove", { clientX: 40, clientY: 50 });
        expect([input.x, input.y, input.deltaX, input.deltaY]).toEqual([30, 30, 0, 0]);
        f.pointer("pointermove", { clientX: 45, clientY: 70 });
        f.pointer("pointermove", { clientX: 48, clientY: 65 });
        expect([input.deltaX, input.deltaY]).toEqual([8, 15]);
        resetPointerInput(input);
        expect([input.x, input.y, input.deltaX, input.deltaY]).toEqual([38, 45, 0, 0]);
        f.pointer("pointermove", { clientX: 50, clientY: 66 });
        expect([input.deltaX, input.deltaY]).toEqual([2, 1]);
        disposePointerInput(input);
    });

    it("tracks an active primary pointer outside the element without canceling events", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        const down = f.pointer("pointerdown", { buttons: 1, clientX: 20, clientY: 25 });
        f.pointer("pointermove", { buttons: 1, clientX: 250, clientY: 130 }, [f.view]);
        expect([input.buttons, input.x, input.y]).toEqual([1, 240, 110]);
        resetPointerInput(input);
        expect(input.buttons).toBe(1);
        f.pointer("pointerup", { clientX: 250, clientY: 130 }, [f.view]);
        expect(input.buttons).toBe(0);
        expect(down.defaultPrevented).toBe(false);
        disposePointerInput(input);
    });

    it("does not let a secondary touch or another primary device steal a drag", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { pointerId: 2, pointerType: "touch", buttons: 1, clientX: 30 });
        f.pointer("pointerdown", { pointerId: 3, pointerType: "touch", isPrimary: false, buttons: 1, clientX: 80 });
        f.pointer("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 150 });
        expect([input.pointerId, input.pointerType, input.x]).toEqual([2, "touch", 20]);
        f.pointer("pointerup", { pointerId: 2, pointerType: "touch", clientX: 30 });
        f.pointer("pointermove", { pointerId: 1, clientX: 150 });
        expect([input.pointerId, input.deltaX]).toEqual([1, 0]);
        disposePointerInput(input);
    });

    it("adopts a held pointer entering from outside and observes its later release", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { buttons: 1 }, [f.view]);
        f.pointer("pointermove", { buttons: 1, clientX: 30 });
        expect(input.buttons).toBe(1);
        f.pointer("pointermove", { buttons: 1, clientX: 250 }, [f.view]);
        expect(input.x).toBe(240);
        f.pointer("pointerup", { clientX: 250 }, [f.view]);
        expect(input.buttons).toBe(0);
        disposePointerInput(input);
    });

    it("releases an active contact when a later move reports no held buttons", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { buttons: 1 });
        f.pointer("pointermove", { buttons: 0 });
        f.pointer("pointerdown", { pointerId: 2, pointerType: "pen", buttons: 1 });
        expect([input.pointerId, input.pointerType]).toEqual([2, "pen"]);
        disposePointerInput(input);
    });

    it("retains raw wheel units and starts a fresh batch on mode changes", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        const event = f.emit(f.element, "wheel", { deltaX: 1, deltaY: 2, deltaZ: 3, deltaMode: 1 });
        f.emit(f.element, "wheel", { deltaX: 2, deltaY: -1, deltaZ: 1, deltaMode: 1 });
        expect([input.wheelX, input.wheelY, input.wheelZ, input.wheelDeltaMode]).toEqual([3, 1, 4, 1]);
        f.emit(f.element, "wheel", { deltaX: 0, deltaY: 1, deltaZ: 0, deltaMode: 2 });
        expect([input.wheelX, input.wheelY, input.wheelZ, input.wheelDeltaMode]).toEqual([0, 1, 0, 2]);
        expect(event.defaultPrevented).toBe(false);
        resetPointerInput(input);
        expect([input.wheelX, input.wheelY, input.wheelZ, input.wheelDeltaMode]).toEqual([0, 0, 0, 0]);
        disposePointerInput(input);
    });

    it("uses movement deltas under pointer lock", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.doc.pointerLockElement = f.element;
        f.pointer("pointermove", { movementX: 8, movementY: -5 });
        expect([input.deltaX, input.deltaY]).toEqual([8, -5]);
        disposePointerInput(input);
    });

    it.each(["pointercancel", "lostpointercapture", "blur", "hidden"])("clears held/transient state on %s", (type) => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { buttons: 1 });
        f.pointer("pointermove", { buttons: 1, clientX: 35 });
        f.emit(f.element, "wheel", { deltaX: 1, deltaY: 2, deltaZ: 0, deltaMode: 0 });
        if (type === "hidden") {
            f.doc.hidden = true;
            f.emit(f.doc, "visibilitychange");
        } else if (type === "blur") {
            f.emit(f.view, "blur");
        } else {
            f.pointer(type);
        }
        expect([input.buttons, input.pointerId, input.deltaX, input.wheelY]).toEqual([0, null, 0, 0]);
        disposePointerInput(input);
    });

    it("clears and reseeds motion on pointer-lock entry and exit", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { buttons: 1, clientX: 30 });
        f.pointer("pointermove", { buttons: 1, clientX: 40 });
        f.doc.pointerLockElement = f.element;
        f.emit(f.doc, "pointerlockchange");
        expect([input.buttons, input.pointerId, input.deltaX]).toEqual([0, null, 0]);
        f.pointer("pointermove", { movementX: 5, movementY: 2, clientX: 0, clientY: 0 });
        expect(input.deltaX).toBe(5);
        f.doc.pointerLockElement = null;
        f.emit(f.doc, "pointerlockchange");
        f.pointer("pointermove", { clientX: 180, clientY: 90 });
        expect([input.deltaX, input.deltaY]).toEqual([0, 0]);
        disposePointerInput(input);
    });

    it("ignores unrelated cancellations and preserves the released frame's motion", () => {
        const f = inputFixture();
        const input = createPointerInput(f.element);
        f.pointer("pointerdown", { buttons: 1, pointerId: 4 });
        f.pointer("pointercancel", { pointerId: 5 });
        expect(input.buttons).toBe(1);
        f.pointer("pointerup", { pointerId: 4, clientX: 20 });
        f.pointer("lostpointercapture", { pointerId: 4 });
        expect([input.buttons, input.pointerId, input.pointerType, input.deltaX]).toEqual([0, 4, "mouse", 10]);
        disposePointerInput(input);
    });

    it("ignores unrelated outside events and detaches only the disposed observer", () => {
        const f = inputFixture();
        const first = createPointerInput(f.element);
        const second = createPointerInput(f.element);
        f.pointer("pointermove", { clientX: 90 }, [f.view]);
        expect(first.x).toBe(0);
        disposePointerInput(first);
        disposePointerInput(first);
        f.pointer("pointerdown", { buttons: 1, clientX: 40 });
        expect(first.buttons).toBe(0);
        expect(second.buttons).toBe(1);
        disposePointerInput(second);
    });
});
