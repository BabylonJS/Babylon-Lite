import { describe, expect, it, vi } from "vitest";

import {
    addAnimationTask,
    createAnimationManager,
    createAnimationTask,
    removeAnimationTask,
    startAnimationManager,
    stopAnimationManager,
    updateAnimationManager,
} from "../../../packages/babylon-lite/src/animation/animation-manager";

describe("AnimationManager", () => {
    it("updates generic animation tasks and removes tasks explicitly", () => {
        const manager = createAnimationManager();
        const deltas: number[] = [];
        const task = createAnimationTask((_manager, deltaMs) => {
            deltas.push(deltaMs);
        });

        addAnimationTask(manager, task);
        addAnimationTask(manager, task);
        expect(manager.animations).toEqual([task]);

        updateAnimationManager(manager, 10);
        expect(deltas).toEqual([10]);
        expect(task.active).toBe(true);

        updateAnimationManager(manager, 12);
        expect(deltas).toEqual([10, 12]);
        removeAnimationTask(manager, task);
        expect(manager.animations).toEqual([]);
        expect(task.active).toBe(false);
    });

    it("does not skip a task when an earlier task removes itself during update", () => {
        const manager = createAnimationManager();
        const calls: string[] = [];
        const first = createAnimationTask((m) => {
            calls.push("first");
            removeAnimationTask(m, first);
        });
        const second = createAnimationTask(() => {
            calls.push("second");
        });

        addAnimationTask(manager, first);
        addAnimationTask(manager, second);

        updateAnimationManager(manager, 16);

        expect(calls).toEqual(["first", "second"]);
        expect(manager.animations).toEqual([second]);

        calls.length = 0;
        updateAnimationManager(manager, 16);
        expect(calls).toEqual(["second"]);
    });

    it("uses fixed deltas for manual and autonomous updates", () => {
        const callbacks: Array<(now: number) => void> = [];
        const requestAnimationFrameMock = vi.fn((callback: (now: number) => void) => {
            callbacks.push(callback);
            return callbacks.length;
        });
        const cancelAnimationFrameMock = vi.fn();
        vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
        vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);
        const deltas: number[] = [];
        const onUpdate = vi.fn();
        const manager = createAnimationManager({ fixedDeltaMs: 25, onUpdate });
        addAnimationTask(
            manager,
            createAnimationTask((_manager, deltaMs) => {
                deltas.push(deltaMs);
            })
        );

        try {
            updateAnimationManager(manager, 1);
            startAnimationManager(manager);
            callbacks[0]!(100);

            expect(deltas).toEqual([25, 25]);
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
