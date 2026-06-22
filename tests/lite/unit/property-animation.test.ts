import { describe, expect, it, vi } from "vitest";

import { createAnimationManager, startAnimationManager, stopAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { goToFrame } from "../../../packages/babylon-lite/src/animation/animation-group";
import { setAnimationWeight } from "../../../packages/babylon-lite/src/animation/animation-weight";
import { crossFadeAnimationGroups, enablePropertyAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-pointer-mixer";
import { createPropertyAnimationClip, createPropertyAnimationGroup } from "../../../packages/babylon-lite/src/animation/property-animation";

describe("Property animation", () => {
    it("updates a Babylon-style position.x frame animation without a scene or engine", () => {
        const manager = createAnimationManager();
        const target = { position: { x: 2 } };
        const clip = createPropertyAnimationClip("xSlide", [
            {
                path: "position.x",
                frameRate: 10,
                keys: [
                    { frame: 0, value: 2 },
                    { frame: 10, value: -2 },
                    { frame: 20, value: 2 },
                ],
            },
        ]);

        const group = createPropertyAnimationGroup(manager, target, clip, { fromFrame: 0, toFrame: 20, loop: true });
        expect(group.currentTime).toBe(0);
        expect(group.targetedAnimations).toEqual([{ target: target.position, path: "x" }]);

        updateAnimationManager(manager, 0);
        expect(target.position.x).toBe(2);

        updateAnimationManager(manager, 1000);
        expect(group.currentTime).toBe(1);
        expect(target.position.x).toBe(-2);

        goToFrame(group, 10);
        expect(group.currentTime).toBe(1);
        expect(target.position.x).toBe(-2);

        goToFrame(group, 0);
        expect(group.currentTime).toBe(0);
        expect(target.position.x).toBe(2);

        updateAnimationManager(manager, 1000);
        expect(target.position.x).toBe(2);
    });

    it("writes vector tracks through set() bindings", () => {
        const manager = createAnimationManager();
        const target = {
            position: {
                x: 0,
                y: 0,
                z: 0,
                set(x: number, y: number, z: number): void {
                    this.x = x;
                    this.y = y;
                    this.z = z;
                },
            },
        };
        const clip = createPropertyAnimationClip("move", [
            {
                path: "position",
                keys: [
                    { time: 0, value: [0, 0, 0] },
                    { time: 1, value: [2, 4, 6] },
                ],
            },
        ]);

        createPropertyAnimationGroup(manager, target, clip, { loop: false });
        updateAnimationManager(manager, 500);

        expect(target.position.x).toBeCloseTo(1);
        expect(target.position.y).toBeCloseTo(2);
        expect(target.position.z).toBeCloseTo(3);
    });

    it("writes vector tracks through component bindings", () => {
        const manager = createAnimationManager();
        const target = { position: { x: 0, y: 0, z: 0 } };
        const clip = createPropertyAnimationClip("move", [
            {
                path: "position",
                keys: [
                    { time: 0, value: [0, 0, 0] },
                    { time: 1, value: [3, 6, 9] },
                ],
            },
        ]);

        createPropertyAnimationGroup(manager, target, clip, { loop: false });
        updateAnimationManager(manager, 500);

        expect(target.position.x).toBeCloseTo(1.5);
        expect(target.position.y).toBeCloseTo(3);
        expect(target.position.z).toBeCloseTo(4.5);
    });

    it("supports STEP interpolation with second-based keyframes", () => {
        const manager = createAnimationManager();
        const target = { position: { x: -1 } };
        const clip = createPropertyAnimationClip("step", [
            {
                path: "position.x",
                interpolation: "step",
                keys: [
                    { time: 0, value: -1 },
                    { time: 1, value: 1 },
                    { time: 2, value: 3 },
                ],
            },
        ]);

        createPropertyAnimationGroup(manager, target, clip, { loop: false });
        updateAnimationManager(manager, 500);
        expect(target.position.x).toBe(-1);

        updateAnimationManager(manager, 600);
        expect(target.position.x).toBe(1);

        updateAnimationManager(manager, 2000);
        expect(target.position.x).toBe(3);
    });

    it("throws when a property path cannot be resolved", () => {
        const manager = createAnimationManager();
        const clip = createPropertyAnimationClip("bad", [
            {
                path: "position.q",
                keys: [
                    { time: 0, value: 0 },
                    { time: 1, value: 1 },
                ],
            },
        ]);

        expect(() => createPropertyAnimationGroup(manager, { position: { x: 0 } }, clip)).toThrow(/position\.q/);
    });

    it("blends weighted manual property groups that target the same scalar", () => {
        function run(order: "positive-first" | "negative-first"): number {
            const manager = createAnimationManager();
            const target = { position: { x: 0 } };
            const positive = createPropertyAnimationClip("positive", [
                {
                    path: "position.x",
                    keys: [
                        { time: 0, value: 0 },
                        { time: 1, value: 10 },
                    ],
                },
            ]);
            const negative = createPropertyAnimationClip("negative", [
                {
                    path: "position.x",
                    keys: [
                        { time: 0, value: 0 },
                        { time: 1, value: -10 },
                    ],
                },
            ]);

            const first = order === "positive-first" ? positive : negative;
            const second = order === "positive-first" ? negative : positive;
            const firstGroup = createPropertyAnimationGroup(manager, target, first, { loop: false });
            const secondGroup = createPropertyAnimationGroup(manager, target, second, { loop: false });
            enablePropertyAnimationBlending(manager);
            setAnimationWeight(firstGroup, order === "positive-first" ? 0.25 : 0.75);
            setAnimationWeight(secondGroup, order === "positive-first" ? 0.75 : 0.25);

            updateAnimationManager(manager, 1000);
            return target.position.x;
        }

        expect(run("positive-first")).toBeCloseTo(-5);
        expect(run("negative-first")).toBeCloseTo(-5);
    });

    it("rejects invalid animation weights", () => {
        const manager = createAnimationManager();
        const target = { position: { x: 0 } };
        const clip = createPropertyAnimationClip("positive", [
            {
                path: "position.x",
                keys: [
                    { time: 0, value: 0 },
                    { time: 1, value: 1 },
                ],
            },
        ]);
        const group = createPropertyAnimationGroup(manager, target, clip);

        expect(() => setAnimationWeight(group, -0.1)).toThrow(/between 0 and 1/);
        expect(() => setAnimationWeight(group, Number.NaN)).toThrow(/between 0 and 1/);
    });

    it("cross-fades manual property animation weights over a deterministic duration", () => {
        const manager = createAnimationManager();
        const target = { position: { x: 0 } };
        const positive = createPropertyAnimationClip("positive", [
            {
                path: "position.x",
                keys: [
                    { time: 0, value: 2 },
                    { time: 2, value: 2 },
                ],
            },
        ]);
        const negative = createPropertyAnimationClip("negative", [
            {
                path: "position.x",
                keys: [
                    { time: 0, value: -2 },
                    { time: 2, value: -2 },
                ],
            },
        ]);
        const positiveGroup = createPropertyAnimationGroup(manager, target, positive, { loop: false });
        const negativeGroup = createPropertyAnimationGroup(manager, target, negative, { loop: false });
        enablePropertyAnimationBlending(manager);
        setAnimationWeight(positiveGroup, 1);
        setAnimationWeight(negativeGroup, 0);

        crossFadeAnimationGroups(manager, positiveGroup, negativeGroup, { durationMs: 1000 });
        updateAnimationManager(manager, 250);

        expect(positiveGroup.weight).toBeCloseTo(0.75);
        expect(negativeGroup.weight).toBeCloseTo(0.25);
        expect(target.position.x).toBeCloseTo(1);
    });

    it("runs autonomously through requestAnimationFrame", () => {
        const callbacks: Array<(now: number) => void> = [];
        const requestAnimationFrameMock = vi.fn((callback: (now: number) => void) => {
            callbacks.push(callback);
            return callbacks.length;
        });
        const cancelAnimationFrameMock = vi.fn();
        vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
        vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
        const onUpdate = vi.fn();
        const manager = createAnimationManager({ fixedDeltaMs: 25, onUpdate });
        const target = { position: { x: 0 } };
        const clip = createPropertyAnimationClip("autonomous", [
            {
                path: "position.x",
                keys: [
                    { time: 0, value: 0 },
                    { time: 1, value: 10 },
                ],
            },
        ]);
        createPropertyAnimationGroup(manager, target, clip, { loop: false });

        try {
            startAnimationManager(manager);
            callbacks[0]!(100);

            expect(target.position.x).toBeCloseTo(0.25);
            expect(onUpdate).toHaveBeenCalledWith(25);
            expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);

            stopAnimationManager(manager);
            expect(cancelAnimationFrameMock).toHaveBeenCalledWith(2);
            expect(manager.running).toBe(false);
        } finally {
            stopAnimationManager(manager);
            vi.unstubAllGlobals();
        }
    });
});
