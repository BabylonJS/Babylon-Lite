import { describe, expect, it } from "vitest";

import { DirectionalLight, HemisphericLight, PointLight, SpotLight } from "../src/lights/lights";
import { Node } from "../src/node/node";
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

describe("Light enabled state tracks ancestors", () => {
    /** Minimal parent node — lights only need something with an enabled flag above them. */
    class Holder extends Node {
        public constructor(name: string) {
            super(name);
        }
    }

    it("zeroes intensity when an ancestor is disabled and restores it when re-enabled", () => {
        const root = new Holder("root");
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        light.intensity = 0.8;
        light.parent = root;

        root.setEnabled(false);
        expect(light.isEnabled()).toBe(false);
        expect(light._lite.intensity).toBe(0);
        expect(light.intensity).toBeCloseTo(0.8);

        root.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.8);
    });

    it("keeps a light dark after its ancestor is re-enabled if the light was disabled meanwhile", () => {
        // Regression: keying the intensity swap off the ancestor-aware `isEnabled()` made
        // this a no-op, so the light stayed at full intensity and lit the scene again as
        // soon as the ancestor came back — despite being logically disabled.
        const root = new Holder("root");
        const light = new PointLight("p", new Vector3(0, 1, 0));
        light.intensity = 1;
        light.parent = root;

        root.setEnabled(false);
        light.setEnabled(false);
        root.setEnabled(true);

        expect(light.isEnabled(false)).toBe(false);
        expect(light._lite.intensity).toBe(0);
    });

    it("does not light up when enabled underneath a disabled ancestor", () => {
        const root = new Holder("root");
        const light = new SpotLight("s", new Vector3(0, 5, 0), new Vector3(0, -1, 0), Math.PI / 4, 2);
        light.intensity = 0.5;
        light.parent = root;

        light.setEnabled(false);
        root.setEnabled(false);
        light.setEnabled(true);

        // Own flag is back on, but the ancestor still gates it.
        expect(light.isEnabled(false)).toBe(true);
        expect(light.isEnabled()).toBe(false);
        expect(light._lite.intensity).toBe(0);

        root.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.5);
    });

    it("reparenting under a disabled node zeroes the light", () => {
        const off = new Holder("off");
        off.setEnabled(false);
        const light = new HemisphericLight("h", new Vector3(0, 1, 0));
        light.intensity = 0.7;

        light.parent = off;
        expect(light._lite.intensity).toBe(0);

        light.parent = null;
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
