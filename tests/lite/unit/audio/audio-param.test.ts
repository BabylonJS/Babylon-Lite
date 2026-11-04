import { describe, it, expect } from "vitest";
import { getRampCurveValues, createRampParam, setRampTarget, isRamping } from "../../../../packages/babylon-lite/src/audio/audio-param.js";
import { MockAudioParam } from "./web-audio-mock.js";
import type { RampClock } from "../../../../packages/babylon-lite/src/audio/audio-param.js";

function makeClock(currentTime = 0, rampDuration = 0.01): RampClock & { _t: number } {
    return {
        _t: currentTime,
        get _currentTime() {
            return this._t;
        },
        _rampDuration: rampDuration,
    };
}

describe("audio-param ramp curves", () => {
    it("linear curve is the 2-point [from, to]", () => {
        const curve = getRampCurveValues("linear", 0.2, 0.8);
        expect(curve.length).toBe(2);
        expect(curve[0]).toBeCloseTo(0.2);
        expect(curve[1]).toBeCloseTo(0.8);
    });

    it("exponential curve spans from->to over 100 points", () => {
        const curve = getRampCurveValues("exponential", 0, 1);
        expect(curve.length).toBe(100);
        expect(curve[0]).toBeCloseTo(0, 5);
        expect(curve[99]).toBeCloseTo(1, 5);
        // Exponential rise: midpoint well below the linear midpoint.
        expect(curve[50]!).toBeLessThan(0.5);
    });

    it("logarithmic curve spans from->to over 100 points", () => {
        const curve = getRampCurveValues("logarithmic", 0, 1);
        expect(curve.length).toBe(100);
        expect(curve[99]).toBeCloseTo(1, 5);
        // Logarithmic rise: midpoint above the linear midpoint.
        expect(curve[50]!).toBeGreaterThan(0.5);
    });

    it("descending exponential ramp ends at the target", () => {
        const curve = getRampCurveValues("exponential", 1, 0);
        expect(curve[curve.length - 1]).toBeCloseTo(0, 5);
    });
});

describe("setRampTarget", () => {
    it("shape 'none' sets the value immediately", () => {
        const param = new MockAudioParam(0) as unknown as AudioParam;
        const rp = createRampParam(param, makeClock());
        setRampTarget(rp, 0.5, { shape: "none" });
        expect(param.value).toBe(0.5);
    });

    it("cancels scheduled values before ramping", () => {
        const mock = new MockAudioParam(0);
        const rp = createRampParam(mock as unknown as AudioParam, makeClock());
        setRampTarget(rp, 0.5, { shape: "linear", duration: 0.1 });
        expect(mock.calls[0]!.method).toBe("cancelScheduledValues");
    });

    it("schedules a value curve for a linear ramp", () => {
        const mock = new MockAudioParam(0);
        const rp = createRampParam(mock as unknown as AudioParam, makeClock(0, 0.01));
        setRampTarget(rp, 1, { shape: "linear", duration: 0.5 });
        const curveCall = mock.calls.find((c) => c.method === "setValueCurveAtTime");
        expect(curveCall).toBeDefined();
        expect(curveCall!.args[2]).toBe(0.5);
    });

    it("ignores non-finite values", () => {
        const mock = new MockAudioParam(0.3);
        const rp = createRampParam(mock as unknown as AudioParam, makeClock());
        setRampTarget(rp, Number.NaN);
        expect(mock.value).toBe(0.3);
        expect(mock.calls.length).toBe(0);
    });

    it("clamps duration to the engine ramp duration", () => {
        const mock = new MockAudioParam(0);
        const rp = createRampParam(mock as unknown as AudioParam, makeClock(0, 0.05));
        setRampTarget(rp, 1, { shape: "linear", duration: 0.001 });
        const curveCall = mock.calls.find((c) => c.method === "setValueCurveAtTime");
        expect(curveCall!.args[2]).toBe(0.05);
    });

    it("isRamping reflects the active ramp window", () => {
        const clock = makeClock(0, 0.01);
        const rp = createRampParam(new MockAudioParam(0) as unknown as AudioParam, clock);
        setRampTarget(rp, 1, { shape: "linear", duration: 1 });
        expect(isRamping(rp)).toBe(true);
        clock._t = 2;
        expect(isRamping(rp)).toBe(false);
    });
});
