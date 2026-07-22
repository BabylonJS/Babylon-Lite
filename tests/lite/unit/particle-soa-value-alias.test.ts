import { describe, expect, it } from "vitest";
import { particleMathBlock } from "../../../packages/babylon-lite/src/particle/soa/blocks/particle-math-block";
import { createRandomDraw } from "../../../packages/babylon-lite/src/particle/soa/blocks/particle-random-block";
import type { SoaBuildContext } from "../../../packages/babylon-lite/src/particle/soa/npe-build";
import type { SoaGetter } from "../../../packages/babylon-lite/src/particle/soa/value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

describe("SoA scratch-backed value operands", () => {
    it("copies the left math operand before a shared scratch getter evaluates the right", () => {
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        const block = { id: 1, className: "ParticleMathBlock", name: "add", serialized: { operation: 0 }, inputs: [] } as unknown as ParsedParticleBlock;
        let output: SoaGetter | null = null;
        const ctx = {
            input(_block: ParsedParticleBlock, name: string): SoaGetter {
                return name === "left" ? () => Object.assign(scratch, { x: 1, y: 2, z: 3 }) : () => Object.assign(scratch, { x: 4, y: 5, z: 6 });
            },
            setOutput(_blockId: number, _name: string, getter: SoaGetter): void {
                output = getter;
            },
        } as unknown as SoaBuildContext;

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
