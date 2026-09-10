import { describe, expect, it } from "vitest";

import { createCsmStaticRefitScheduler } from "../../../packages/babylon-lite/src/shadow/csm-refit-gate";

describe("CSM static refit scheduler", () => {
    it("spreads a drift refit over frames within the per-frame budget and pins the worst lag", () => {
        const scheduler = createCsmStaticRefitScheduler(3, 1);
        expect(scheduler.maxLagFrames()).toBe(2);
        expect(scheduler.pending()).toBe(false);
        expect(scheduler.take()).toEqual([]);

        scheduler.arm(true);
        expect(scheduler.pending()).toBe(true);
        expect(scheduler.take()).toEqual([0]); // the refit frame itself renders the first cascade
        expect(scheduler.take()).toEqual([1]); // lag 1
        expect(scheduler.take()).toEqual([2]); // lag 2 = maxLagFrames
        expect(scheduler.pending()).toBe(false);
        expect(scheduler.take()).toEqual([]);
    });

    it("re-renders every cascade in one frame when the refit is not drift-only", () => {
        const scheduler = createCsmStaticRefitScheduler(3, 1);
        scheduler.arm(false);
        expect(scheduler.take()).toEqual([0, 1, 2]);
        expect(scheduler.pending()).toBe(false);
    });

    it("keeps the historical single-frame re-render when the budget is 0 or covers every cascade", () => {
        for (const budget of [0, 3, 4, -1, Number.NaN]) {
            const scheduler = createCsmStaticRefitScheduler(3, budget);
            expect(scheduler.maxLagFrames()).toBe(0);
            scheduler.arm(true);
            expect(scheduler.take()).toEqual([0, 1, 2]);
            expect(scheduler.pending()).toBe(false);
        }
    });

    it("continues round-robin across refits so no cascade starves when refits arrive faster than the drain", () => {
        const scheduler = createCsmStaticRefitScheduler(3, 1);
        scheduler.arm(true);
        expect(scheduler.take()).toEqual([0]);
        scheduler.arm(true); // a second drift refit lands before the first drained
        expect(scheduler.take()).toEqual([1]); // not 0 again
        expect(scheduler.take()).toEqual([2]);
        expect(scheduler.take()).toEqual([0]); // the re-armed first cascade gets its turn
        expect(scheduler.pending()).toBe(false);
    });

    it("lets a full refit interrupt a spread and returns to the budget afterwards", () => {
        const scheduler = createCsmStaticRefitScheduler(4, 2);
        expect(scheduler.maxLagFrames()).toBe(1);
        scheduler.arm(true);
        expect(scheduler.take()).toEqual([0, 1]);
        scheduler.arm(false); // camera moved: everything now
        expect(scheduler.take()).toEqual([2, 3, 0, 1]);
        scheduler.arm(true);
        expect(scheduler.take()).toEqual([2, 3]);
        expect(scheduler.take()).toEqual([0, 1]);
        expect(scheduler.pending()).toBe(false);
    });
});
