import { describe, expect, it } from "vitest";
import { particleMathBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-math-block";
import { createRandomDraw } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-random-block";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { NpeGetter } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

describe("NPE scratch-backed value operands", () => {
    it("copies the left math operand before a shared scratch getter evaluates the right", () => {
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        const block = { id: 1, className: "ParticleMathBlock", name: "add", serialized: { operation: 0 }, inputs: [] } as unknown as ParsedParticleBlock;
        let output: NpeGetter | null = null;
        const ctx = {
            input(_block: ParsedParticleBlock, name: string): NpeGetter {
                return name === "left" ? () => Object.assign(scratch, { x: 1, y: 2, z: 3 }) : () => Object.assign(scratch, { x: 4, y: 5, z: 6 });
            },
            setOutput(_blockId: number, _name: string, getter: NpeGetter): void {
                output = getter;
            },
        } as unknown as NpeBuildContext;

        particleMathBlock.build(block, ctx);
        expect(output!(0)).toEqual({ x: 5, y: 7, z: 9 });
    });

    it("copies random minimum components before a shared scratch getter evaluates the maximum", () => {
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        const previousRandom = Math.random;
        Math.random = () => 0.5;
        try {
            const draw = createRandomDraw(
                () => Object.assign(scratch, { x: 1, y: 2, z: 3 }),
                () => Object.assign(scratch, { x: 5, y: 6, z: 7 })
            );
            expect(draw(0)).toEqual({ x: 3, y: 4, z: 5 });
        } finally {
            Math.random = previousRandom;
        }
    });
});
