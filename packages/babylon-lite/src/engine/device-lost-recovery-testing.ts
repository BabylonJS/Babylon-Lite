import type { EngineContext } from "./engine.js";
import { markNextDeviceLossForRecovery } from "./device-lost-recovery.js";

export function forceWebGpuDeviceLossForTesting(engine: EngineContext): void {
    if (!markNextDeviceLossForRecovery(engine)) {
        throw new Error("forceWebGpuDeviceLossForTesting requires a device-lost recovery handler to be enabled first");
    }
    engine._device.destroy();
}
