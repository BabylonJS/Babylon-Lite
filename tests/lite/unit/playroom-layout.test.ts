import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAYROOM_LAYOUT } from "../../../lab/lite/src/demos/playroom/layout.js";
import { createPuzzleRandom, expandPuzzle } from "../../../lab/lite/src/demos/playroom/puzzles.js";
import type { PuzzleTemplateBounds } from "../../../lab/lite/src/demos/playroom/puzzles.js";
import { boxColliderForModel } from "../../../lab/lite/src/demos/playroom/world.js";

function bakedBounds(file: string, scale: readonly [number, number, number]) {
    const bytes = readFileSync(resolve(process.cwd(), "lab", "public", "playroom", "gltf", file));
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(
        bytes
            .subarray(20, 20 + jsonLength)
            .toString("utf8")
            .trimEnd()
    );
    const accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION] as { min: number[]; max: number[] };
    const minimum = [-accessor.max[0]! * scale[0], accessor.min[1]! * scale[1], accessor.min[2]! * scale[2]] as const;
    const maximum = [-accessor.min[0]! * scale[0], accessor.max[1]! * scale[1], accessor.max[2]! * scale[2]] as const;
    return {
        center: [(minimum[0] + maximum[0]) * 0.5, (minimum[1] + maximum[1]) * 0.5, (minimum[2] + maximum[2]) * 0.5] as const,
        extents: [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]] as const,
    };
}

const placementBounds = {
    cup: { collisionBounds: bakedBounds("cup.glb", [0.2, 0.2, 0.2]) },
    cube: { collisionBounds: bakedBounds("cubeBlock.glb", [1, 1, 1]) },
    archCylinder: { collisionBounds: bakedBounds("archStackCylinder.glb", [0.6, 0.6, 0.6]) },
    arch: { collisionBounds: bakedBounds("archStackArch.glb", [0.2, 0.2, 0.2]) },
} satisfies PuzzleTemplateBounds;

describe("The Playroom authored layout", () => {
    it("retains all 103 source puzzle placements", () => {
        const families = PLAYROOM_LAYOUT.reduce<Record<string, number>>((counts, entry) => {
            counts[entry.family] = (counts[entry.family] ?? 0) + 1;
            return counts;
        }, {});
        expect(PLAYROOM_LAYOUT).toHaveLength(103);
        expect(families).toEqual({
            domino: 12,
            stack: 1,
            tower: 1,
            cup: 9,
            bowlingBall: 1,
            bowlingPins: 1,
            ramp: 1,
            cubeStack: 41,
            cubes: 4,
            arch: 15,
            popper: 16,
            chess: 1,
        });
    });

    it("expands deterministically to the complete body-instance inventory", () => {
        const counts: Record<string, number> = {};
        let total = 0;
        const random = createPuzzleRandom(0x504c4159);
        for (let i = 0; i < PLAYROOM_LAYOUT.length; i++) {
            for (const batch of expandPuzzle(PLAYROOM_LAYOUT[i]!, random, placementBounds)) {
                const count = batch.matrices.length / 16;
                counts[batch.family] = (counts[batch.family] ?? 0) + count;
                total += count;
            }
        }
        expect(total).toBe(1955);
        expect(counts).toEqual({
            domino: 536,
            stack: 20,
            tower: 33,
            cup: 302,
            bowlingBall: 1,
            bowlingPins: 21,
            ramp: 1,
            cubeStack: 648,
            cubes: 144,
            arch: 200,
            popper: 16,
            chess: 33,
        });
        const first = expandPuzzle(PLAYROOM_LAYOUT[0]!, createPuzzleRandom(0x504c4159), placementBounds);
        const second = expandPuzzle(PLAYROOM_LAYOUT[0]!, createPuzzleRandom(0x504c4159), placementBounds);
        expect(first[0]!.matrices).toEqual(second[0]!.matrices);
    });

    it("aligns source box colliders without assuming origin-centred geometry", () => {
        const definitions = [
            ["towerGameBlock", "towerGameBlock.glb", [20, 20, 20]],
            ["cube", "cubeBlock.glb", [1, 1, 1]],
            ["popper", "babylonBurster.glb", [0.2, 0.2, 0.2]],
            ["chessboard", "chessboard.glb", [0.6, 0.6, 0.6]],
        ] as const;
        for (const [model, file, scale] of definitions) {
            const bounds = bakedBounds(file, scale);
            const collider = boxColliderForModel(model, bounds);
            expect(collider.center, model).toEqual(bounds.center);
            expect(collider.extents, model).toEqual(model === "chessboard" ? bounds.extents.map((extent) => extent * 0.6) : bounds.extents);
            expect(collider.center[1], model).toBeGreaterThan(0);
            const bottom = collider.center[1] - collider.extents[1] * 0.5;
            if (model === "chessboard") {
                expect(bottom).toBeGreaterThan(0);
            } else {
                expect(bottom, model).toBeCloseTo(0, 5);
            }
        }

        const dominoBounds = bakedBounds("domino.glb", [0.2, 0.2, 0.2]);
        const domino = boxColliderForModel("domino", dominoBounds);
        expect(domino).toEqual({ center: [0, 0.16, 0], extents: [0.176, 0.32, 0.042] });
        expect(domino.center[1] - domino.extents[1] * 0.5).toBe(0);

        const radialBounds = bakedBounds("transformedTowerGameBlock.glb", [0.2, 0.2, 0.2]);
        const radial = boxColliderForModel("transformedTowerGameBlock", radialBounds);
        expect(radial.center).toEqual([0, 0, 0]);
        expect(radial.extents[0]).toBeCloseTo(radialBounds.extents[0], 5);
        expect(radial.extents[1]).toBeCloseTo(radialBounds.extents[1], 5);
        expect(radial.extents[2]).toBeCloseTo(radialBounds.extents[2], 5);
    });
});
