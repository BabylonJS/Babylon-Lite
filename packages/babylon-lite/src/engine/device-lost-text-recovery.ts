import type { EngineContext } from "./engine.js";
import { _enableDeviceLostRecovery } from "./device-lost-recovery.js";
import type { DeviceLostRecoveryCallbacks, DeviceLostRecoveryHandle } from "./device-lost-recovery-types.js";

/**
 * Enable best-effort WebGPU device-lost recovery for every registered TextRenderer.
 *
 * GlyphStorage already retains the CPU atlas data needed for reconstruction, so
 * this adapter adds no renderer-specific capture outside the loss path.
 */
export function enableDeviceLostTextRecovery(engine: EngineContext, options: DeviceLostRecoveryCallbacks = {}): DeviceLostRecoveryHandle {
    return _enableDeviceLostRecovery(engine, {
        _kind: "text-renderer",
        async _recover(currentEngine): Promise<void> {
            const { rebuildRegisteredTextRenderers } = await import("../text/text-recovery.js");
            rebuildRegisteredTextRenderers(currentEngine);
        },
        _onLost: options.onLost,
        _onRecovered: options.onRecovered,
        _onRecoveryFailed: options.onRecoveryFailed,
    });
}
