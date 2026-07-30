import type { EngineContext } from "./engine.js";
import { _enableDeviceLostRecovery } from "./device-lost-recovery.js";
import type { DeviceLostRecoveryCallbacks, DeviceLostRecoveryHandle } from "./device-lost-recovery-types.js";
import { _releaseDeviceLostRecoveryCapture, _retainDeviceLostRecoveryCapture } from "./device-lost-recovery-capture.js";

/**
 * Enable best-effort WebGPU device-lost recovery for every registered SpriteRenderer.
 *
 * Enable this before creating or loading sprite textures so their recovery
 * sources are retained. Device reacquisition remains shared with every other
 * enabled rendering-context recovery adapter on the engine.
 */
export function enableDeviceLostSpriteRecovery(engine: EngineContext, options: DeviceLostRecoveryCallbacks = {}): DeviceLostRecoveryHandle {
    return _enableDeviceLostRecovery(engine, {
        _kind: "sprite-renderer",
        _enable: _retainDeviceLostRecoveryCapture,
        _disable: _releaseDeviceLostRecoveryCapture,
        async _recover(currentEngine): Promise<void> {
            const { rebuildRegisteredSpriteRenderers } = await import("../sprite/sprite-recovery.js");
            await rebuildRegisteredSpriteRenderers(currentEngine);
        },
        _onLost: options.onLost,
        _onRecovered: options.onRecovered,
        _onRecoveryFailed: options.onRecoveryFailed,
    });
}
