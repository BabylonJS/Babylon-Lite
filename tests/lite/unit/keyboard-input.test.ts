import { describe, expect, it } from "vitest";
import { createKeyboardInput, disposeKeyboardInput, isKeyboardKeyDown } from "../../../packages/babylon-lite/src/input/keyboard-input";
import { inputFixture } from "./device-input-fixture";

describe("standalone keyboard input", () => {
    it("uses physical codes, preserves simultaneous keys and handles repeats", () => {
        const f = inputFixture();
        const input = createKeyboardInput(f.element);
        f.emit(f.element, "keydown", { code: "KeyW", key: "z" });
        f.emit(f.element, "keydown", { code: "KeyW", repeat: true });
        f.emit(f.element, "keydown", { code: "ShiftLeft" });
        expect([...input.keys]).toEqual(["KeyW", "ShiftLeft"]);
        expect(isKeyboardKeyDown(input, "KeyW")).toBe(true);
        expect(isKeyboardKeyDown(input, "KeyZ")).toBe(false);
        f.emit(f.view, "keyup", { code: "KeyW" });
        expect([...input.keys]).toEqual(["ShiftLeft"]);
        disposeKeyboardInput(input);
    });

    it.each(["element blur", "window blur", "hidden document"])("clears held keys after %s", (reason) => {
        const f = inputFixture();
        const input = createKeyboardInput(f.element);
        f.emit(f.element, "keydown", { code: "KeyW" });
        if (reason === "hidden document") {
            f.doc.hidden = true;
            f.emit(f.doc, "visibilitychange");
        } else {
            f.emit(reason === "window blur" ? f.view : f.element, "blur");
        }
        expect(input.keys.size).toBe(0);
        disposeKeyboardInput(input);
    });

    it("ignores a visible visibilitychange and empty key codes", () => {
        const f = inputFixture();
        const input = createKeyboardInput(f.element);
        f.emit(f.element, "keydown", { code: "KeyW" });
        f.emit(f.element, "keydown", { code: "" });
        f.emit(f.doc, "visibilitychange");
        expect([...input.keys]).toEqual(["KeyW"]);
        disposeKeyboardInput(input);
    });

    it("removes only its own listeners and keeps independent managers working", () => {
        const f = inputFixture();
        const first = createKeyboardInput(f.element);
        const second = createKeyboardInput(f.element);
        f.emit(f.element, "keydown", { code: "KeyW" });
        disposeKeyboardInput(first);
        disposeKeyboardInput(first);
        f.emit(f.element, "keydown", { code: "KeyA" });
        expect(first.keys.size).toBe(0);
        expect([...second.keys]).toEqual(["KeyW", "KeyA"]);
        disposeKeyboardInput(second);
    });

    it("supports a Window target and confines releases to the owning realm", () => {
        const f = inputFixture();
        const other = inputFixture();
        const input = createKeyboardInput(f.view);
        f.emit(f.view, "keydown", { code: "KeyW" });
        other.emit(other.view, "keyup", { code: "KeyW" });
        expect(isKeyboardKeyDown(input, "KeyW")).toBe(true);
        f.emit(f.view, "keyup", { code: "KeyW" });
        expect(input.keys.size).toBe(0);
        disposeKeyboardInput(input);
    });
});
