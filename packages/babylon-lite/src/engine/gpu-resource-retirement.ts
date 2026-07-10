import type { EngineContext } from "./engine.js";

type GpuResourceRetirement = () => void;

/** @internal Retire GPU resources only after the next frame submission that can reference them has drained. */
export function retireGpuResources(engine: EngineContext, retirement: GpuResourceRetirement): void {
    engine._retirements.push(retirement);
}

/** @internal Fence the current retirement batch after renderFrame has submitted its command buffer. */
export function flushGpuResourceRetirements(engine: EngineContext): void {
    const batch = engine._retirements;
    if (batch.length) {
        engine._retirements = [];
        const drain = () =>
            batch.forEach((retire) => {
                try {
                    retire();
                } catch {
                    // Cleanup is best-effort after device loss or an already-disposed resource.
                }
            });
        void engine._device.queue.onSubmittedWorkDone().then(drain, drain);
    }
}

/** @internal Drain resources that never reached another frame before engine teardown. */
export function disposeGpuResourceRetirements(engine: EngineContext): void {
    for (const retire of engine._retirements.splice(0)) {
        try {
            retire();
        } catch {
            // Cleanup is best-effort after device loss or an already-disposed resource.
        }
    }
}
