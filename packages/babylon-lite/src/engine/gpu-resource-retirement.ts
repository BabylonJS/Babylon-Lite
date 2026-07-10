import type { EngineContext } from "./engine.js";

type GpuResourceRetirement = () => void;

/** @internal Retire GPU resources only after the next frame submission that can reference them has drained. */
export function retireGpuResources(engine: EngineContext, retirement: GpuResourceRetirement): void {
    engine._retirements.push(retirement);
}

/** @internal Fence the current retirement batch after renderFrame has submitted its command buffer. */
export function flushGpuResourceRetirements(engine: EngineContext): void {
    const retirements = engine._retirements;
    if (retirements.length === 0) {
        return;
    }
    const batch = retirements.splice(0);
    const drain = () => runRetirements(batch);
    void engine._device.queue.onSubmittedWorkDone().then(drain, drain);
}

/** @internal Drain resources that never reached another frame before engine teardown. */
export function disposeGpuResourceRetirements(engine: EngineContext): void {
    runRetirements(engine._retirements.splice(0));
}

function runRetirements(retirements: readonly GpuResourceRetirement[]): void {
    for (const retire of retirements) {
        retire();
    }
}
