import { describe, expect, it } from "vitest";

import type { NodeRest } from "../../../packages/babylon-lite/src/animation/types";
import { mat4Compose } from "../../../packages/babylon-lite/src/math/mat4-compose";
import { mat4Multiply } from "../../../packages/babylon-lite/src/math/mat4-multiply";
import { computeNodeWorldMatrices, computeTopoOrder, resetTRS, TRS_STRIDE } from "../../../packages/babylon-lite/src/skeleton/skeleton-pose";
import { setBoneWorldPoseDeferred, type Bone, type Skeleton } from "../../../packages/babylon-lite/src/skeleton/bone-control";

const IDENTITY_NODE: Omit<NodeRest, "parentIdx"> = {
    tx: 0,
    ty: 0,
    tz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    rw: 1,
    sx: 1,
    sy: 1,
    sz: 1,
};

describe("computeNodeWorldMatrices", () => {
    it("uses absolute world overrides without reapplying the glTF root mirror", () => {
        const nodes: NodeRest[] = [
            { ...IDENTITY_NODE, parentIdx: -1 },
            { ...IDENTITY_NODE, parentIdx: 0, tx: 0, ty: 2, tz: 0 },
        ];
        const currentTrs = new Float32Array(nodes.length * TRS_STRIDE);
        const localMatrices = new Float32Array(nodes.length * 16);
        const worldMatrices = new Float32Array(nodes.length * 16);
        const rootMatrix = mat4Compose(1, 2, 3, 0.2, -0.3, 0.1, 0.92, 1, 1, 1);
        const rootWorld = new Float32Array(rootMatrix);
        const childLocal = mat4Compose(0, 2, 0, 0, 0, 0, 1, 1, 1, 1);
        resetTRS(nodes, nodes.length, currentTrs);

        computeNodeWorldMatrices(nodes, nodes.length, computeTopoOrder(nodes), currentTrs, localMatrices, worldMatrices, new Map([[0, rootWorld]]));

        expect(Array.from(worldMatrices.subarray(0, 16))).toEqual(Array.from(rootWorld));
        expect(Array.from(worldMatrices.subarray(16, 32))).toEqual(Array.from(mat4Multiply(rootMatrix, childLocal)));
    });

    it("retains the glTF root reflection when an external world pose matches bind pose", () => {
        const node = { ...IDENTITY_NODE, parentIdx: -1 };
        const currentTrs = new Float32Array(TRS_STRIDE);
        const localMatrices = new Float32Array(16);
        const normalWorld = new Float32Array(16);
        const overriddenWorld = new Float32Array(16);
        const worldOverrides = new Map<number, Float32Array>();
        const bone: Bone = { name: "joint", _nodeIndex: 0 };
        const skeleton = {
            bones: [bone],
            _byName: new Map([["joint", bone]]),
            _overrides: new Map(),
            _worldOverrides: worldOverrides,
            _bake: () => undefined,
        } as Skeleton;
        resetTRS([node], 1, currentTrs);

        computeNodeWorldMatrices([node], 1, new Int32Array([0]), currentTrs, localMatrices, normalWorld);
        setBoneWorldPoseDeferred(skeleton, bone, 0, 0, 0, 0, 0, 0, 1);
        computeNodeWorldMatrices([node], 1, new Int32Array([0]), currentTrs, localMatrices, overriddenWorld, worldOverrides);

        for (let i = 0; i < 16; i++) {
            expect(overriddenWorld[i]).toBeCloseTo(normalWorld[i]!, 6);
        }
        expect(overriddenWorld[0]).toBe(-1);
    });
});
