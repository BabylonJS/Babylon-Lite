import { describe, expect, it } from "vitest";

import { EasingFunction, CircleEase, CubicEase, SineEase, QuadraticEase, EASINGMODE_EASEIN, EASINGMODE_EASEOUT, EASINGMODE_EASEINOUT } from "../src/animations/easing";

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
});
