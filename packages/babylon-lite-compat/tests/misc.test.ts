import { describe, expect, it, vi } from "vitest";

import { Observable } from "../src/misc/observable";
import { Tools } from "../src/misc/tools";

describe("Observable", () => {
    it("notifies all observers", () => {
        const obs = new Observable<number>();
        const seen: number[] = [];
        obs.add((n) => seen.push(n));
        obs.add((n) => seen.push(n * 2));
        obs.notifyObservers(5);
        expect(seen).toEqual([5, 10]);
    });

    it("removes observers", () => {
        const obs = new Observable<void>();
        const cb = vi.fn();
        obs.add(cb);
        expect(obs.hasObservers()).toBe(true);
        obs.removeCallback(cb);
        obs.notifyObservers();
        expect(cb).not.toHaveBeenCalled();
        expect(obs.hasObservers()).toBe(false);
    });

    it("supports addOnce", () => {
        const obs = new Observable<void>();
        const cb = vi.fn();
        obs.addOnce(cb);
        obs.notifyObservers();
        obs.notifyObservers();
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("allows mutation during notification", () => {
        const obs = new Observable<void>();
        const cb = vi.fn();
        obs.add(() => obs.add(cb));
        obs.notifyObservers();
        expect(cb).not.toHaveBeenCalled(); // added during this pass, fires next time
        obs.notifyObservers();
        expect(cb).toHaveBeenCalledTimes(1);
    });
});

describe("Tools", () => {
    it("converts degrees and radians", () => {
        expect(Tools.ToRadians(180)).toBeCloseTo(Math.PI, 6);
        expect(Tools.ToDegrees(Math.PI)).toBeCloseTo(180, 6);
    });

    it("generates v4 UUIDs", () => {
        const id = Tools.RandomId();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("clamps", () => {
        expect(Tools.Clamp(-1, 0, 1)).toBe(0);
        expect(Tools.Clamp(2, 0, 1)).toBe(1);
    });
});
