import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ModelTemplate } from "../../../lab/lite/src/demos/playroom/types.js";
import { boxColliderForModel } from "../../../lab/lite/src/demos/playroom/world.js";

interface SourceBox {
    center: [number, number, number];
    extents: [number, number, number];
    effectiveInstanceScale: [number, number, number];
}

interface SourcePhysicsFixture {
    schemaVersion: number;
    provenance: {
        repository: string;
        revision: string;
        babylonCoreVersion: string;
        havokVersion: string;
        sourceBlobs: Record<string, string>;
    };
    boxes: Record<"towerGameBlock" | "transformedTowerGameBlock" | "cube" | "chessboard", SourceBox>;
}

const fixture = JSON.parse(readFileSync(new URL("../fixtures/playroom-source-physics.json", import.meta.url), "utf8")) as SourcePhysicsFixture;
const transformedTowerYCenter = -(2 ** -25);
const geometryBounds = {
    towerGameBlock: {
        center: [0, 0.14999999105930328, 0],
        extents: [0.4999999701976776, 0.29999998211860657, 1.4999998807907104],
    },
    transformedTowerGameBlock: {
        center: [0, transformedTowerYCenter, 2.2351741790771484e-8],
        extents: [0.4999999403953552, 1.5000001788139343, 0.30000023543834686],
    },
    cube: { center: [0, 0.25, 0], extents: [0.5, 0.5, 0.5] },
    chessboard: {
        center: [0, 0.0260188989341259, 0],
        extents: [1.2000000476837158, 0.0520377978682518, 1.2000000476837158],
    },
} as const satisfies Record<string, ModelTemplate["collisionBounds"]>;

describe("The Playroom source physics fixture", () => {
    it("pins the independent source revision and native package versions", () => {
        expect(fixture.schemaVersion).toBe(1);
        expect(fixture.provenance).toMatchObject({
            repository: "BabylonJS/ThePlayroom",
            revision: "d22ce23ef308e28d1f8b6598b4c72ea944205925",
            babylonCoreVersion: "6.0.0",
            havokVersion: "1.0.0",
        });
        expect(Object.values(fixture.provenance.sourceBlobs)).toHaveLength(5);
        for (const blob of Object.values(fixture.provenance.sourceBlobs)) {
            expect(blob).toMatch(/^[0-9a-f]{40}$/);
        }
    });

    it("matches source native box centers, extents, and unit instance scales", () => {
        expect(Object.is(transformedTowerYCenter, Number("-2.9802322387695312e-8"))).toBe(true);
        for (const model of Object.keys(fixture.boxes) as Array<keyof SourcePhysicsFixture["boxes"]>) {
            const collider = boxColliderForModel(model, geometryBounds[model]);
            expect(collider, model).toEqual({
                center: fixture.boxes[model].center,
                extents: fixture.boxes[model].extents,
            });
            expect(fixture.boxes[model].effectiveInstanceScale, model).toEqual([1, 1, 1]);
        }
    });
});
