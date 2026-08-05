import { describe, it, expect } from "vitest";

import { pickWithRay } from "../../../../packages/babylon-lite/src/picking/ray-pick";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { Mat4 } from "../../../../packages/babylon-lite/src/math/types";
import { mat4Compose } from "../../../../packages/babylon-lite/src/math/mat4-compose";
import type { Ray } from "../../../../packages/babylon-lite/src/picking/ray";

// Eight corners of a local unit cube spanning [-1, 1] on every axis.
const UNIT_CUBE = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);

function makeMesh(name: string, world: Mat4, opts?: { pickable?: boolean }): Mesh {
    return {
        name,
        pickable: opts?.pickable,
        _cpuPositions: UNIT_CUBE,
        worldMatrix: world,
    } as unknown as Mesh;
}

function makeScene(meshes: Mesh[]): SceneContext {
    return { meshes } as unknown as SceneContext;
}

function ray(origin: [number, number, number], direction: [number, number, number], length = 100): Ray {
    return { origin, direction, length };
}

const identity = mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
const translateZ = (z: number): Mat4 => mat4Compose(0, 0, z, 0, 0, 0, 1, 1, 1, 1);

describe("pickWithRay (CPU ray/AABB)", () => {
    it("hits a box straight ahead and reports the entry distance + point", () => {
        const scene = makeScene([makeMesh("box", translateZ(5))]); // spans z ∈ [4, 6]
        const info = pickWithRay(scene, ray([0, 0, 0], [0, 0, 1]));
        expect(info.hit).toBe(true);
        expect(info.pickedMesh?.name).toBe("box");
        expect(info.distance).toBeCloseTo(4, 5);
        expect(info.pickedPoint).not.toBeNull();
        expect(info.pickedPoint![2]).toBeCloseTo(4, 5);
    });

    it("misses when the ray points away from the box", () => {
        const scene = makeScene([makeMesh("box", translateZ(5))]);
        const info = pickWithRay(scene, ray([0, 0, 0], [0, 0, -1]));
        expect(info.hit).toBe(false);
        expect(info.pickedMesh).toBeNull();
    });

    it("returns the nearest of two boxes", () => {
        const near = makeMesh("near", translateZ(3)); // entry at z = 2
        const far = makeMesh("far", translateZ(6)); // entry at z = 5
        const info = pickWithRay(makeScene([far, near]), ray([0, 0, 0], [0, 0, 1]));
        expect(info.pickedMesh?.name).toBe("near");
        expect(info.distance).toBeCloseTo(2, 5);
    });

    it("skips meshes with pickable === false", () => {
        const near = makeMesh("near", translateZ(3), { pickable: false });
        const far = makeMesh("far", translateZ(6));
        const info = pickWithRay(makeScene([near, far]), ray([0, 0, 0], [0, 0, 1]));
        expect(info.pickedMesh?.name).toBe("far");
        expect(info.distance).toBeCloseTo(5, 5);
    });

    it("honours a predicate", () => {
        const near = makeMesh("near", translateZ(3));
        const far = makeMesh("far", translateZ(6));
        const info = pickWithRay(makeScene([near, far]), ray([0, 0, 0], [0, 0, 1]), { predicate: (m) => m.name === "far" });
        expect(info.pickedMesh?.name).toBe("far");
    });

    it("accounts for a scaled world matrix (ray transformed into local space)", () => {
        // Scale ×2 → world half-extent 2, centred at z = 5 → spans [3, 7], entry at 3.
        const world = mat4Compose(0, 0, 5, 0, 0, 0, 1, 2, 2, 2);
        const info = pickWithRay(makeScene([makeMesh("box", world)]), ray([0, 0, 0], [0, 0, 1]));
        expect(info.hit).toBe(true);
        expect(info.distance).toBeCloseTo(3, 5);
    });

    it("respects the ray length", () => {
        const scene = makeScene([makeMesh("box", translateZ(5))]); // entry at 4
        expect(pickWithRay(scene, ray([0, 0, 0], [0, 0, 1], 3)).hit).toBe(false);
        expect(pickWithRay(scene, ray([0, 0, 0], [0, 0, 1], 5)).hit).toBe(true);
    });

    it("misses cleanly on an empty scene and carries the ray", () => {
        const r = ray([0, 0, 0], [0, 0, 1]);
        const info = pickWithRay(makeScene([]), r);
        expect(info.hit).toBe(false);
        expect(info.ray).toBe(r);
    });

    it("ignores boxes the ray passes beside", () => {
        const scene = makeScene([makeMesh("box", identity)]); // spans [-1,1]
        const info = pickWithRay(scene, ray([5, 0, -10], [0, 0, 1]));
        expect(info.hit).toBe(false);
    });
});
