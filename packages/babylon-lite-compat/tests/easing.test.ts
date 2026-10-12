import { describe, expect, it } from "vitest";

import {
    BackEase,
    BezierCurveEase,
    BounceEase,
    CircleEase,
    CubicEase,
    EasingFunction,
    ElasticEase,
    ExponentialEase,
    PowerEase,
    QuadraticEase,
    QuarticEase,
    QuinticEase,
    SineEase,
    EASINGMODE_EASEIN,
    EASINGMODE_EASEOUT,
    EASINGMODE_EASEINOUT,
} from "../src/animations/easing";

describe("EasingFunction", () => {
    it("anchors at the endpoints for ease-in", () => {
        const ease = new CubicEase();
        ease.setEasingMode(EASINGMODE_EASEIN);
        expect(ease.ease(0)).toBeCloseTo(0, 6);
        expect(ease.ease(1)).toBeCloseTo(1, 6);
    });

    it("mirrors ease-out from ease-in", () => {
        const ease = new QuadraticEase();
        ease.setEasingMode(EASINGMODE_EASEOUT);
        // ease-out of quadratic: 1 - (1-g)^2 → at 0.5 gives 0.75
        expect(ease.ease(0.5)).toBeCloseTo(0.75, 6);
    });

    it("is symmetric for ease-in-out at the midpoint", () => {
        const ease = new SineEase();
        ease.setEasingMode(EASINGMODE_EASEINOUT);
        expect(ease.ease(0.5)).toBeCloseTo(0.5, 6);
        expect(ease.ease(0)).toBeCloseTo(0, 6);
        expect(ease.ease(1)).toBeCloseTo(1, 6);
    });

    it("circle ease curves below the linear line on ease-in", () => {
        const ease = new CircleEase();
        ease.setEasingMode(EASINGMODE_EASEIN);
        expect(ease.ease(0.5)).toBeLessThan(0.5);
    });

    it("exposes Babylon.js static easing-mode constants", () => {
        expect(EasingFunction.EASINGMODE_EASEIN).toBe(0);
        expect(EasingFunction.EASINGMODE_EASEOUT).toBe(1);
        expect(EasingFunction.EASINGMODE_EASEINOUT).toBe(2);
    });

    it("delegates every Babylon.js ease-in curve to native Lite math", () => {
        expect(new CircleEase().easeInCore(0.25)).toBeCloseTo(0.031754163448145745, 14);
        expect(new QuadraticEase().easeInCore(0.25)).toBe(0.0625);
        expect(new CubicEase().easeInCore(0.25)).toBe(0.015625);
        expect(new QuarticEase().easeInCore(0.25)).toBe(0.00390625);
        expect(new QuinticEase().easeInCore(0.25)).toBe(0.0009765625);
        expect(new SineEase().easeInCore(0.25)).toBeCloseTo(0.07612046748871326, 14);
        expect(new ExponentialEase().easeInCore(0.25)).toBeCloseTo(0.1015363240915518, 14);
        expect(new BackEase().easeInCore(0.25)).toBeCloseTo(-0.16115169529663687, 14);
        expect(new ElasticEase().easeInCore(0.25)).toBeCloseTo(-0.05407096783897328, 14);
        expect(new BounceEase().easeInCore(0.25)).toBeCloseTo(0.109375, 14);
        expect(new PowerEase(3).easeInCore(0.25)).toBe(0.015625);
        expect(new BezierCurveEase(0.42, 0, 0.58, 1).easeInCore(0.25)).toBeCloseTo(0.12916193104731988, 14);
    });

    it("preserves mutable Babylon.js constructor properties and defaults", () => {
        const power = new PowerEase();
        expect(power.power).toBe(2);
        power.power = 4;
        expect(power.easeInCore(0.5)).toBe(0.0625);

        const exponential = new ExponentialEase();
        expect(exponential.exponent).toBe(2);
        exponential.exponent = 0;
        expect(exponential.easeInCore(0.5)).toBe(0.5);

        const back = new BackEase();
        expect(back.amplitude).toBe(1);
        back.amplitude = 0;
        expect(back.easeInCore(0.5)).toBe(0.125);

        const elastic = new ElasticEase();
        expect([elastic.oscillations, elastic.springiness]).toEqual([3, 3]);
        elastic.oscillations = 0;
        elastic.springiness = 0;
        expect(elastic.easeInCore(0.5)).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 14);

        const bounce = new BounceEase();
        expect([bounce.bounces, bounce.bounciness]).toEqual([3, 2]);
        bounce.bounciness = 1;
        expect(Number.isFinite(bounce.easeInCore(0.25))).toBe(true);

        const bezier = new BezierCurveEase();
        expect([bezier.x1, bezier.y1, bezier.x2, bezier.y2]).toEqual([0, 0, 1, 1]);
        expect(bezier.easeInCore(0)).toBe(0);
        expect(bezier.easeInCore(1)).toBeNaN();
        bezier.x1 = 0.42;
        bezier.x2 = 0.58;
        expect(bezier.easeInCore(0.5)).toBe(0.5);
    });
});
