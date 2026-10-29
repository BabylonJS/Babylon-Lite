/**
 * Right-handed engine math contract.
 *
 * Engine modules read handedness from `#coordinate-system`, which the package `imports` map resolves
 * by bundler condition. This file mocks the default (left-handed) variant with the `babylon-lite-rh`
 * one; vitest isolates test files, so every other unit test keeps the left-handed engine.
 *
 * The contract: Lite keeps its left-handed projection and folds the Z mirror into the view matrix
 * (`V = Sz·V_RH`). Because Babylon.js's right-handed projections are exactly the left-handed ones
 * times `Sz` (PerspectiveFovRH / OrthoOffCenterRH negate the third column), the clip-space result
 * `P_LH·Sz·V_RH` equals Babylon.js's `P_RH·V_RH` — so it suffices to check the view matrix against
 * Babylon.js's `Matrix.LookAtRH`, reproduced below from its definition.
 */
import { describe, expect, it, vi } from "vitest";

import { _rightHanded } from "../../../packages/babylon-lite/src/engine/coordinate-system";
import { getViewMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import { createArcRotateCamera } from "../../../packages/babylon-lite/src/camera/arc-rotate";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { cotangentNormalFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/pbr-normal-cotangent-wgsl";
import { createIblFragment } from "../../../packages/babylon-lite/src/material/pbr/fragments/ibl-fragment";

vi.mock("../../../packages/babylon-lite/src/engine/coordinate-system", () => import("../../../packages/babylon-lite/src/engine/coordinate-system-rh"));

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
};

/** Babylon.js `Matrix.LookAtRHToRef`, in its (shader-order) element layout. */
function bjsLookAtRH(eye: V3, target: V3, up: V3): number[] {
    const z = norm(sub(eye, target));
    const x = norm(cross(up, z));
    const y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/** `Sz·M`: negate the third row (Lite folds the Z mirror into the view matrix). */
function mirrorZRows(m: number[]): number[] {
    const r = m.slice();
    for (const i of [2, 6, 10, 14]) {
        r[i] = -r[i]!;
    }
    return r;
}

function expectMatClose(actual: ArrayLike<number>, expected: number[]): void {
    expect(actual.length).toBe(16);
    for (let i = 0; i < 16; i++) {
        expect(actual[i]).toBeCloseTo(expected[i]!, 5);
    }
}

describe("right-handed engine", () => {
    it("resolves the right-handed variant", () => {
        expect(_rightHanded).toBe(true);
    });

    it("arc-rotate camera view equals Sz·LookAtRH (Babylon.js right-handed ArcRotateCamera)", () => {
        const target: V3 = [1, 2, 3];
        const cam = createArcRotateCamera(0.7, 1.1, 9, { x: target[0], y: target[1], z: target[2] });
        const eye: V3 = [target[0] + 9 * Math.cos(0.7) * Math.sin(1.1), target[1] + 9 * Math.cos(1.1), target[2] + 9 * Math.sin(0.7) * Math.sin(1.1)];
        expectMatClose(getViewMatrix(cam) as unknown as ArrayLike<number>, mirrorZRows(bjsLookAtRH(eye, target, [0, 1, 0])));
    });

    it("free camera view equals Sz·LookAtRH (Babylon.js right-handed FreeCamera)", () => {
        const eye: V3 = [-4, 3, 7];
        const target: V3 = [2, -1, 0.5];
        const cam = createFreeCamera({ x: eye[0], y: eye[1], z: eye[2] }, { x: target[0], y: target[1], z: target[2] });
        expectMatClose(getViewMatrix(cam) as unknown as ArrayLike<number>, mirrorZRows(bjsLookAtRH(eye, target, [0, 1, 0])));
    });

    it("camera world matrix follows Babylon.js right-handed semantics (local -Z forward, +X right)", () => {
        const cam = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
        // Looking down world -Z in a right-handed system is the identity orientation.
        expectMatClose(cam.worldMatrix as unknown as ArrayLike<number>, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    });

    it("keeps the view space left-handed: points in front of the camera have positive view Z", () => {
        const cam = createFreeCamera({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 });
        const v = getViewMatrix(cam) as unknown as ArrayLike<number>;
        // World origin is 5 units in front of the camera; world +X is to the camera's right (right-handed,
        // looking down -Z), so it must land at view +X.
        expect(v[14]).toBeCloseTo(5, 6);
        expect(v[0]).toBeCloseTo(1, 6);
    });

    it("negates the environment lookup Z after the Y rotation (Babylon.js REFLECTIONMAP_OPPOSITEZ)", () => {
        const helpers = String(createIblFragment(false)._helperFunctions);
        expect(helpers).toContain("v.x*s-v.z*c");
        expect(helpers).not.toContain("-v.x*s+v.z*c");
    });

    it("reverses both cotangent-frame axes", () => {
        const code = cotangentNormalFragment("uv", "", "normalMapSample");
        expect(code).toContain("let tangent_ct=-(dp2perp*duv1.x+dp1perp*duv2.x);");
        expect(code).toContain("let bitangent_ct=dp2perp*duv1.y+dp1perp*duv2.y;");
    });
});
