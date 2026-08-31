import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InputSystem } from "../../../lab/lite/src/demos/antigravity-racer/input";

interface TestButton {
    readonly element: HTMLButtonElement;
    dispatch(type: "focus" | "pointerdown"): void;
    focus(): void;
    click(): void;
}

interface TestInput {
    input: InputSystem;
    down: boolean;
    up: boolean;
    confirm: boolean;
}

const navModule = "../../../lab/lite/src/demos/antigravity-racer/gamepad-list-nav.js";
const { createButtonListNav } = await import(navModule);

function makeButton(): TestButton {
    const listeners = new Map<string, Array<() => void>>();
    const element = {} as HTMLButtonElement;
    const focus = vi.fn(() => {
        Object.defineProperty(document, "activeElement", { configurable: true, value: element });
        for (const listener of listeners.get("focus") ?? []) {
            listener();
        }
    });
    const click = vi.fn();
    Object.assign(element, {
        addEventListener(type: string, listener: () => void): void {
            const entries = listeners.get(type) ?? [];
            entries.push(listener);
            listeners.set(type, entries);
        },
        focus,
        click,
    });
    return {
        element,
        focus,
        click,
        dispatch(type): void {
            for (const listener of listeners.get(type) ?? []) {
                listener();
            }
        },
    };
}

function makeInput(): TestInput {
    const state: TestInput = {
        down: false,
        up: false,
        confirm: false,
        input: null as unknown as InputSystem,
    };
    state.input = {
        resetNavEdges: vi.fn(),
        consumeMenuDown: () => state.down && !(state.down = false),
        consumeMenuUp: () => state.up && !(state.up = false),
        consumeConfirm: () => state.confirm && !(state.confirm = false),
    } as unknown as InputSystem;
    return state;
}

describe("antigravity racer button-list navigation", () => {
    beforeEach(() => {
        vi.stubGlobal("document", {});
        Object.defineProperty(document, "activeElement", { configurable: true, value: null });
    });

    it("never confirms an element outside the managed button list", () => {
        const first = makeButton();
        const second = makeButton();
        const external = { click: vi.fn() };
        const state = makeInput();
        const nav = createButtonListNav([first.element, second.element]);

        Object.defineProperty(document, "activeElement", { configurable: true, value: external });
        state.confirm = true;
        nav.poll(state.input);

        expect(external.click).not.toHaveBeenCalled();
        expect(first.click).not.toHaveBeenCalled();
        expect(second.click).not.toHaveBeenCalled();
    });

    it("confirms the focused managed button", () => {
        const first = makeButton();
        const second = makeButton();
        const state = makeInput();
        const nav = createButtonListNav([first.element, second.element]);

        second.focus();
        state.confirm = true;
        nav.poll(state.input);

        expect(first.click).not.toHaveBeenCalled();
        expect(second.click).toHaveBeenCalledOnce();
    });

    it("continues navigation from pointer-selected buttons", () => {
        const first = makeButton();
        const second = makeButton();
        const third = makeButton();
        const state = makeInput();
        const nav = createButtonListNav([first.element, second.element, third.element]);

        third.dispatch("pointerdown");
        Object.defineProperty(document, "activeElement", { configurable: true, value: null });
        state.up = true;
        nav.poll(state.input);

        expect(second.focus).toHaveBeenCalledOnce();
    });
});
