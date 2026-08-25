import type { EngineContext } from "./engine.js";
import { _getAdapterOptions, resizeEngine, startEngine, stopEngine } from "./engine.js";
import { disposeGpuResourceRetirements } from "./gpu-resource-retirement.js";
import { TU } from "./gpu-flags.js";
import { _refreshScRT } from "./surface.js";
import type { DeviceLostRecoveryRegistration, DeviceLostRecoveryState } from "./device-lost-recovery.js";

/**
 * Runs the device-level half of recovery: acquire a replacement adapter/device, reconfigure
 * every surface, then hand off to the registered per-context recovery handlers.
 *
 * Deliberately NOT underscore-prefixed. This module is only reached through a dynamic
 * `import()` whose result is destructured, and a destructure is a property access — so the
 * scene bundler's Terser property mangler (`terserPropertyManglePlugin` in
 * `scripts/bundle-scenes-core.ts`, `regex: /^_[a-z]/`) rewrites the IMPORT side while the
 * export declaration, being a module binding, keeps its name. An `_lowerCamel` export
 * therefore resolves to `undefined` at runtime, and only in a minified bundle — dev and the
 * parity suite serve unmangled source. Same trap documented in `scene/scene-runtime-mesh-build.ts`
 * and `material/standard/std-mirrored-support.ts`. It stays out of `index.ts`, so it is not public API.
 * @internal
 */
export async function runDeviceLostRecovery(engine: EngineContext, state: DeviceLostRecoveryState, registrations: readonly DeviceLostRecoveryRegistration[]): Promise<void> {
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

    // Reapply any installed adapter options (e.g. `xrCompatible` from `enableXrCompatibleAdapter`)
    // so a recovered adapter keeps the XR-compatibility the original engine was created with.
    const adapter = await runRecoveryStep("requesting a replacement adapter", () => navigator.gpu.requestAdapter({ powerPreference: "high-performance", ..._getAdapterOptions() }));
    if (!adapter) {
        throw new Error("WebGPU adapter not available during device recovery");
    }
    const missingFeatures = state._requiredFeatures.filter((feature) => !adapter.features.has(feature));
    if (missingFeatures.length) {
        throw new Error(`WebGPU device recovery missing required features: ${missingFeatures.join(", ")}`);
    }
    engine._device = await runRecoveryStep("requesting a replacement device", () =>
        adapter.requestDevice({
            requiredFeatures: state._requiredFeatures,
            requiredLimits: { ...engine._options?.requiredLimits, ...engine._storageRequiredLimits },
        })
    );
    await runRecoveryStep("rebuilding engine storage buffers", () => engine._rebuildStorageBuffers?.());

    await runRecoveryStep("reconfiguring rendering surfaces", () => {
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
    });

    await runRecoveryStep("resizing rendering surfaces", () => resizeEngine(engine));
    const orderedHandlers = Array.from(handlers.values()).sort((a, b) => (a._recoverOrder ?? 0) - (b._recoverOrder ?? 0));
    for (const handler of orderedHandlers) {
        await runRecoveryStep(`running "${handler._kind}" recovery`, () => handler._recover(engine));
    }

    if (wasRunning) {
        await runRecoveryStep("restarting rendering", () => startEngine(engine));
    }
}

async function runRecoveryStep<T>(description: string, action: () => T | Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Device-lost recovery failed while ${description}: ${message}`, { cause: error });
    }
}
