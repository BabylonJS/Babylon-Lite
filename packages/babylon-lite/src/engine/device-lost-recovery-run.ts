import type { EngineContext } from "./engine.js";
import { resizeEngine, startEngine, stopEngine } from "./engine.js";
import { TU } from "./gpu-flags.js";
import { _refreshScRT } from "./surface.js";
import type { DeviceLostRecoveryRegistration, DeviceLostRecoveryState } from "./device-lost-recovery.js";

/** @internal */
export async function _runDeviceLostRecovery(engine: EngineContext, state: DeviceLostRecoveryState, registrations: readonly DeviceLostRecoveryRegistration[]): Promise<void> {
    const handlers = new Map<string, DeviceLostRecoveryRegistration>();
    for (const registration of registrations) {
        handlers.set(registration._kind, registration);
    }

    const wasRunning = engine._renderFn !== null;
    stopEngine(engine);

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
        throw new Error("WebGPU adapter not available during device recovery");
    }
    const missingFeatures = state._requiredFeatures.filter((feature) => !adapter.features.has(feature));
    if (missingFeatures.length) {
        throw new Error(`WebGPU device recovery missing required features: ${missingFeatures.join(", ")}`);
    }
    engine._device = await adapter.requestDevice({
        requiredFeatures: state._requiredFeatures,
        requiredLimits: { ...engine._options?.requiredLimits, ...engine._storageRequiredLimits },
    });
    engine._rebuildStorageBuffers?.();

    for (const surface of engine.surfaces) {
        const usage = surface._swapchainCopySrc ? TU.RENDER_ATTACHMENT | TU.COPY_SRC : TU.RENDER_ATTACHMENT;
        surface._context.configure({
            device: engine._device,
            format: surface._configureFormat,
            alphaMode: surface._alphaMode,
            usage,
            viewFormats: [surface.format],
        });
        _refreshScRT(surface);
    }

    resizeEngine(engine);
    const orderedHandlers = Array.from(handlers.values()).sort((a, b) => (a._recoverOrder ?? 0) - (b._recoverOrder ?? 0));
    for (const handler of orderedHandlers) {
        await handler._recover(engine);
    }

    if (wasRunning) {
        await startEngine(engine);
    }
}
