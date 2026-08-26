import { _installAdapterOptions } from "../engine/engine.js";

/**
 * Request an **XR-compatible** GPU adapter for engines created after this call.
 *
 * Call this once, **before** {@link createEngine}, if you intend to enter an immersive WebGPU XR
 * session with that engine. The draft WebXR/WebGPU binding throws `InvalidStateError` when
 * `XRGPUBinding` is constructed with a device whose adapter was not XR-compatible, and WebGPU offers
 * no way to upgrade an existing device (unlike WebGL's `makeXRCompatible()`), so the adapter must be
 * requested with `{ xrCompatible: true }` up front.
 *
 * Implemented as an explicit opt-in installer (not a `createEngine` option) so non-XR apps that never
 * import this stay byte-identical — `createEngine`'s adapter request folds to its default when no hook
 * is installed. The choice persists across device-lost recovery. See {@link enterXr}.
 */
export function enableXrCompatibleAdapter(): void {
    _installAdapterOptions(() => ({ xrCompatible: true }));
}
