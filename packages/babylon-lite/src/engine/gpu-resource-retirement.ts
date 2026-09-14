import type { EngineContext } from "./engine.js";

type GpuResourceRetirement = () => void;

/** Run a batch exactly once. `splice` empties it synchronously, so whichever caller gets there first
 *  — the queue fence, engine teardown, or device-lost recovery — owns the work and the others see an
 *  empty batch. Cleanup is best-effort: a throw (device already gone, resource already disposed)
 *  must not stop the remaining retirements. */
function runBatch(batch: GpuResourceRetirement[]): void {
    for (const retire of batch.splice(0)) {
        try {
            retire();
        } catch (error) {
            console.error("GPU resource retirement failed.", error);
        }
    }
}

/** @internal Retire GPU resources only after the next frame submission that can reference them has drained. */
export function retireGpuResources(engine: EngineContext, retirement: GpuResourceRetirement): void {
    (engine._retirements ??= []).push(retirement);
}

/** @internal Drain the pending batch behind a queue fence.
 *
 *  Called by `renderFrame` right after `queue.submit`, and by `stopEngine` / the
 *  no-rendering-context early return, where no further submit will ever come and the teardown would
 *  otherwise be stranded until `disposeEngine`.
 *
 *  The batch is detached from `_retirements` synchronously (so it cannot grow past its own fence)
 *  but parked in `_retiring` while the fence is pending, because a synchronous drain may still need
 *  to claim it: device-lost recovery MUST run these before it rebuilds anything, since the texture
 *  disposers capture `Texture2D` wrappers whose `texture` field recovery replaces in place.
 *
 *  The fence itself is acquired in a microtask so a caller that stops the engine from inside
 *  `onBeforeRender` still fences behind the in-flight frame's submit — `renderFrame` is synchronous,
 *  so the microtask lands after it. If the fence rejects (the device was lost), the batch is left in
 *  `_retiring` for recovery or teardown to claim rather than being run late against rebuilt
 *  resources. */
export function flushGpuResourceRetirements(engine: EngineContext): void {
    const batch = engine._retirements;
    if (!batch) {
        return;
    }
    engine._retirements = null;
    const inFlight = (engine._retiring ??= []);
    inFlight.push(batch);
    queueMicrotask(() => {
        void engine._device.queue
            .onSubmittedWorkDone()
            .then(() => {
                const index = inFlight.indexOf(batch);
                if (index >= 0) {
                    inFlight.splice(index, 1);
                }
                runBatch(batch);
            })
            .catch(() => undefined);
    });
}

/** Wait for submitted GPU work and all outstanding resource-retirement callbacks.
 *  Stop resource producers and dispose their scene/task consumers before awaiting this teardown
 *  boundary. Unlike `waitForGpuIdle`, it also drains CPU-side releases, including releases queued by
 *  another callback. Cleanup attempts every callback and reports failures; a failed GPU fence rejects
 *  without releasing unfenced resources. Do not await this during steady rendering. */
export async function waitForGpuResourceRetirements(engine: EngineContext): Promise<void> {
    // A call inside a synchronous frame must fence after that frame's submission.
    await Promise.resolve();
    do {
        flushGpuResourceRetirements(engine);
        const inFlight = engine._retiring;
        const batches = inFlight?.slice();
        await engine._device.queue.onSubmittedWorkDone();
        for (const batch of batches ?? []) {
            const index = inFlight!.indexOf(batch);
            if (index >= 0) {
                inFlight!.splice(index, 1);
            }
            runBatch(batch);
        }
    } while (engine._retirements?.length || engine._retiring?.length);
}

/** @internal Run every outstanding retirement synchronously — both the batch still accumulating and
 *  any batch whose fence has not resolved yet. Used at engine teardown, and at the start of
 *  device-lost recovery (before any resource is rebuilt, while every captured wrapper still points
 *  at the dead GPU objects, so the destroy calls are no-ops but the ref counts settle correctly). */
export function disposeGpuResourceRetirements(engine: EngineContext): void {
    const batch = engine._retirements;
    const inFlight = engine._retiring;
    engine._retirements = null;
    engine._retiring = null;
    if (batch) {
        runBatch(batch);
    }
    inFlight?.forEach(runBatch);
}
