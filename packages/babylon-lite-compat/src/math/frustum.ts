/** Babylon.js-compatible `Frustum` (pure JS): extract clip planes from a matrix. */

import { Plane } from "./plane.js";
import type { Matrix } from "./matrix.js";

export const Frustum = {
    /** Extract the 6 frustum planes from a view-projection `transform`. */
    GetPlanes(transform: Matrix): Plane[] {
        const planes: Plane[] = [];
        for (let i = 0; i < 6; i++) {
            planes.push(new Plane(0, 0, 0, 0));
        }
        Frustum.GetPlanesToRef(transform, planes);
        return planes;
    },

    /** Extract the 6 frustum planes from `transform` into the supplied `planes` array. */
    GetPlanesToRef(transform: Matrix, planes: Plane[]): void {
        const m = transform.m;
        // Left
        set(planes[0]!, m[3]! + m[0]!, m[7]! + m[4]!, m[11]! + m[8]!, m[15]! + m[12]!);
        // Right
        set(planes[1]!, m[3]! - m[0]!, m[7]! - m[4]!, m[11]! - m[8]!, m[15]! - m[12]!);
        // Bottom
        set(planes[2]!, m[3]! + m[1]!, m[7]! + m[5]!, m[11]! + m[9]!, m[15]! + m[13]!);
        // Top
        set(planes[3]!, m[3]! - m[1]!, m[7]! - m[5]!, m[11]! - m[9]!, m[15]! - m[13]!);
        // Near
        set(planes[4]!, m[3]! + m[2]!, m[7]! + m[6]!, m[11]! + m[10]!, m[15]! + m[14]!);
        // Far
        set(planes[5]!, m[3]! - m[2]!, m[7]! - m[6]!, m[11]! - m[10]!, m[15]! - m[14]!);
    },
};

function set(plane: Plane, a: number, b: number, c: number, d: number): void {
    plane.normal.set(a, b, c);
    plane.d = d;
    plane.normalize();
}
