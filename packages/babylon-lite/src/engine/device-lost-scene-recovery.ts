import type { EngineContext } from "./engine.js";
import { _enableDeviceLostRecovery } from "./device-lost-recovery.js";
import type { DeviceLostRecoveryCallbacks, DeviceLostRecoveryHandle } from "./device-lost-recovery-types.js";
import { _releaseDeviceLostRecoveryCapture, _retainDeviceLostRecoveryCapture } from "./device-lost-recovery-capture.js";
import { clearSceneBGLCache } from "../render/scene-helpers.js";

/**
 * Enable best-effort WebGPU device-lost recovery for every registered SceneContext.
 *
 * Device reacquisition is coordinated per engine so additional renderer-specific
 * recovery strategies can share the same replacement device. Active context kinds
 * without an enabled strategy cause recovery to fail explicitly.
 */
export function enableDeviceLostSceneRecovery(engine: EngineContext, options: DeviceLostRecoveryCallbacks = {}): DeviceLostRecoveryHandle {
    return _enableDeviceLostRecovery(engine, {
        _kind: "scene",
        _recoverOrder: 100,
        _enable(currentEngine): void {
            _retainDeviceLostRecoveryCapture(currentEngine, true);
        },
        _disable(currentEngine): void {
            _releaseDeviceLostRecoveryCapture(currentEngine, true);
        },
        async _recover(currentEngine): Promise<void> {
            clearSceneBGLCache();
            const { rebuildRegisteredScenes } = await import("./recovery-rebuild.js");
            await rebuildRegisteredScenes(currentEngine);
        },
        _onLost: options.onLost,
        _onRecovered: options.onRecovered,
        _onRecoveryFailed: options.onRecoveryFailed,
    });
}
