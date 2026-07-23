import type { EngineContext } from "./engine.js";
import { resizeEngine, startEngine, stopEngine } from "./engine.js";
import { TU } from "./gpu-flags.js";
import { _refreshScRT } from "./surface.js";

/** @internal */
export interface DeviceLostRecoveryCallbacks {
    onLost?: (info: GPUDeviceLostInfo) => void;
    onRecovered?: () => void;
    onRecoveryFailed?: (error: unknown) => void;
}

/** @internal */
export interface DeviceLostRecoveryRegistration {
    /** @internal */
    _kind: string;
    /** @internal */
    _recover: (engine: EngineContext) => void | Promise<void>;
    /** @internal */
    _enable?: (engine: EngineContext) => void;
    /** @internal */
    _disable?: (engine: EngineContext) => void;
    /** @internal */
    _callbacks: DeviceLostRecoveryCallbacks;
}

/** @internal */
export interface DeviceLostRecoveryHandle {
    disable(): void;
}

/** @internal */
export interface DeviceLostRecoveryState {
    /** @internal */
    _recovering: boolean;
    /** @internal */
    _forceNextLoss: boolean;
    /** @internal */
    _requiredFeatures: GPUFeatureName[];
    /** @internal */
    _armedDevice: GPUDevice | null;
    /** @internal */
    _registrations: DeviceLostRecoveryRegistration[];
}

function getState(engine: EngineContext): DeviceLostRecoveryState {
    return (engine._deviceLostRecovery ??= {
        _recovering: false,
        _forceNextLoss: false,
        _requiredFeatures: [],
        _armedDevice: null,
        _registrations: [],
    });
}

/** @internal Enable the shared device/surface coordinator and register one context recovery strategy. */
export function _enableDeviceLostRecovery(engine: EngineContext, registration: DeviceLostRecoveryRegistration): DeviceLostRecoveryHandle {
    const state = getState(engine);
    const registrations = state._registrations;
    const wasDisabled = registrations.length === 0;
    if (!registrations.some((current) => current._kind === registration._kind)) {
        registration._enable?.(engine);
    }
    registrations.push(registration);

    if (wasDisabled) {
        state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];
    }
    arm(engine, state);

    let disabled = false;
    return {
        disable(): void {
            if (disabled) {
                return;
            }
            disabled = true;
            registrations.splice(registrations.indexOf(registration), 1);
            if (!registrations.some((current) => current._kind === registration._kind)) {
                registration._disable?.(engine);
            }
            if (registrations.length === 0) {
                state._forceNextLoss = false;
            }
        },
    };
}

/** @internal Mark a deliberate `GPUDevice.destroy()` as a loss that should be recovered. */
export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = engine._deviceLostRecovery;
    if (!state?._registrations.length) {
        return false;
    }
    state._forceNextLoss = true;
    return true;
}

function arm(engine: EngineContext, state: DeviceLostRecoveryState): void {
    const device = engine._device;
    if (state._armedDevice === device) {
        return;
    }
    state._armedDevice = device;
    void device.lost.then(async (info) => {
        if (state._registrations.length === 0 || state._armedDevice !== device) {
            return;
        }
        const forced = state._forceNextLoss;
        state._forceNextLoss = false;
        if (info.reason === "destroyed" && !forced) {
            return;
        }

        const registrations = [...state._registrations];
        const handlers = new Map(registrations.map((registration) => [registration._kind, registration]));
        for (const registration of registrations) {
            registration._callbacks.onLost?.(info);
        }
        try {
            await recoverDevice(engine, state, handlers);
            arm(engine, state);
            for (const registration of registrations) {
                registration._callbacks.onRecovered?.();
            }
        } catch (error) {
            for (const registration of registrations) {
                registration._callbacks.onRecoveryFailed?.(error);
            }
        }
    });
}

async function recoverDevice(engine: EngineContext, state: DeviceLostRecoveryState, handlers: ReadonlyMap<string, DeviceLostRecoveryRegistration>): Promise<void> {
    if (state._recovering) {
        return;
    }
    state._recovering = true;
    const wasRunning = engine._renderFn !== null;
    stopEngine(engine);

    try {
        _assertDeviceLostRecoveryContextsSupported(engine, handlers);
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
        for (const handler of handlers.values()) {
            await handler._recover(engine);
        }
        if (wasRunning) {
            await startEngine(engine);
        }
    } finally {
        state._recovering = false;
    }
}

/** @internal Validate that every active rendering-context kind has an enabled recovery strategy. */
export function _assertDeviceLostRecoveryContextsSupported(engine: EngineContext, handlers: ReadonlyMap<string, unknown>): void {
    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (!handlers.has(context._kind)) {
                throw new Error(`Device-lost recovery is not enabled for rendering context kind "${context._kind}"`);
            }
        }
    }
}
