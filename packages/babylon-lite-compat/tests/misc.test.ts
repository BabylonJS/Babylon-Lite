import { describe, expect, it, vi } from "vitest";

import { Observable } from "../src/misc/observable";
import { Tools } from "../src/misc/tools";
import { RandomGUID, GUID } from "../src/misc/guid";
import { Constants } from "../src/misc/engine-constants";

describe("Constants", () => {
    it("carries the Babylon.js numeric alpha-blend constants (incl. ALPHA_REPLACE_COLOR = 21)", () => {
        expect(Constants.ALPHA_DISABLE).toBe(0);
        expect(Constants.ALPHA_ONEONE).toBe(6);
        expect(Constants.ALPHA_PREMULTIPLIED).toBe(7);
        expect(Constants.ALPHA_REPLACE_COLOR).toBe(21);
    });
});

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

    it("replays the last notification to late subscribers when notifyIfTriggered is enabled", () => {
        const obs = new Observable<number>(undefined, true);
        const seen: number[] = [];

        obs.notifyObservers(3);
        obs.add((n) => seen.push(n));
        obs.notifyObservers(5);

        expect(seen).toEqual([3, 5]);
    });

    it("does not replay to late subscribers by default", () => {
        const obs = new Observable<number>();
        const seen: number[] = [];

        obs.notifyObservers(3);
        obs.add((n) => seen.push(n));

        expect(seen).toEqual([]);
    });

    it("replays addOnce late subscribers once when notifyIfTriggered is enabled", () => {
        const obs = new Observable<number>(undefined, true);
        const seen: number[] = [];

        obs.notifyObservers(3);
        obs.addOnce((n) => seen.push(n));
        obs.notifyObservers(5);

        expect(seen).toEqual([3]);
    });

    it("does not replay an undefined last notification, matching Babylon.js", () => {
        const obs = new Observable<void>(undefined, true);
        const cb = vi.fn();

        obs.notifyObservers();
        obs.add(cb);

        expect(cb).not.toHaveBeenCalled();
    });

    it("clears the last notified state", () => {
        const obs = new Observable<number>(undefined, true);
        const seen: number[] = [];

        obs.notifyObservers(3);
        obs.cleanLastNotifiedState();
        obs.add((n) => seen.push(n));

        expect(seen).toEqual([]);
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

describe("GUID", () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it("RandomGUID generates a v4 UUID", () => {
        expect(RandomGUID()).toMatch(v4);
    });

    it("RandomGUID yields distinct ids", () => {
        expect(RandomGUID()).not.toBe(RandomGUID());
    });

    it("GUID.RandomId aliases RandomGUID", () => {
        expect(GUID.RandomId).toBe(RandomGUID);
        expect(GUID.RandomId()).toMatch(v4);
    });
});
