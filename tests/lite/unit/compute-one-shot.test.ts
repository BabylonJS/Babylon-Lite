import { describe, expect, it, vi } from "vitest";

import { armComputeOneShot, createComputeOneShot } from "../../../packages/babylon-lite/src/compute/compute-one-shot";
import { createComputeTask, submitComputeTasks, type ComputeTask } from "../../../packages/babylon-lite/src/compute/compute-task";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

function makeTask(): ComputeTask {
    const device = {
        createCommandEncoder: vi.fn(),
        queue: { onSubmittedWorkDone: vi.fn(async () => undefined) },
    } as unknown as GPUDevice;
    const engine = { _device: device } as EngineContext;
    return {
        name: "one-shot",
        engine,
        executionEnabled: true,
        dispatches: [],
        _dispatches: [],
        _passes: [],
        _pass: null,
        _disposed: false,
        record: vi.fn(),
        dispose: vi.fn(),
    };
}

async function finishRecordedTask(task: ComputeTask): Promise<void> {
    const encoder = {} as GPUCommandEncoder;
    task._oneShotRecorded!(encoder);
    task.engine._computeOneShotSubmitted!(encoder);
    await Promise.resolve();
}

describe("compute one-shot scheduling", () => {
    it("disables before the next frame and resolves after submitted work completes", async () => {
        const task = makeTask();
        const oneShot = createComputeOneShot(task);
        expect(task.executionEnabled).toBe(true);

        await finishRecordedTask(task);
        expect(task.executionEnabled).toBe(false);
        await oneShot.completion;
        expect(task.engine._device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();

        const next = armComputeOneShot(oneShot);
        expect(task.executionEnabled).toBe(true);
        await finishRecordedTask(task);
        await next;
        expect(task.engine._device.queue.onSubmittedWorkDone).toHaveBeenCalledTimes(2);
    });

    it("rejects and unregisters when an armed task is disposed", async () => {
        const engine = makeTask().engine;
        const task = createComputeTask(engine);
        const oneShot = createComputeOneShot(task);

        task.dispose();

        await expect(oneShot.completion).rejects.toThrow(/disposed before submission/);
        expect(oneShot._disposed).toBe(true);
        expect(task._oneShotRecorded).toBeUndefined();
        expect(() => createComputeOneShot(task)).toThrow(/has been disposed/);
    });

    it("completes an armed task with no enabled dispatches as a submitted no-op", async () => {
        const engine = makeTask().engine;
        const task = createComputeTask(engine);
        const oneShot = createComputeOneShot(task);
        task.record();
        engine._currentEncoder = {} as GPUCommandEncoder;

        expect(task._passes[0]!._execute()).toBe(0);
        task.engine._computeOneShotSubmitted!(engine._currentEncoder);
        await oneShot.completion;

        expect(task.executionEnabled).toBe(false);
    });

    it("stays armed when recording completes but the frame is not submitted", async () => {
        const task = makeTask();
        const oneShot = createComputeOneShot(task);

        const abandonedEncoder = {} as GPUCommandEncoder;
        task._oneShotRecorded!(abandonedEncoder);
        await Promise.resolve();

        expect(task.executionEnabled).toBe(true);
        expect(oneShot._armed).toBe(true);
        await finishRecordedTask(task);
        await oneShot.completion;
    });

    it("completes only shots recorded by the submitted encoder", async () => {
        const task = makeTask();
        const oneShot = createComputeOneShot(task);
        const abandonedEncoder = {} as GPUCommandEncoder;
        const unrelatedEncoder = {} as GPUCommandEncoder;
        task._oneShotRecorded!(abandonedEncoder);

        task.engine._computeOneShotSubmitted!(unrelatedEncoder);
        await Promise.resolve();
        expect(oneShot._armed).toBe(true);
        expect(task.executionEnabled).toBe(true);

        task.engine._computeOneShotSubmitted!(abandonedEncoder);
        await oneShot.completion;
        expect(oneShot._armed).toBe(false);
        expect(task.executionEnabled).toBe(false);
    });

    it("completes frame-recorded work through the existing post-submit resolver", async () => {
        const task = makeTask();
        const oneShot = createComputeOneShot(task);
        const encoder = {} as GPUCommandEncoder;
        task.engine._currentEncoder = encoder;
        task._oneShotRecorded!(encoder);

        task.engine._gpuTimerResolve!();
        await oneShot.completion;

        expect(task.executionEnabled).toBe(false);
    });

    it("does not execute or submit a completed one-shot through direct task submission", () => {
        const task = createComputeTask(makeTask().engine);
        task.record();
        task.executionEnabled = false;
        const createCommandEncoder = vi.spyOn(task.engine._device, "createCommandEncoder");

        submitComputeTasks([task]);

        expect(createCommandEncoder).not.toHaveBeenCalled();
    });
});
