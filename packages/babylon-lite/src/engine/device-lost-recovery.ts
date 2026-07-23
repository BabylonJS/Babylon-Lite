import type { EngineContext } from "./engine.js";
import type { DeviceLostRecoveryHandle } from "./device-lost-recovery-types.js";

/** @internal */
export interface DeviceLostRecoveryRegistration {
    /** @internal */
    _kind: string;
    /** @internal */
    _recover: (engine: EngineContext) => void | Promise<void>;
    /** @internal Lower values rebuild shared renderer resources before dependent scene graphs. */
    _recoverOrder?: number;
    /** @internal */
    _enable?: (engine: EngineContext) => void;
    /** @internal */
    _disable?: (engine: EngineContext) => void;
    /** @internal */
    _onLost?: (info: GPUDeviceLostInfo) => void;
    /** @internal */
    _onRecovered?: () => void;
    /** @internal */
    _onRecoveryFailed?: (error: unknown) => void;
}

/** @internal */
export interface DeviceLostRecoveryState {
    /** @internal */
    _forceNextLoss: boolean;
    /** @internal */
    _requiredFeatures: GPUFeatureName[];
    /** @internal */
    _armedDevice: GPUDevice | null;
    /** @internal */
    _registrations: DeviceLostRecoveryRegistration[];
    /** @internal Number of enabled context kinds retaining texture/mesh recovery sources. */
    _captureRefs: number;
    /** @internal Number of enabled context kinds retaining Scene mesh CPU geometry. */
    _meshCaptureRefs: number;
}

function getState(engine: EngineContext): DeviceLostRecoveryState {
    return (engine._deviceLostRecovery ??= {
        _forceNextLoss: false,
        _requiredFeatures: [],
        _armedDevice: null,
        _registrations: [],
        _captureRefs: 0,
        _meshCaptureRefs: 0,
    });
}

/** @internal Enable the shared device/surface coordinator and register one context recovery strategy. */
export function _enableDeviceLostRecovery(engine: EngineContext, registration: DeviceLostRecoveryRegistration): DeviceLostRecoveryHandle {
    const state = getState(engine);
    const registrations = state._registrations;
    if (registrations.length === 0) {
        state._requiredFeatures = Array.from(engine._device.features) as GPUFeatureName[];
    }
    if (!registrations.some((current) => current._kind === registration._kind)) {
        registration._enable?.(engine);
    }
    registrations.push(registration);
    arm(engine, state);

    let disabled = false;
    return {
        disable(): void {
            if (disabled) {
                return;
            }
            disabled = true;
            const index = registrations.indexOf(registration);
            if (index >= 0) {
                registrations.splice(index, 1);
            }
            if (!registrations.some((current) => current._kind === registration._kind)) {
                registration._disable?.(engine);
            }
        },
    };
}

/** @internal Mark a deliberate `GPUDevice.destroy()` as a loss that should be recovered. */
export function markNextDeviceLossForRecovery(engine: EngineContext): boolean {
    const state = engine._deviceLostRecovery;
    return !!state?._registrations.length && (state._forceNextLoss = true);
}

function arm(engine: EngineContext, state: DeviceLostRecoveryState): void {
    const device = engine._device;
    if (state._armedDevice === device) {
        return;
    }
    state._armedDevice = device;
    void device.lost.then((info) => {
        if (state._registrations.length === 0 || state._armedDevice !== device) {
            return;
        }
        if (info.reason === "destroyed" && !state._forceNextLoss) {
            return;
        }
        state._forceNextLoss = false;

        const registrations = [...state._registrations];
        for (const registration of registrations) {
            registration._onLost?.(info);
        }

        void import("./device-lost-recovery-run.js")
            .then(({ _runDeviceLostRecovery }) => _runDeviceLostRecovery(engine, state, registrations))
            .then(
                () => {
                    arm(engine, state);
                    for (const registration of registrations) {
                        registration._onRecovered?.();
                    }
                },
                (error) => {
                    for (const registration of registrations) {
                        registration._onRecoveryFailed?.(error);
                    }
                }
            );
    });
}
