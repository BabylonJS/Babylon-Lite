import { describe, expect, it } from "vitest";

import {
    backEase,
    bezierCurveEase,
    bounceEase,
    circleEase,
    createBackEase,
    createBezierCurveEase,
    createBounceEase,
    createElasticEase,
    createExponentialEase,
    createPowerEase,
    cubicEase,
    elasticEase,
    exponentialEase,
    powerEase,
    quadraticEase,
    quarticEase,
    quinticEase,
    sineEase,
} from "../../../packages/babylon-lite/src/animation/easing";

describe("native easing", () => {
    it("evaluates the fixed ease-in curves", () => {
        expect(circleEase(0.25)).toBeCloseTo(0.031754163448145745, 14);
        expect(quadraticEase(0.25)).toBe(0.0625);
        expect(cubicEase(0.25)).toBe(0.015625);
        expect(quarticEase(0.25)).toBe(0.00390625);
        expect(quinticEase(0.25)).toBe(0.0009765625);
        expect(sineEase(0.25)).toBeCloseTo(0.07612046748871326, 14);
    });

    it("evaluates parameterized curves with Babylon.js defaults and clamping rules", () => {
        expect(powerEase(0.25)).toBe(0.0625);
        expect(powerEase(0.25, 3)).toBe(0.015625);
        expect(powerEase(0.25, -1)).toBe(1);
        expect(exponentialEase(0.25)).toBeCloseTo(0.1015363240915518, 14);
        expect(exponentialEase(0.25, 0)).toBe(0.25);
        expect(backEase(0.25)).toBeCloseTo(-0.16115169529663687, 14);
        expect(backEase(0.25, -1)).toBe(0.015625);
        expect(elasticEase(0.25)).toBeCloseTo(-0.05407096783897328, 14);
        expect(elasticEase(0.25, 3, 0)).toBeCloseTo(-0.23096988312782166, 14);
        expect(bounceEase(0.25)).toBeCloseTo(0.109375, 14);
        expect(Number.isFinite(bounceEase(0.25, 3, 1))).toBe(true);
    });

    it("evaluates cubic Bezier curves with Babylon.js endpoint and refinement behavior", () => {
        expect(bezierCurveEase(0, 0.42, 0, 0.58, 1)).toBe(0);
        expect(bezierCurveEase(0.25, 0.42, 0, 0.58, 1)).toBeCloseTo(0.12916193104731988, 14);
        expect(bezierCurveEase(0.5, 0.42, 0, 0.58, 1)).toBe(0.5);
        expect(bezierCurveEase(0.001, 0, 0, 0, 1)).toBeCloseTo(0.10672209012090668, 14);
        expect(bezierCurveEase(0.5, 0.2, 2, 0.8, 2)).toBe(1.625);
        expect(bezierCurveEase(-0.25, 0.42, 0, 0.58, 1)).toBe(0);
        expect(bezierCurveEase(1.25, 0.42, 0, 0.58, 1)).toBe(1);
        expect(bezierCurveEase(1)).toBeNaN();
    });

    it("creates property-animation callbacks with fixed parameters", () => {
        expect(createPowerEase(3)(0.5)).toBe(0.125);
        expect(createExponentialEase(0)(0.5)).toBe(0.5);
        expect(createBackEase(0)(0.5)).toBe(0.125);
        expect(createElasticEase(0, 0)(0.5)).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 14);
        expect(createBounceEase(3, 2)(0.25)).toBeCloseTo(bounceEase(0.25), 14);
        expect(createBezierCurveEase(0.42, 0, 0.58, 1)(0.25)).toBeCloseTo(0.12916193104731988, 14);
    });
});
