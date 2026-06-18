import { describe, expect, it, vi } from "vitest";

import { AssetsManager, CustomAssetTask } from "../src/loading/assets-manager";

describe("AssetsManager", () => {
    it("runs queued tasks and reports their results", async () => {
        const manager = new AssetsManager();
        const a = manager.addCustomTask("a", async () => 1);
        const b = manager.addCustomTask("b", async () => "two");

        await manager.loadAsync();

        expect(a.result).toBe(1);
        expect(b.result).toBe("two");
        expect(a.isCompleted).toBe(true);
        expect(b.state).toBe("done");
    });

    it("emits progress and finish events", async () => {
        const manager = new AssetsManager();
        manager.addCustomTask("a", async () => 1);
        manager.addCustomTask("b", async () => 2);

        const progress: number[] = [];
        manager.onProgressObservable.add((e) => progress.push(e.remainingCount));
        const finish = vi.fn();
        manager.onFinishObservable.add(finish);

        await manager.loadAsync();

        expect(progress).toEqual([1, 0]);
        expect(finish).toHaveBeenCalledTimes(1);
    });

    it("records task errors and continues", async () => {
        const manager = new AssetsManager();
        const failing = manager.addTask(
            new CustomAssetTask<number>("boom", async () => {
                throw new Error("nope");
            })
        );
        const ok = manager.addCustomTask("ok", async () => 42);

        const errorObserver = vi.fn();
        manager.onTaskErrorObservable.add(errorObserver);

        await manager.loadAsync();

        expect(failing.state).toBe("error");
        expect(failing.errorObject?.message).toBe("nope");
        expect(errorObserver).toHaveBeenCalledTimes(1);
        expect(ok.result).toBe(42);
    });

    it("rejects concurrent loads", async () => {
        const manager = new AssetsManager();
        manager.addCustomTask("slow", () => new Promise((resolve) => setTimeout(() => resolve(1), 5)));
        const first = manager.loadAsync();
        await expect(manager.loadAsync()).rejects.toThrow(/already loading/);
        await first;
    });

    it("fires onSuccess per task", async () => {
        const manager = new AssetsManager();
        const task = manager.addCustomTask("x", async () => 7);
        const onSuccess = vi.fn();
        task.onSuccess = onSuccess;
        await manager.loadAsync();
        expect(onSuccess).toHaveBeenCalledWith(task);
    });
});
