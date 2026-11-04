import type { EngineContext } from "./engine.js";
import type { DeviceLostRecoveryHandle } from "./device-lost-recovery-types.js";
import type { Texture2D } from "../texture/texture-2d.js";

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
    /** @internal Original descriptors for non-default samplers retained by recoverable textures. */
    _samplerDescriptors: WeakMap<GPUSampler, GPUSamplerDescriptor>;
    /** @internal Number of enabled context kinds retaining texture/mesh recovery sources. */
    _captureRefs: number;
    /** @internal Number of enabled context kinds retaining Scene mesh CPU geometry. */
    _meshCaptureRefs: number;
    /** @internal Every texture that carries a recovery source, held weakly so tracking never
     *  keeps an app texture alive. Recovery rebuilds all of these, because a recoverable texture
     *  the app owns outside any registered rendering context's object graph is otherwise never
     *  reached and silently keeps its dead-device `GPUTexture`. */
    _textures: Set<WeakRef<Texture2D>>;
    /** @internal `_textures` size that triggers compaction of entries whose texture was collected. */
    _texturesPruneAt: number;
    /** @internal Textures rebuilt during the recovery currently running and the ownership each
     *  outgoing `GPUTexture` held, carried onto the replacements once every handler has run. Lives
     *  here rather than in the rebuild module so it is scoped to one engine: a lost GPU process
     *  loses every device on the page at once, so two engines recover concurrently and their async
     *  rebuilds would otherwise share one queue — whichever finished its handlers first would top
     *  up the other engine's textures before its handlers had re-acquired them, which is exactly
     *  the inflation deferring the settle exists to prevent. One engine cannot overlap itself
     *  because `_recovering` holds arming off until its run settles. Absent between recoveries. */
    _pendingOwnership?: [Texture2D, number][];
    /** @internal Set while a recovery run on this engine is in flight, so `arm` defers. Recovery
     *  installs the replacement device on the engine long before its handlers finish, leaving
     *  `_armedDevice` naming the lost one, so a registration enabled in that window would otherwise
     *  arm the replacement. Losing it would then start a second run on this same engine, and the
     *  two would share one `_pendingOwnership` queue, one `_device` and one surface list. Nothing
     *  is dropped by waiting: the run re-arms once it resolves, and `GPUDevice.lost` is a promise,
     *  so a device lost during the window resolves for that later subscriber too. */
    _recovering?: boolean;
}

function getState(engine: EngineContext): DeviceLostRecoveryState {
    return (engine._deviceLostRecovery ??= {
        _forceNextLoss: false,
        _requiredFeatures: [],
        _armedDevice: null,
        _registrations: [],
        _samplerDescriptors: new WeakMap(),
        _captureRefs: 0,
        _meshCaptureRefs: 0,
        _textures: new Set(),
        _texturesPruneAt: 64,
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
    if (state._armedDevice === device || state._recovering) {
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
        state._recovering = true;

        const registrations = [...state._registrations];
        for (const registration of registrations) {
            registration._onLost?.(info);
        }

        void import("./device-lost-recovery-run.js")
            .then(({ runDeviceLostRecovery }) => runDeviceLostRecovery(engine, state, registrations))
            .then(
                () => {
                    state._recovering = false;
                    // Arms whatever device the engine settled on. If that device was itself lost
                    // while this run held arming off, its already-resolved `lost` fires here and
                    // the deferred recovery runs now, after this one, rather than alongside it.
                    arm(engine, state);
                    for (const registration of registrations) {
                        registration._onRecovered?.();
                    }
                },
                (error) => {
                    // Cleared but deliberately not re-armed: a failed run leaves the engine on a
                    // device that may already be lost, and arming it would spin recovery forever.
                    state._recovering = false;
                    for (const registration of registrations) {
                        registration._onRecoveryFailed?.(error);
                    }
                }
            );
    });
}
