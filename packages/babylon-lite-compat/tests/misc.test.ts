import { afterEach, describe, expect, it, vi } from "vitest";

import { Observable } from "../src/misc/observable";
import { Tools } from "../src/misc/tools";
import { RandomGUID, GUID } from "../src/misc/guid";
import { Constants } from "../src/misc/engine-constants";

const V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Replace `Math.random` with a deterministic, cycling sequence so GUID output is exactly reproducible. */
function stubRandom(values: [number, ...number[]]): void {
    let index = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
        const value = values[index % values.length];
        index++;
        return value ?? values[0];
    });
}

/** Nibbles 0..15 in order; the generator consumes one `Math.random()` per template character. */
const RAMP_NIBBLES: [number, ...number[]] = [0, 1 / 16, 2 / 16, 3 / 16, 4 / 16, 5 / 16, 6 / 16, 7 / 16, 8 / 16, 9 / 16, 10 / 16, 11 / 16, 12 / 16, 13 / 16, 14 / 16, 15 / 16];
const RAMP_GUID = "01234567-89ab-4cde-b012-3456789abcde";

/** The two extremes of the v4 layout: every nibble 0, and every nibble 15. */
const ZERO_NIBBLE: [number] = [0];
const ZERO_GUID = "00000000-0000-4000-8000-000000000000";
const MAX_NIBBLE: [number] = [15 / 16];
const MAX_GUID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

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

    it("replays an undefined last notification to late subscribers", () => {
        const obs = new Observable<void>(undefined, true);
        const cb = vi.fn();

        obs.notifyObservers();
        obs.add(cb);

        expect(cb).toHaveBeenCalledOnce();
        expect(cb).toHaveBeenCalledWith(undefined);
    });

    it("removes a late addOnce subscriber after replaying an undefined notification", () => {
        const obs = new Observable<void>(undefined, true);
        const cb = vi.fn();

        obs.notifyObservers();
        obs.addOnce(cb);
        obs.notifyObservers();

        expect(cb).toHaveBeenCalledOnce();
        expect(obs.hasObservers()).toBe(false);
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
    afterEach(() => {
        vi.restoreAllMocks();
        vi.doUnmock("../src/misc/guid");
        vi.resetModules();
    });

    it("converts degrees and radians", () => {
        expect(Tools.ToRadians(180)).toBeCloseTo(Math.PI, 6);
        expect(Tools.ToDegrees(Math.PI)).toBeCloseTo(180, 6);
    });

    it("generates v4 UUIDs", () => {
        const id = Tools.RandomId();
        expect(id).toMatch(V4_PATTERN);
    });

    it("generates the same v4 UUID as RandomGUID for a given random sequence", () => {
        stubRandom(RAMP_NIBBLES);
        expect(Tools.RandomId()).toBe(RAMP_GUID);
    });

    it("routes RandomId through the guid module", async () => {
        vi.resetModules();
        vi.doMock("../src/misc/guid", () => ({ RandomGUID: () => "delegated-guid" }));

        const { Tools: ToolsWithMockedGuid } = await import("../src/misc/tools");
        expect(ToolsWithMockedGuid.RandomId()).toBe("delegated-guid");
    });

    it("clamps", () => {
        expect(Tools.Clamp(-1, 0, 1)).toBe(0);
        expect(Tools.Clamp(2, 0, 1)).toBe(1);
    });
});

describe("GUID", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("RandomGUID generates a v4 UUID", () => {
        expect(RandomGUID()).toMatch(V4_PATTERN);
    });

    it("RandomGUID maps the random sequence onto the v4 layout", () => {
        stubRandom(RAMP_NIBBLES);
        expect(RandomGUID()).toBe(RAMP_GUID);
    });

    it("RandomGUID yields distinct ids for distinct random sequences", () => {
        stubRandom(ZERO_NIBBLE);
        const lowest = RandomGUID();
        stubRandom(MAX_NIBBLE);
        const highest = RandomGUID();

        expect(lowest).toBe(ZERO_GUID);
        expect(highest).toBe(MAX_GUID);
        expect(lowest).not.toBe(highest);
    });

    it("GUID.RandomId aliases RandomGUID", () => {
        expect(GUID.RandomId).toBe(RandomGUID);

        stubRandom(RAMP_NIBBLES);
        expect(GUID.RandomId()).toBe(RAMP_GUID);
    });
});
