import { describe, expect, it } from "vitest";

import { createAnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";
import { PATH_TRANSLATION, PATH_SCALE } from "../../../packages/babylon-lite/src/animation/types";
import type { AnimationClip, AnimationSampler, NodeRest, AnimatedNodeTarget } from "../../../packages/babylon-lite/src/animation/types";

function restNode(parentIdx = -1, tx = 0, ty = 0, tz = 0, sx = 1, sy = 1, sz = 1): NodeRest {
    return { parentIdx, tx, ty, tz, rx: 0, ry: 0, rz: 0, rw: 1, sx, sy, sz };
}

function makeTarget(): AnimatedNodeTarget & { _p: number[]; _s: number[]; _writes: number } {
    const t = {
        _p: [0, 0, 0],
        _s: [1, 1, 1],
        _writes: 0,
        position: {
            set(x: number, y: number, z: number): void {
                t._p = [x, y, z];
                t._writes++;
            },
        },
        rotationQuaternion: {
            set(): void {
                t._writes++;
            },
        },
        scaling: {
            set(x: number, y: number, z: number): void {
                t._s = [x, y, z];
                t._writes++;
            },
        },
    };
    return t;
}

function linearSampler(input: number[], output: number[]): AnimationSampler {
    return { input: new Float32Array(input), output: new Float32Array(output), interpolation: 0 };
}

describe("Plain glTF node-TRS animation writeback", () => {
    it("applies translation + scale channels of a writable node to its scene target", () => {
        // Node 1 translates (0,0,0)->(10,0,0) and scales (1,1,1)->(3,3,3) over 1s.
        const clip: AnimationClip = {
            name: "n",
            duration: 1,
            samplers: [linearSampler([0, 1], [0, 0, 0, 10, 0, 0]), linearSampler([0, 1], [1, 1, 1, 3, 3, 3])],
            channels: [
                { samplerIdx: 0, nodeIdx: 1, path: PATH_TRANSLATION },
                { samplerIdx: 1, nodeIdx: 1, path: PATH_SCALE },
            ],
        };
        const nodes: NodeRest[] = [restNode(), restNode()];
        const target = makeTarget();
        const nodeTargets: (AnimatedNodeTarget | undefined)[] = [undefined, target];

        const ctrl = createAnimationController(clip, nodes, [], [], nodeTargets, new Set());
        ctrl.loop = false; // clamp at the end instead of wrapping to t=0

        // Halfway: translation = (5,0,0), scale = (2,2,2).
        ctrl.tick(500);
        expect(target._p).toEqual([5, 0, 0]);
        expect(target._s).toEqual([2, 2, 2]);

        // End: translation = (10,0,0), scale = (3,3,3).
        ctrl.tick(500);
        expect(target._p[0]).toBeCloseTo(10);
        expect(target._s).toEqual([3, 3, 3]);
    });

    it("does NOT write excluded nodes (joints / skinned chains) to scene targets", () => {
        const clip: AnimationClip = {
            name: "j",
            duration: 1,
            samplers: [linearSampler([0, 1], [0, 0, 0, 10, 0, 0])],
            channels: [{ samplerIdx: 0, nodeIdx: 1, path: PATH_TRANSLATION }],
        };
        const nodes: NodeRest[] = [restNode(), restNode()];
        const target = makeTarget();
        const nodeTargets: (AnimatedNodeTarget | undefined)[] = [undefined, target];

        // Node 1 is excluded (e.g. a skin joint or skinned-mesh ancestor) — it must
        // never receive node-TRS writeback; the skeleton path drives it instead.
        const ctrl = createAnimationController(clip, nodes, [], [], nodeTargets, new Set([1]));
        ctrl.tick(500);
        expect(target._writes).toBe(0);
        expect(target._p).toEqual([0, 0, 0]);
    });

    it("only writes the channels that are actually animated (mask)", () => {
        // Only translation is animated — scaling must never be written.
        const clip: AnimationClip = {
            name: "t",
            duration: 1,
            samplers: [linearSampler([0, 1], [0, 0, 0, 4, 0, 0])],
            channels: [{ samplerIdx: 0, nodeIdx: 1, path: PATH_TRANSLATION }],
        };
        const nodes: NodeRest[] = [restNode(), restNode(0, 0, 0, 0, 7, 7, 7)];
        const target = makeTarget();
        const nodeTargets: (AnimatedNodeTarget | undefined)[] = [undefined, target];

        const ctrl = createAnimationController(clip, nodes, [], [], nodeTargets, new Set());
        ctrl.tick(250);
        expect(target._p).toEqual([1, 0, 0]);
        // scaling.set was never called, so the mock retains its initial value.
        expect(target._s).toEqual([1, 1, 1]);
    });
});
