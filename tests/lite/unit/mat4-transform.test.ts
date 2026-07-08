import { describe, expect, it } from "vitest";
import { transformCoordinatesToRef, transformNormalToRef, mat4GetTranslationToRef } from "../../../packages/babylon-lite/src/math/mat4-transform";
import { mat4Identity } from "../../../packages/babylon-lite/src/math/mat4-identity";
import { mat4Translation } from "../../../packages/babylon-lite/src/math/mat4-translation";
import type { Mat4, Vec3 } from "../../../packages/babylon-lite/src/math/types";

/** Build a Mat4 from 16 column-major numbers (test-only). */
function mat4(values: number[]): Mat4 {
    return new Float32Array(values) as unknown as Mat4;
}

/**
 * Unit coverage for the Vec3-by-Mat4 transforms used by the NPE emitter shape blocks to bake the emitter
 * world matrix into birth position (coordinates) and direction (normal). Mirrors Babylon.js
 * `Vector3.TransformCoordinatesFromFloatsToRef` / `TransformNormalFromFloatsToRef`.
 */
describe("mat4 vec transforms", () => {
    it("identity leaves points and directions unchanged", () => {
        const out: Vec3 = { x: 0, y: 0, z: 0 };
        transformCoordinatesToRef(1, 2, 3, mat4Identity(), out);
        expect(out).toEqual({ x: 1, y: 2, z: 3 });
        transformNormalToRef(1, 2, 3, mat4Identity(), out);
        expect(out).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("translation offsets points but not directions", () => {
        const out: Vec3 = { x: 0, y: 0, z: 0 };
        const m = mat4Translation(10, 20, 30);
        transformCoordinatesToRef(1, 2, 3, m, out);
        expect(out).toEqual({ x: 11, y: 22, z: 33 });
        transformNormalToRef(1, 2, 3, m, out);
        expect(out).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("90deg Y rotation maps +X to -Z for both points and normals", () => {
        // Column-major Y-rotation by +90deg (cos=0, sin=1).
        const rotY90 = mat4([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
        const out: Vec3 = { x: 0, y: 0, z: 0 };
        transformCoordinatesToRef(1, 0, 0, rotY90, out);
        expect(out.x).toBeCloseTo(0, 12);
        expect(out.y).toBeCloseTo(0, 12);
        expect(out.z).toBeCloseTo(-1, 12);
        transformNormalToRef(1, 0, 0, rotY90, out);
        expect(out.x).toBeCloseTo(0, 12);
        expect(out.y).toBeCloseTo(0, 12);
        expect(out.z).toBeCloseTo(-1, 12);
    });

    it("rotation + translation: points include translation, normals ignore it", () => {
        // Y-rotation by +90deg with translation (5, 6, 7).
        const m = mat4([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 6, 7, 1]);
        const out: Vec3 = { x: 0, y: 0, z: 0 };
        transformCoordinatesToRef(1, 0, 0, m, out); // rotate(+X) = -Z, then + (5,6,7)
        expect(out.x).toBeCloseTo(5, 12);
        expect(out.y).toBeCloseTo(6, 12);
        expect(out.z).toBeCloseTo(6, 12);
        transformNormalToRef(1, 0, 0, m, out); // rotation only
        expect(out.x).toBeCloseTo(0, 12);
        expect(out.y).toBeCloseTo(0, 12);
        expect(out.z).toBeCloseTo(-1, 12);
    });

    it("mat4GetTranslationToRef reads the translation column", () => {
        const out: Vec3 = { x: 0, y: 0, z: 0 };
        mat4GetTranslationToRef(mat4Translation(4, -5, 6), out);
        expect(out).toEqual({ x: 4, y: -5, z: 6 });
    });
});
