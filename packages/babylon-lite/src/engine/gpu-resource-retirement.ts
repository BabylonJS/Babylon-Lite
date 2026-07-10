import type { EngineContext } from "./engine.js";

type GpuResourceRetirement = () => void;

/** @internal Retire GPU resources only after the next frame submission that can reference them has drained. */
export function retireGpuResources(engine: EngineContext, retirement: GpuResourceRetirement): void {
    (engine._retirements ??= []).push(() => {
        try {
            retirement();
        } catch {
            // Cleanup is best-effort after device loss or an already-disposed resource.
        }
    });
}

/** @internal Drain resources that never reached another frame before engine teardown. */
export function disposeGpuResourceRetirements(engine: EngineContext): void {
    const retirements = engine._retirements;
    engine._retirements = null;
    retirements?.forEach((retire) => retire());
}
