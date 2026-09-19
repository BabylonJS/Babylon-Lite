import { describe, expect, it } from "vitest";

import { DirectionalLight, HemisphericLight, PointLight, SpotLight } from "../src/lights/lights";
import { Color3 } from "../src/math/color";
import { Vector3 } from "../src/math/vector";
import { TransformNode } from "../src/meshes/meshes";

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

    it("inherits parent state without overwriting its local enabled flag", () => {
        const parent = new TransformNode("parent");
        const light = new DirectionalLight("d", new Vector3(0, -1, 0));
        light.intensity = 0.8;
        light.parent = parent;

        parent.setEnabled(false);
        expect(light.isEnabled(false)).toBe(true);
        expect(light.isEnabled()).toBe(false);
        expect(light.intensity).toBeCloseTo(0.8);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(false);
        parent.setEnabled(true);
        expect(light.isEnabled(false)).toBe(false);
        expect(light._lite.intensity).toBe(0);

        light.setEnabled(true);
        expect(light._lite.intensity).toBeCloseTo(0.8);
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

describe("Light vectors and colours are live objects, as in Babylon.js", () => {
    // Babylon.js hands out the light's own Vector3 / Color3, and apps edit them in place
    // (`sun.direction.set(...)`, `fill.specular.copyFrom(Color3.Black())`). The getters used to return
    // copies, so those edits were silently dropped and the light kept its constructor values.
    function lightVersion(light: { _lite: unknown }): number {
        return (light._lite as { _lightVersion?: number })._lightVersion ?? 0;
    }

    it("writes an in-place direction edit through to the Lite light", () => {
        const sun = new DirectionalLight("sun", new Vector3(3, -2, 3));
        sun.direction.set(2.2, -3, 1.6);
        expect([sun._lite.direction.x, sun._lite.direction.y, sun._lite.direction.z]).toEqual([2.2, -3, 1.6]);
        sun.direction.y = -1;
        expect(sun._lite.direction.y).toBe(-1);
        // Same object on every read, and it keeps tracking the Lite vector.
        expect(sun.direction).toBe(sun.direction);
        sun._lite.direction.set(0, -1, 0);
        expect(sun.direction.y).toBe(-1);
        expect(sun.direction.x).toBe(0);
    });

    it("writes an in-place position edit through for directional, point and spot lights", () => {
        const lights = [
            new DirectionalLight("d", new Vector3(0, -1, 0)),
            new PointLight("p", new Vector3(0, 0, 0)),
            new SpotLight("s", new Vector3(0, 0, 0), new Vector3(0, -1, 0), Math.PI / 4, 2),
        ];
        for (const light of lights) {
            light.position.set(1, 2, 3);
            expect([light._lite.position.x, light._lite.position.y, light._lite.position.z]).toEqual([1, 2, 3]);
        }
    });

    it("writes in-place colour edits through and publishes them to the lights UBO", () => {
        const fill = new HemisphericLight("fill", new Vector3(0, 1, 0));
        const before = lightVersion(fill);
        fill.specular.copyFrom(new Color3(0, 0, 0));
        fill.groundColor.set(0.1, 0.2, 0.3);
        fill.diffuse.r = 0.5;
        expect(fill._lite.specularColor).toEqual([0, 0, 0]);
        expect(fill._lite.groundColor).toEqual([0.1, 0.2, 0.3]);
        expect(fill._lite.diffuseColor[0]).toBe(0.5);
        // A tuple write cannot notify Lite, so the wrapper has to bump the version itself.
        expect(lightVersion(fill)).toBeGreaterThan(before);
        expect(fill.diffuse).toBe(fill.diffuse);

        const sun = new DirectionalLight("sun", new Vector3(0, -1, 0));
        const sunBefore = lightVersion(sun);
        sun.diffuse = new Color3(1, 0.9, 0.8);
        expect(sun._lite.diffuse).toEqual([1, 0.9, 0.8]);
        expect(lightVersion(sun)).toBeGreaterThan(sunBefore);
    });
});
