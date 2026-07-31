import { describe, expect, it } from "vitest";
import { createOnceRandomGetter } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-random-once";
import { createTypedOnceRandomGetter } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-random-once-typed";
import { createParticleBuffer } from "../../../packages/babylon-lite/src/particle/particle-buffer";

describe("OncePerParticle random cache", () => {
    it("caches id 0xffffffff and redraws exactly once when a slot receives a new id", () => {
        const buffer = createParticleBuffer(1);
        let draws = 0;
        const getter = createOnceRandomGetter(buffer, 7, () => ++draws);

        buffer.id[0] = 0xffffffff;
        expect(getter(0)).toBe(1);
        expect(getter(0)).toBe(1);
        expect(draws).toBe(1);

        buffer.id[0] = 0;
        expect(getter(0)).toBe(2);
        expect(getter(0)).toBe(2);
        expect(draws).toBe(2);
    });

    it.each([
        ["BABYLON.Vector2", { x: 1, y: 2 }],
        ["BABYLON.Vector3", { x: 1, y: 2, z: 3 }],
        ["BABYLON.Color4", { r: 1, g: 2, b: 3, a: 4 }],
    ])("caches %s values by component", (valueType, expected) => {
        const buffer = createParticleBuffer(1);
        let draws = 0;
        const getter = createTypedOnceRandomGetter(
            buffer,
            8,
            () => {
                draws++;
                return expected;
            },
            valueType
        );

        buffer.id[0] = 4;
        expect(getter(0)).toEqual(expected);
        expect(getter(0)).toEqual(expected);
        expect(draws).toBe(1);

        buffer.id[0] = 5;
        expect(getter(0)).toEqual(expected);
        expect(draws).toBe(2);
    });
});
