import { describe, expect, it } from "vitest";
import { updateAttractorBlock } from "../../../packages/babylon-lite/src/particle/node/blocks/update-attractor-block";
import { createParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";
import type { NpeBuildContext } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import type { NpeGetter } from "../../../packages/babylon-lite/src/particle/node/npe-value";
import type { ParsedParticleBlock } from "../../../packages/babylon-lite/src/particle/node/npe-types";
import type { Vec3 } from "../../../packages/babylon-lite/src/math/types";
import { buildNodeParticleGraph } from "./particle-test-utils";

interface AttractorGraphOptions {
    attractor?: [number, number, number];
    strength?: number;
}

function attractorGraph(options: AttractorGraphOptions = {}): unknown {
    const attractorInput = options.attractor === undefined ? { name: "attractor" } : { name: "attractor", valueType: "BABYLON.Vector3", value: options.attractor };
    const strengthInput = options.strength === undefined ? { name: "strength" } : { name: "strength", valueType: "number", value: options.strength };

    return {
        blocks: [
            {
                customType: "BABYLON.SystemBlock",
                id: 4,
                inputs: [{ name: "particle", targetBlockId: 3, targetConnectionName: "output" }],
                capacity: 4,
            },
            {
                customType: "BABYLON.UpdateAttractorBlock",
                id: 3,
                inputs: [{ name: "particle", targetBlockId: 2, targetConnectionName: "output" }, attractorInput, strengthInput],
            },
            {
                customType: "BABYLON.PointShapeBlock",
                id: 2,
                inputs: [{ name: "particle", targetBlockId: 1, targetConnectionName: "output" }],
            },
            {
                customType: "BABYLON.CreateParticleBlock",
                id: 1,
                inputs: [],
            },
        ],
    };
}

describe("NPE UpdateAttractorBlock", () => {
    it("applies softened inverse-square attraction with the clamped particle step", async () => {
        const system = await buildNodeParticleGraph(attractorGraph({ attractor: [0, 0, 0], strength: 8 }));
        const buffer = system.buffer;
        buffer.posX[0] = 3;
        buffer.dirX[0] = 1;
        system._scaledStep = 0.25;

        system.updateSteps[0]!(0);

        expect(buffer.dirX[0]).toBeCloseTo(0.8, 7);
        expect(buffer.dirY[0]).toBe(0);
        expect(buffer.dirZ[0]).toBe(0);
    });

    it("supports negative strength, defaults, and a coincident attractor", async () => {
        const repulsion = await buildNodeParticleGraph(attractorGraph({ attractor: [0, 0, 0], strength: -8 }));
        repulsion.buffer.posX[0] = 3;
        repulsion._scaledStep = 0.25;
        repulsion.updateSteps[0]!(0);
        expect(repulsion.buffer.dirX[0]).toBeCloseTo(0.2, 7);

        const defaults = await buildNodeParticleGraph(attractorGraph());
        defaults.buffer.posX[0] = 1;
        defaults._scaledStep = 1;
        defaults.updateSteps[0]!(0);
        expect(defaults.buffer.dirX[0]).toBeCloseTo(-0.5, 7);

        defaults.buffer.dirX[0] = 2;
        defaults.buffer.posX[0] = 0;
        defaults.updateSteps[0]!(0);
        expect(defaults.buffer.dirX[0]).toBe(2);
    });

    it("copies a scratch-backed attractor before evaluating strength", () => {
        const system = createParticleSystem(1);
        const scratch: Vec3 = { x: 3, y: 0, z: 0 };
        const block = { id: 1, className: "UpdateAttractorBlock", name: "attractor", inputs: [], serialized: {} } as ParsedParticleBlock;
        const ctx = {
            state: { system, buffer: system.buffer },
            input(_block: ParsedParticleBlock, name: string): NpeGetter {
                if (name === "attractor") {
                    return () => scratch;
                }
                return () => {
                    scratch.x = 100;
                    return 8;
                };
            },
        } as unknown as NpeBuildContext;
        system._scaledStep = 0.25;

        updateAttractorBlock.build(block, ctx);
        system.updateSteps[0]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(0.2, 7);
    });

    it("runs multiple attractors and intervening updates in graph order", async () => {
        const graph = attractorGraph({ attractor: [3, 0, 0], strength: 8 }) as {
            blocks: Array<{ customType: string; id: number; inputs: Array<Record<string, unknown>> }>;
        };
        const systemBlock = graph.blocks.find((block) => block.customType === "BABYLON.SystemBlock")!;
        const firstAttractor = graph.blocks.find((block) => block.customType === "BABYLON.UpdateAttractorBlock")!;
        const positionInputId = 5;
        const updatePositionId = 6;
        const secondId = 7;
        systemBlock.inputs[0]!.targetBlockId = secondId;
        graph.blocks.push(
            {
                customType: "BABYLON.ParticleInputBlock",
                id: positionInputId,
                inputs: [],
                type: 8,
                contextualValue: 0,
                systemSource: 0,
                valueType: "BABYLON.Vector3",
                value: [0, 1, 0],
            } as (typeof graph.blocks)[number],
            {
                customType: "BABYLON.UpdatePositionBlock",
                id: updatePositionId,
                inputs: [
                    { name: "particle", targetBlockId: firstAttractor.id, targetConnectionName: "output" },
                    { name: "position", targetBlockId: positionInputId, targetConnectionName: "output" },
                ],
            },
            {
                customType: "BABYLON.UpdateAttractorBlock",
                id: secondId,
                inputs: [
                    { name: "particle", targetBlockId: updatePositionId, targetConnectionName: "output" },
                    { name: "attractor", valueType: "BABYLON.Vector3", value: [0, 4, 0] },
                    { name: "strength", valueType: "number", value: 15 },
                ],
            }
        );
        const system = await buildNodeParticleGraph(graph);
        system._scaledStep = 0.25;

        system.updateSteps[0]!(0);
        system.updateSteps[1]!(0);
        system.updateSteps[2]!(0);

        expect(system.buffer.dirX[0]).toBeCloseTo(0.2, 7);
        expect(system.buffer.posY[0]).toBe(1);
        expect(system.buffer.dirY[0]).toBeCloseTo(0.375, 7);
    });
});
