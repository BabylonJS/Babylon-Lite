import { describe, it, expect } from "vitest";
import { createAudioSignal } from "../../../../packages/babylon-lite/src/audio/audio-signal.js";

describe("AudioSignal", () => {
    it("notifies subscribers with the value", () => {
        const signal = createAudioSignal<number>();
        const seen: number[] = [];
        signal.add((v) => seen.push(v));
        signal._notify(1);
        signal._notify(2);
        expect(seen).toEqual([1, 2]);
    });

    it("addOnce fires exactly once", () => {
        const signal = createAudioSignal<void>();
        let count = 0;
        signal.addOnce(() => count++);
        signal._notify();
        signal._notify();
        expect(count).toBe(1);
    });

    it("returns an unsubscribe function from add", () => {
        const signal = createAudioSignal<void>();
        let count = 0;
        const off = signal.add(() => count++);
        signal._notify();
        off();
        signal._notify();
        expect(count).toBe(1);
    });

    it("removeCallback detaches a listener", () => {
        const signal = createAudioSignal<void>();
        let count = 0;
        const cb = (): void => {
            count++;
        };
        signal.add(cb);
        signal._removeCallback(cb);
        signal._notify();
        expect(count).toBe(0);
    });

    it("hasObservers reflects subscriber presence", () => {
        const signal = createAudioSignal<void>();
        expect(signal._hasObservers()).toBe(false);
        const off = signal.add(() => {});
        expect(signal._hasObservers()).toBe(true);
        off();
        expect(signal._hasObservers()).toBe(false);
    });

    it("clear removes all listeners", () => {
        const signal = createAudioSignal<void>();
        let count = 0;
        signal.add(() => count++);
        signal.add(() => count++);
        signal._clear();
        signal._notify();
        expect(count).toBe(0);
    });
});
