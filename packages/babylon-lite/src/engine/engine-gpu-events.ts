import type { EngineContext } from "./engine.js";

/** Receives a WebGPU validation, out-of-memory or internal error that no error scope caught. */
export type EngineGpuErrorCallback = (error: GPUError) => void;

/** Receives the loss of the engine's device. `info.reason` is `"destroyed"` after `disposeEngine` (or a forced test loss). */
export type EngineDeviceLostCallback = (info: GPUDeviceLostInfo) => void;

/** @internal Listener registry installed on the first subscription. */
export interface EngineGpuEvents {
    /** @internal */
    readonly _errors: Set<EngineGpuErrorCallback>;
    /** @internal */
    readonly _lost: Set<EngineDeviceLostCallback>;
    /** @internal Device the listeners are attached to. */
    _device: GPUDevice | null;
    /** @internal */
    readonly _onError: (event: Event) => void;
}

function attach(engine: EngineContext): void {
    const events = engine._gpuEvents!;
    const device = engine._device;
    if (events._device === device) {
        return;
    }
    events._device?.removeEventListener("uncapturederror", events._onError);
    events._device = device;
    device.addEventListener("uncapturederror", events._onError);
    void device.lost.then((info) => {
        // A replaced device (device-lost recovery) reports through its own subscription.
        if (events._device !== device) {
            return;
        }
        for (const callback of events._lost) {
            callback(info);
        }
    });
}

function eventsFor(engine: EngineContext): EngineGpuEvents {
    let events = engine._gpuEvents;
    if (!events) {
        const errors = new Set<EngineGpuErrorCallback>();
        events = engine._gpuEvents = {
            _errors: errors,
            _lost: new Set(),
            _device: null,
            _onError: (event) => {
                const error = (event as GPUUncapturedErrorEvent).error;
                for (const callback of errors) {
                    callback(error);
                }
            },
        };
        // Device-lost recovery calls this after installing the replacement device.
        engine._attachGpuEvents = attach;
    }
    attach(engine);
    return events;
}

/**
 * Subscribe to GPU errors that no error scope caught on the engine's device, and on any device that
 * device-lost recovery installs later. WebGPU otherwise only logs them, and a broken pipeline renders
 * nothing without failing. Returns the unsubscribe function.
 */
export function onEngineGpuError(engine: EngineContext, callback: EngineGpuErrorCallback): () => void {
    const events = eventsFor(engine);
    events._errors.add(callback);
    return () => {
        events._errors.delete(callback);
    };
}

/**
 * Subscribe to the loss of the engine's device, whether or not device-lost recovery is enabled; with recovery,
 * the callback runs once per lost device, before the replacement is requested. Returns the unsubscribe function.
 */
export function onEngineDeviceLost(engine: EngineContext, callback: EngineDeviceLostCallback): () => void {
    const events = eventsFor(engine);
    events._lost.add(callback);
    return () => {
        events._lost.delete(callback);
    };
}

/** The limits of the engine's current device, for sizing buffers, arrays and dispatches. Read-only information. */
export function getEngineLimits(engine: EngineContext): GPUSupportedLimits {
    return engine._device.limits;
}

/** Whether the engine's current device enabled an optional WebGPU feature (see `createEngineWithFeatures`). */
export function hasEngineFeature(engine: EngineContext, feature: GPUFeatureName): boolean {
    return engine._device.features.has(feature);
}
