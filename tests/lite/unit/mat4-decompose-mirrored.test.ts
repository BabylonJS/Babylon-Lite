import { describe, expect, it } from "vitest";
import { mat4Decompose } from "../../../packages/babylon-lite/src/math/mat4-decompose";
import { mat4Compose } from "../../../packages/babylon-lite/src/math/mat4-compose";
import { createSceneNode } from "../../../packages/babylon-lite/src/scene/scene-node";
import { setParent } from "../../../packages/babylon-lite/src/scene/set-parent";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";

/** Snapshot a world matrix by value — the engine reuses the backing storage in place. */
function snapshot(m: Mat4): number[] {
    return Array.from({ length: 16 }, (_, i) => m[i]!);
}

function expectMatrixClose(actual: Mat4, expected: readonly number[], tolerance = 1e-5): void {
    for (let i = 0; i < 16; i++) {
        expect(actual[i]!, `element ${i}`).toBeCloseTo(expected[i]!, -Math.log10(tolerance));
    }
}

/** Quaternion for a rotation of `angle` radians around the normalized axis (x, y, z). */
function quatAxisAngle(x: number, y: number, z: number, angle: number): [number, number, number, number] {
    const len = Math.hypot(x, y, z);
    const s = Math.sin(angle / 2) / len;
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/**
 * `mat4Decompose` must preserve reflections. The glTF loader's synthetic `__root__` carries
 * `scaling = (-1, 1, 1)` for the RH→LH conversion, so a decomposition that returns only
 * non-negative scales silently un-mirrors any model reparented with `setParent`.
 *
 * The decomposition is canonical rather than sign-faithful (the reflection is folded onto Y,
 * matching Babylon.js `Matrix.decompose`), so the contract under test is that recomposing the
 * result reproduces the original matrix — not that the original per-axis signs come back.
 */
describe("mat4Decompose — mirrored (negative determinant) matrices", () => {
    const [qx, qy, qz, qw] = quatAxisAngle(0.3, 1, -0.7, 0.9);

    const cases: { name: string; scale: [number, number, number] }[] = [
        { name: "negative X (the glTF __root__ handedness flip)", scale: [-1, 1, 1] },
        { name: "negative Y", scale: [1, -1, 1] },
        { name: "negative Z", scale: [1, 1, -1] },
        { name: "negative X with non-uniform magnitudes", scale: [-2.5, 0.75, 1.6] },
        { name: "negative Z with non-uniform magnitudes", scale: [1.4, 3.2, -0.6] },
        { name: "all three negative (still a reflection)", scale: [-1.3, -0.8, -2.1] },
    ];

    for (const { name, scale } of cases) {
        it(`round-trips a matrix with ${name}`, () => {
            const source = mat4Compose(4, -3, 11, qx, qy, qz, qw, scale[0], scale[1], scale[2]);
            const expected = snapshot(source);

            const { translation, rotation, scale: outScale } = mat4Decompose(source);

            // The reflection must survive: an odd number of negative scale components.
            const negatives = [outScale.x, outScale.y, outScale.z].filter((s) => s < 0).length;
            const sourceNegatives = scale.filter((s) => s < 0).length;
            expect(negatives % 2).toBe(sourceNegatives % 2);

            const recomposed = mat4Compose(translation.x, translation.y, translation.z, rotation.x, rotation.y, rotation.z, rotation.w, outScale.x, outScale.y, outScale.z);
            expectMatrixClose(recomposed, expected);
        });
    }

    it("folds the reflection onto Y, matching Babylon.js Matrix.decompose", () => {
        const { scale } = mat4Decompose(mat4Compose(0, 0, 0, 0, 0, 0, 1, -1, 1, 1));
        expect(scale.x).toBeGreaterThan(0);
        expect(scale.y).toBeLessThan(0);
        expect(scale.z).toBeGreaterThan(0);
    });

    it("leaves positive-determinant matrices with non-negative scales", () => {
        const { scale } = mat4Decompose(mat4Compose(1, 2, 3, qx, qy, qz, qw, 2, 0.5, 3));
        expect(scale.x).toBeCloseTo(2, 5);
        expect(scale.y).toBeCloseTo(0.5, 5);
        expect(scale.z).toBeCloseTo(3, 5);
    });

    it("keeps the existing degenerate-scale behaviour (zero axis produces a finite result)", () => {
        const { rotation, scale } = mat4Decompose(mat4Compose(0, 0, 0, qx, qy, qz, qw, 1, 0, 1));
        expect(Math.abs(scale.y)).toBeLessThan(1e-7);
        for (const c of [rotation.x, rotation.y, rotation.z, rotation.w]) {
            expect(Number.isFinite(c)).toBe(true);
        }
    });
});

/**
 * The forum repro (Babylon.js forum topic 63859): a glTF root carrying the RH→LH mirror is
 * reparented under a freshly created transform node. `setParent` promises to preserve the world
 * transform, so the rendered result must be unchanged.
 */
describe("setParent — mirrored child", () => {
    it("preserves the world matrix of a mirrored child under an identity parent", () => {
        const child = createSceneNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const before = snapshot(child.worldMatrix);

        setParent(child, createSceneNode("newRoot"));

        expectMatrixClose(child.worldMatrix, before);
    });

    it("preserves the world matrix of a mirrored child under a transformed parent", () => {
        const [pqx, pqy, pqz, pqw] = quatAxisAngle(1, 0.4, 0.2, 1.1);
        const parent = createSceneNode("newRoot", 7, -2, 5, pqx, pqy, pqz, pqw, 2, 2, 2);
        const child = createSceneNode("__root__", 1, 2, -3, 0, 0, 0, 1, -1, 1, 1);
        const before = snapshot(child.worldMatrix);

        setParent(child, parent);

        expectMatrixClose(child.worldMatrix, before, 1e-4);
        // The mirror is still there — the local transform kept an odd number of negative scales.
        expect(child.scaling.x * child.scaling.y * child.scaling.z).toBeLessThan(0);
    });

    it("preserves the world matrix when detaching a mirrored child back to world space", () => {
        const parent = createSceneNode("parent", 3, 1, -4, 0, 0, 0, 1, 1.5, 1.5, 1.5);
        const child = createSceneNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        child.parent = parent;
        const before = snapshot(child.worldMatrix);

        setParent(child, null);

        expect(child.parent).toBeNull();
        expectMatrixClose(child.worldMatrix, before, 1e-4);
    });

    it("keeps a mirrored grandchild's world transform when an ancestor is reparented", () => {
        const root = createSceneNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const leaf = createSceneNode("leaf", 2, 0.5, -1, 0, 0, 0, 1, 1, 1, 1);
        leaf.parent = root;
        const before = snapshot(leaf.worldMatrix);

        setParent(root, createSceneNode("newRoot", 0, 3, 0));

        // setParent preserves the ancestor's world transform, so the whole subtree — mirror
        // included — must stay exactly where it was.
        expectMatrixClose(leaf.worldMatrix, before, 1e-4);
    });
});
