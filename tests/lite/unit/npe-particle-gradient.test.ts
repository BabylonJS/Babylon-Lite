import { describe, expect, it } from "vitest";
import { particleGradientBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-gradient-block";
import type { NpeGradientEntry } from "../../../packages/babylon-lite/src/particle/node/blocks/particle-gradient-value-block";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { NpeGetter, NpeValue } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";

describe("NPE particle gradients", () => {
    it("copies the left stop before a shared scratch getter evaluates the right stop", () => {
        const scratch: Vec3 = { x: 0, y: 0, z: 0 };
        const left: NpeGradientEntry = {
            reference: 0,
            value: () => Object.assign(scratch, { x: 1, y: 2, z: 3 }),
        };
        const right: NpeGradientEntry = {
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
        let output: NpeGetter | null = null;
        const ctx = {
            input(_block: ParsedParticleBlock, name: string): NpeGetter {
                if (name === "gradient") {
                    return () => 0.5;
                }
                const entry = name === "value0" ? left : right;
                return () => entry as unknown as NpeValue;
            },
            setOutput(_blockId: number, _name: string, getter: NpeGetter): void {
                output = getter;
            },
        } as unknown as NpeBuildContext;

        particleGradientBlock.build(block, ctx);
        expect(output).not.toBeNull();
        expect(output!(0)).toEqual({ x: 3, y: 4, z: 5 });
    });
});
