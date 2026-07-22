import { describe, expect, it } from "vitest";
import { particleGradientBlock } from "../../../packages/babylon-lite/src/particle/soa/blocks/particle-gradient-block";
import type { SoaGradientEntry } from "../../../packages/babylon-lite/src/particle/soa/blocks/particle-gradient-value-block";
import type { SoaBuildContext } from "../../../packages/babylon-lite/src/particle/soa/npe-build";
import type { SoaGetter, SoaValue } from "../../../packages/babylon-lite/src/particle/soa/value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

describe("SoA particle gradients", () => {
    it("copies the left stop before a shared scratch getter evaluates the right stop", () => {
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        const left: SoaGradientEntry = {
            reference: 0,
            value: () => Object.assign(scratch, { x: 1, y: 2, z: 3 }),
        };
        const right: SoaGradientEntry = {
            reference: 1,
            value: () => Object.assign(scratch, { x: 5, y: 6, z: 7 }),
        };
        const block = {
            id: 1,
            className: "ParticleGradientBlock",
            name: "gradient",
            serialized: {},
            inputs: [
                { name: "gradient", targetBlockId: null, targetConnectionName: null },
                { name: "value0", targetBlockId: 2, targetConnectionName: "output" },
                { name: "value1", targetBlockId: 3, targetConnectionName: "output" },
            ],
        } as ParsedParticleBlock;
        let output: SoaGetter | null = null;
        const ctx = {
            input(_block: ParsedParticleBlock, name: string): SoaGetter {
                if (name === "gradient") {
                    return () => 0.5;
                }
                const entry = name === "value0" ? left : right;
                return () => entry as unknown as SoaValue;
            },
            setOutput(_blockId: number, _name: string, getter: SoaGetter): void {
                output = getter;
            },
        } as unknown as SoaBuildContext;

        particleGradientBlock.build(block, ctx);
        expect(output).not.toBeNull();
        expect(output!(0)).toEqual({ x: 3, y: 4, z: 5 });
    });
});
