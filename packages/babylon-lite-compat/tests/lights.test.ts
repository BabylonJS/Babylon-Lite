import { describe, expect, it } from "vitest";

import { DirectionalLight, HemisphericLight, PointLight, SpotLight } from "../src/lights/lights";
import { Vector3 } from "../src/math/vector";

/**
 * The light wrappers forward to Babylon Lite's device-free light factories, so
 * their scalar/color proxying and the `setEnabled` visibility toggle can be
 * exercised under Node without a GPU. `setEnabled(false)` has no per-light flag
 * in Lite, so the wrapper zeroes the underlying intensity while preserving the
 * caller-visible value — this test pins that behaviour.
 */

describe("Light.setEnabled visibility toggle", () => {
    it("zeroes the Lite intensity when disabled and restores it when enabled", () => {
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        light.intensity = 0.8;
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBeCloseTo(0.8);

        light.setEnabled(false);
        expect(light.isEnabled()).toBe(false);
        // Caller-visible intensity is preserved; the Lite light contributes nothing.
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(true);
        expect(light.isEnabled()).toBe(true);
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBeCloseTo(0.8);
    });

    it("remembers intensity changes made while disabled", () => {
        const light = new PointLight("p", new Vector3(0, 1, 0));
        light.intensity = 1;
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);

        light.intensity = 2.5;
        // Still contributes nothing while disabled, but the value is remembered.
        expect(light._lite.intensity).toBe(0);
        expect(light.intensity).toBeCloseTo(2.5);

        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(2.5);
    });

    it("is idempotent for repeated toggles of the same state", () => {
        const light = new SpotLight("s", new Vector3(0, 5, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        light.intensity = 0.5;
        light.setEnabled(false);
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);
        expect(light.intensity).toBeCloseTo(0.5);
        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.5);
    });

    it("supports the hemispheric light too", () => {
        const light = new HemisphericLight("h", new Vector3(0, 1, 0));
        light.intensity = 0.7;
        light.setEnabled(false);
        expect(light._lite.intensity).toBe(0);
        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.7);
    });
});

describe("Light intensity writes bump the Lite light version", () => {
    // Lite's shared lights-UBO refresh is gated on the sum of each light's
    // `_lightVersion`; factory lights don't bump it on scalar `intensity` writes,
    // so the wrapper must, or intensity/enable changes never reach the GPU.
    function lightVersion(light: { _lite: unknown }): number {
        return (light._lite as { _lightVersion?: number })._lightVersion ?? 0;
    }

    it("advances _lightVersion on an intensity change", () => {
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        const before = lightVersion(light);
        light.intensity = 0.4;
        expect(lightVersion(light)).toBeGreaterThan(before);
    });

    it("advances _lightVersion on setEnabled(false) then setEnabled(true)", () => {
        const light = new PointLight("p", new Vector3(1, 1, 1));
        light.intensity = 1;
        const afterIntensity = lightVersion(light);
        light.setEnabled(false);
        expect(lightVersion(light)).toBeGreaterThan(afterIntensity);
        const afterDisable = lightVersion(light);
        light.setEnabled(true);
        expect(lightVersion(light)).toBeGreaterThan(afterDisable);
    });

    it("advances _lightVersion for the spot light too", () => {
        const light = new SpotLight("s", new Vector3(0, 0, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        const before = lightVersion(light);
        light.intensity = 3;
        expect(lightVersion(light)).toBeGreaterThan(before);
    });
});
