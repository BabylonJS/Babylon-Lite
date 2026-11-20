import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { makeExtraContextualGetter } from "../../../packages/babylon-lite/src/particle/node/npe-contextual-extra";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { column, spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { createParticleSystem, type ParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";

const CTX_SPRITE_CELL_INDEX = 0x0010;
const CTX_SPRITE_CELL_START = 0x0011;
const CTX_SPRITE_CELL_END = 0x0012;

type GraphBlock = Record<string, unknown>;

function particle(targetBlockId: number): Record<string, unknown> {
    return { name: "particle", targetBlockId, targetConnectionName: targetBlockId === 1 ? "particle" : "output" };
}

const create: GraphBlock = { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [] };
const cellValue: GraphBlock = { customType: "BABYLON.ParticleInputBlock", id: 2, type: 0x0002, value: 3.7, inputs: [] };

function updateCellIndex(id: number, particleSource: number): GraphBlock {
    return { customType: "BABYLON.UpdateSpriteCellIndexBlock", id, inputs: [particle(particleSource), { name: "cellIndex", targetBlockId: 2, targetConnectionName: "output" }] };
}

function setupSheet(id: number, particleSource: number): GraphBlock {
    return { customType: "BABYLON.SetupSpriteSheetBlock", id, start: 2, end: 5, width: 64, height: 64, inputs: [particle(particleSource)] };
}

async function build(blocks: GraphBlock[], lastId: number, extraSystemInputs: Record<string, unknown>[] = []): Promise<ParticleSystem> {
    const system = { customType: "BABYLON.SystemBlock", id: 99, capacity: 4, inputs: [particle(lastId), ...extraSystemInputs] };
    const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource({ blocks: [...blocks, system] }));
    return set.systems[0]!;
}

/** Spawn one particle into a slot holding stale cell data and run the creation slots in their fixed order. */
function spawnWithStaleCell(system: ParticleSystem): number {
    const cellIndex = column(system.buffer, "sprite.cellIndex", Uint16Array);
    const i = spawnParticle(system.buffer);
    cellIndex[i] = 9;
    for (const slot of [
        system.createLifeTime,
        system.createPosition,
        system.createDirection,
        system.createEmitPower,
        system.createSize,
        system.createAngle,
        system.createColor,
        system.createColorDead,
    ]) {
        slot?.(i);
    }
    return i;
}

describe("NPE sprite-cell values", () => {
    it("resets the cell at birth and floors cellIndex at the end of the update queue without a sprite sheet", async () => {
        const system = await build([create, cellValue, updateCellIndex(3, 1)], 3);
        const cellIndex = column(system.buffer, "sprite.cellIndex", Uint16Array);
        expect(system._spriteSheet).toBeUndefined();

        const i = spawnWithStaleCell(system);
        expect(cellIndex[i]).toBe(0);
        system.updateSteps.at(-1)!(i);
        expect(cellIndex[i]).toBe(3);
    });

    it.each([
        { name: "a sprite sheet built after it", blocks: [create, cellValue, updateCellIndex(3, 1), setupSheet(4, 3)], lastId: 4 },
        {
            name: "a sprite sheet and BasicSpriteUpdateBlock built before it",
            blocks: [create, cellValue, setupSheet(3, 1), { customType: "BABYLON.BasicSpriteUpdateBlock", id: 4, inputs: [particle(3)] }, updateCellIndex(5, 4)],
            lastId: 5,
        },
    ])("starts at the sheet start cell and overrides the cell each update with $name", async ({ blocks, lastId }) => {
        const system = await build(blocks, lastId);
        const cellIndex = column(system.buffer, "sprite.cellIndex", Uint16Array);
        expect(system._spriteSheet?.cellIndex).toBe(cellIndex);

        const i = spawnWithStaleCell(system);
        expect(cellIndex[i]).toBe(2);
        for (const step of system.updateSteps) {
            step(i);
        }
        expect(cellIndex[i]).toBe(3);
    });

    it("leaves the cell column untouched when cellIndex is unconnected", async () => {
        const system = await build([create, { customType: "BABYLON.UpdateSpriteCellIndexBlock", id: 3, inputs: [particle(1)] }], 3);
        expect(system.buffer._columns.has("sprite.cellIndex")).toBe(false);
        expect(system.updateSteps).toHaveLength(0);
    });

    it("reads the cell column per particle and the sheet range lazily", () => {
        const system = createParticleSystem(2);
        const index = makeExtraContextualGetter(system.buffer, system, CTX_SPRITE_CELL_INDEX);
        const start = makeExtraContextualGetter(system.buffer, system, CTX_SPRITE_CELL_START);
        const end = makeExtraContextualGetter(system.buffer, system, CTX_SPRITE_CELL_END);
        expect([start(0), end(0)]).toEqual([0, 0]);

        const cellIndex = column(system.buffer, "sprite.cellIndex", Uint16Array);
        cellIndex[1] = 7;
        system._spriteSheet = { cellWidth: 1, cellHeight: 1, startCellID: 2, endCellID: 5, cellIndex, update: () => {} };
        expect([index(1), start(0), end(0)]).toEqual([7, 2, 5]);
    });

    it("types sprite-cell contextual sources as Int", async () => {
        const end = { customType: "BABYLON.ParticleInputBlock", id: 5, contextualValue: CTX_SPRITE_CELL_END, inputs: [] };
        const half = { customType: "BABYLON.ParticleInputBlock", id: 6, type: 0x0002, value: 0.5, inputs: [] };
        const pow = {
            customType: "BABYLON.ParticleNumberMathBlock",
            id: 7,
            operation: 1,
            inputs: [
                { name: "left", targetBlockId: 5, targetConnectionName: "output" },
                { name: "right", targetBlockId: 6, targetConnectionName: "output" },
            ],
        };
        const system = await build([create, setupSheet(3, 1), end, half, pow], 3, [{ name: "targetStopDuration", targetBlockId: 7, targetConnectionName: "output" }]);
        expect(system.targetStopDuration).toBe(2);
    });
});
