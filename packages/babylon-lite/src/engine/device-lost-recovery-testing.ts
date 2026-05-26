import type { EngineContext, EngineContextInternal } from "./engine.js";
import { markNextDeviceLossForRecovery } from "./device-lost-recovery.js";

export function forceWebGpuDeviceLossForTesting(engine: EngineContext): void {
    if (!markNextDeviceLossForRecovery(engine)) {
        throw new Error("forceWebGpuDeviceLossForTesting requires enableDeviceLostRecovery(engine) first");
    }
    const eng = engine as EngineContextInternal;
    eng.device.destroy();
}
