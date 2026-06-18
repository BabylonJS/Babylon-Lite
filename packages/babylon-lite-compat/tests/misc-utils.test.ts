import { describe, expect, it } from "vitest";

import { SmartArray, StringDictionary, Tags, PerformanceMonitor, FactorGradient } from "../src/misc/misc-utils";

describe("SmartArray", () => {
    it("pushes and resets without shrinking capacity", () => {
        const arr = new SmartArray<number>(2);
        arr.push(1);
        arr.push(2);
        arr.push(3);
        expect(arr.length).toBe(3);
        expect(arr.data.slice(0, 3)).toEqual([1, 2, 3]);
        arr.reset();
        expect(arr.length).toBe(0);
    });
});

describe("StringDictionary", () => {
    it("adds, sets, gets, and counts", () => {
        const dict = new StringDictionary<number>();
        expect(dict.add("a", 1)).toBe(true);
        expect(dict.add("a", 2)).toBe(false);
        expect(dict.get("a")).toBe(1);
        expect(dict.set("a", 5)).toBe(true);
        expect(dict.get("a")).toBe(5);
        expect(dict.count).toBe(1);
        expect(dict.getOrAddWithFactory("b", () => 7)).toBe(7);
        expect(dict.remove("a")).toBe(true);
        expect(dict.contains("a")).toBe(false);
    });
});

describe("Tags", () => {
    it("adds, queries, and removes tags", () => {
        const obj: Record<string, unknown> = {};
        Tags.AddTagsTo(obj, "red shiny");
        expect(Tags.HasTags(obj)).toBe(true);
        expect(Tags.MatchesQuery(obj, "red")).toBe(true);
        expect(Tags.GetTags(obj).sort()).toEqual(["red", "shiny"]);
        Tags.RemoveTagsFrom(obj, "red");
        expect(Tags.MatchesQuery(obj, "red")).toBe(false);
    });
});

describe("PerformanceMonitor", () => {
    it("averages frame deltas into FPS", () => {
        const monitor = new PerformanceMonitor(10);
        let t = 0;
        for (let i = 0; i < 5; i++) {
            t += 16;
            monitor.sampleFrame(t);
        }
        expect(monitor.averageFrameTime).toBeCloseTo(16, 6);
        expect(monitor.averageFPS).toBeCloseTo(1000 / 16, 4);
    });

    it("respects disable", () => {
        const monitor = new PerformanceMonitor(10);
        monitor.disable();
        monitor.sampleFrame(16);
        monitor.sampleFrame(32);
        expect(monitor.averageFrameTime).toBe(0);
    });
});

describe("FactorGradient", () => {
    it("stores gradient position and factors", () => {
        const g = new FactorGradient(0.5, 2);
        expect(g.gradient).toBe(0.5);
        expect(g.getFactor()).toBe(2);
        expect(g.factor2).toBe(2);
    });
});
