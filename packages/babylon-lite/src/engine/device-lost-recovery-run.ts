import type { EngineContext } from "./engine.js";
import { resizeEngine, startEngine, stopEngine } from "./engine.js";
import { disposeGpuResourceRetirements } from "./gpu-resource-retirement.js";
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
    // Run every outstanding retirement NOW, before any handler rebuilds anything. They must not be
    // dropped — each also carries logical ref-count releases (texture pool counts, and a removed
    // mesh's claim on its shared geometry) whose loss would leave resources unfreeable. And they
    // must not run later: the disposers capture `Texture2D` wrappers whose `texture` field the
    // recovery handlers replace in place, so a late `releaseTexture` would destroy a freshly
    // recovered texture. Here every wrapper still points at the dead, device-lost objects, so the
    // destroy calls are no-ops while the counts settle correctly. This has to live here rather than
    // in any single handler, because handlers run in `_recoverOrder` and an earlier one (sprites,
    // order 0) would otherwise rebuild textures before a later one (scenes, order 100) drained.
    disposeGpuResourceRetirements(engine);

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance", ...(engine._xrCompatible ? { xrCompatible: true } : {}) });
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
