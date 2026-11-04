import { describe, expect, it } from "vitest";
import { createFakeFrameClock } from "./fake-frame-clock.js";

describe("MeshLoD fake frame clock", () => {
    it("fires chained deadlines at the same times regardless of advance step size", () => {
        const run = (steps: number[]): { firedAt: number[]; now: number; pending: number } => {
            const clock = createFakeFrameClock();
            const firedAt: number[] = [];
            clock.setTimer(250, () => {
                firedAt.push(clock.now);
                clock.setTimer(1000, () => firedAt.push(clock.now));
            });
            for (const step of steps) {
                clock.advanceMs(step);
            }
            return { firedAt, now: clock.now, pending: clock.pendingCount() };
        };
        expect(run([1250])).toEqual(run([250, 1000]));
        expect(run([1250])).toEqual({ firedAt: [250, 1250], now: 1250, pending: 0 });
    });
});
