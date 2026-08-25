import type { EngineContext } from "./engine.js";
import { _getAdapterOptions, resizeEngine, startEngine, stopEngine } from "./engine.js";
import { disposeGpuResourceRetirements } from "./gpu-resource-retirement.js";
import { TU } from "./gpu-flags.js";
import { _refreshScRT } from "./surface.js";
import type { DeviceLostRecoveryRegistration, DeviceLostRecoveryState } from "./device-lost-recovery.js";
import type { Texture2D } from "../texture/texture-2d.js";

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
    assertEveryActiveContextKindIsRecoverable(engine, handlers);
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
    await rebuildRecoverableTextures(engine, state);
    const orderedHandlers = Array.from(handlers.values()).sort((a, b) => (a._recoverOrder ?? 0) - (b._recoverOrder ?? 0));
    for (const handler of orderedHandlers) {
        await runRecoveryStep(`running "${handler._kind}" recovery`, () => handler._recover(engine));
    }

    if (wasRunning) {
        await runRecoveryStep("restarting rendering", () => startEngine(engine));
    }
}

/**
 * Rebuild every texture that recovery capture stamped, before any per-context handler runs.
 *
 * The per-kind handlers find textures by walking their own object graphs — scene materials, sprite
 * layer atlases. That only covers textures something is currently drawing with. An app that owns a
 * recoverable texture outside those graphs (a sprite atlas page whose frames no `Sprite2DLayer`
 * references yet, an off-screen render target it swaps in later) would otherwise keep the lost
 * device's `GPUTexture` through a "successful" recovery, and the first `writeTexture` or draw
 * against it afterwards is a use-after-free that kills the browser's renderer process — with a
 * stack pointing at ordinary drawing code, arbitrarily long after the loss.
 *
 * Textures are tracked weakly, so this walks whatever is still alive and drops the rest. The
 * handlers' own walks still run; `rebuildTexture2D` is idempotent per device, so they no-op here
 * instead of rebuilding a second time.
 */
async function rebuildRecoverableTextures(engine: EngineContext, state: DeviceLostRecoveryState): Promise<void> {
    const tracked = state._textures;
    const textures: Texture2D[] = [];
    for (const ref of tracked) {
        const texture = ref.deref();
        if (texture) {
            textures.push(texture);
        } else {
            tracked.delete(ref);
        }
    }
    if (textures.length === 0) {
        return;
    }
    const { rebuildTexture2D } = await import("../texture/texture-recovery.js");
    await runRecoveryStep("rebuilding recoverable textures", async () => {
        // allSettled (not all): `Promise.all` would reject the moment one rebuild fails, so
        // recovery would report failure — handing the engine back to the app to tear down —
        // while the remaining rebuilds were still in flight mutating that app's textures. Settle
        // everything first so failing here means lite is genuinely done touching them, and so the
        // error surfaced is not just whichever fetch happened to lose the race.
        const results = await Promise.allSettled(textures.map((texture) => rebuildTexture2D(engine, texture)));
        const failed = results.find((result) => result.status === "rejected");
        if (failed) {
            throw failed.reason;
        }
    });
}

/**
 * Refuse to recover while a rendering context of a kind nobody can rebuild is still registered.
 *
 * Every buffer, bind group and pipeline such a context owns belongs to the device that was just
 * lost. Recovery would happily swap in a replacement device, report success and re-arm, leaving
 * that context registered on its surface — and the next `renderFrame` would then encode draws
 * against freed native objects. That is a use-after-free inside the GPU process bridge, so it does
 * not fail cleanly: it takes down the whole browser renderer process (STATUS_ACCESS_VIOLATION,
 * "Aw, Snap") a moment later, with a stack that points nowhere near device loss. Enabling backend
 * validation hides it, which is the usual tell.
 *
 * Failing here instead keeps that impossible-to-diagnose crash from ever being reachable: the
 * engine is already stopped, nothing has been rebuilt yet, and the app learns through
 * `onRecoveryFailed` that it has to tear this engine down rather than keep drawing with it.
 */
function assertEveryActiveContextKindIsRecoverable(engine: EngineContext, handlers: ReadonlyMap<string, DeviceLostRecoveryRegistration>): void {
    const unrecoverable = new Set<string>();
    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (!handlers.has(context._kind)) {
                unrecoverable.add(context._kind);
            }
        }
    }
    if (unrecoverable.size) {
        throw new Error(
            `Device-lost recovery cannot rebuild registered rendering contexts of kind: ${Array.from(unrecoverable).sort().join(", ")}. ` +
                `Recovering around them would leave them bound to the lost device and crash the browser's renderer process on the next frame. ` +
                `Enable that kind's device-lost recovery before the device is lost, or unregister the context.`
        );
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
