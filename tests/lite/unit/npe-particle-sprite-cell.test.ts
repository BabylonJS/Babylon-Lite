import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { buildNodeParticleSet } from "../../../packages/babylon-lite/src/particle/node/npe-build";
import { makeExtraContextualGetter } from "../../../packages/babylon-lite/src/particle/node/npe-contextual-extra";
import { parseNodeParticleSource } from "../../../packages/babylon-lite/src/particle/node/npe-parser";
import { column, spawnParticle } from "../../../packages/babylon-lite/src/particle/particle-buffer";
import { animateParticleSystem, createParticleSystem, startParticleSystem, type ParticleSystem } from "../../../packages/babylon-lite/src/particle/particle-system";

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

async function build(blocks: GraphBlock[], lastId: number, extraSystemInputs: Record<string, unknown>[] = [], capacity = 4): Promise<ParticleSystem> {
    const system = { customType: "BABYLON.SystemBlock", id: 99, capacity, inputs: [particle(lastId), ...extraSystemInputs] };
    const set = await buildNodeParticleSet({} as EngineContext, {} as SceneContext, parseNodeParticleSource({ blocks: [...blocks, system] }));
    return set.systems[0]!;
}

function connect(name: string, targetBlockId: number): Record<string, unknown> {
    return { name, targetBlockId, targetConnectionName: "output" };
}

function floatInput(id: number, value: number): GraphBlock {
    return { customType: "BABYLON.ParticleInputBlock", id, type: 0x0002, value, inputs: [] };
}

const cellSource = (id: number): GraphBlock => ({ customType: "BABYLON.ParticleInputBlock", id, contextualValue: CTX_SPRITE_CELL_INDEX, inputs: [] });
// The creation-time size reads the cell, so a stale reused slot would leak into the new particle's size.
const createSizedByCell: GraphBlock = { customType: "BABYLON.CreateParticleBlock", id: 1, inputs: [connect("lifeTime", 10), connect("size", 11)] };
const sizedByCellInputs = [floatInput(10, 0.75), cellSource(11), cellValue];

describe("NPE sprite-cell values", () => {
    it.each([
        { name: "without a sprite sheet", blocks: [...sizedByCellInputs, createSizedByCell, updateCellIndex(3, 1)], start: 0 },
        { name: "with a sprite sheet built after the update", blocks: [...sizedByCellInputs, createSizedByCell, updateCellIndex(3, 1), setupSheet(4, 3)], start: 2 },
        { name: "with a sprite sheet built before the update", blocks: [...sizedByCellInputs, createSizedByCell, setupSheet(3, 1), updateCellIndex(4, 3)], start: 2 },
    ])("resets a reused slot's cell before the creation getters read it $name", async ({ blocks, start }) => {
        const system = await build(blocks, blocks.at(-1)!.id as number, [], 1);
        system.emitRate = 2;
        system.updateSpeed = 0.5;
        const buffer = system.buffer;
        const cellIndex = column(buffer, "sprite.cellIndex", Int32Array);
        startParticleSystem(system);

        animateParticleSystem(system, 1);
        expect([buffer.alive, buffer.size[0], cellIndex[0]]).toEqual([1, start, start]);

        animateParticleSystem(system, 1);
        expect(cellIndex[0]).toBe(3);

        // The particle dies at 0.75 and a new one spawns into the same slot, which still holds the floored cell.
        animateParticleSystem(system, 1);
        expect([buffer.alive, buffer.age[0], buffer.size[0], cellIndex[0]]).toEqual([1, 0, start, start]);
    });

    it("keeps signed cell intermediates between chained updates like Babylon.js", async () => {
        const next = { customType: "BABYLON.ParticleMathBlock", id: 24, operation: 0, inputs: [connect("left", 23), connect("right", 21)] };
        const wrapped = { customType: "BABYLON.ParticleNumberMathBlock", id: 25, operation: 0, inputs: [connect("left", 24), connect("right", 22)] };
        const first = { customType: "BABYLON.UpdateSpriteCellIndexBlock", id: 3, inputs: [particle(1), connect("cellIndex", 20)] };
        const second = { customType: "BABYLON.UpdateSpriteCellIndexBlock", id: 4, inputs: [particle(3), connect("cellIndex", 25)] };
        const system = await build([create, floatInput(20, -1), floatInput(21, 1), floatInput(22, 10), cellSource(23), next, wrapped, first, second], 4);
        const cellIndex = column(system.buffer, "sprite.cellIndex", Int32Array);

        const i = spawnParticle(system.buffer);
        for (const step of system.updateSteps) {
            step(i);
        }
        // (-1 + 1) % 10 is 0; an unsigned column would wrap -1 to 65535 and produce 6.
        expect(cellIndex[i]).toBe(0);
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

        const cellIndex = column(system.buffer, "sprite.cellIndex", Int32Array);
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
