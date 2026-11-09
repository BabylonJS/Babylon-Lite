declare const deviceContextBrand: unique symbol;

/** Canvas-independent GPU acquisition settings, fixed for the device's lifetime. */
export interface DeviceOptions {
    requiredLimits?: Record<string, GPUSize64 | undefined>;
}

/** WebGPU device acquired ahead of an engine. Native WebGPU handles remain internal.
 *  A context backs at most one engine, which takes ownership and destroys it on disposal. */
export interface DeviceContext {
    /** Opaque nominal brand; contexts must be created by createDevice. */
    readonly [deviceContextBrand]: true;
    /** @internal */
    _device: GPUDevice;
    /** @internal Creation options; device-lost recovery requests an equivalent replacement. */
    _options?: DeviceOptions;
    /** @internal Set once an engine owns the device or it was disposed unused. */
    _claimed?: boolean;
}

let _adapterOptionsHook: (() => GPURequestAdapterOptions) | null = null;
/** Explicit feature selection, installed only by `createEngineWithFeatures`; bundles that never install it fold the check away. */
let _deviceFeaturesHook: DeviceFeaturesResolver | null = null;

/** Extends `supported` (Lite's opportunistic features the adapter offers) with explicitly required features. */
type DeviceFeaturesResolver = (adapter: GPUAdapter, supported: GPUFeatureName[], options?: DeviceOptions) => GPUFeatureName[];

/** @internal Install adapter options for subsequent device creation (WebXR opt-in). */
export function _installAdapterOptions(hook: () => GPURequestAdapterOptions): void {
    _adapterOptionsHook = hook;
}

/** @internal Adapter options for creation and pre-creation capability queries. */
export function _getAdapterOptions(): GPURequestAdapterOptions {
    return _adapterOptionsHook ? _adapterOptionsHook() : {};
}

/** @internal Install explicit `requestDevice` feature selection (used by `createEngineWithFeatures`). */
export function _installDeviceFeaturesResolver(resolve: DeviceFeaturesResolver): void {
    _deviceFeaturesHook = resolve;
}

const OPTIONAL_DEVICE_FEATURES = [
    "float32-filterable",
    "texture-compression-astc",
    "texture-compression-bc",
    "texture-compression-etc2",
    "texture-compression-unaligned" as GPUFeatureName,
    "timestamp-query",
    "primitive-index",
] as const satisfies readonly GPUFeatureName[];

/** @internal Reject a device already owned by an engine or disposed. */
export function _assertDeviceAvailable(device: DeviceContext): void {
    if (device._claimed) {
        throw new Error("A DeviceContext can be used by only one engine and not after disposeDevice.");
    }
}

/** Acquire a GPU device without a canvas or engine, e.g. while the rest of the app downloads.
 *  A successful `createEngine` call takes ownership and destroys it on engine disposal.
 *  Use `disposeDevice` if no engine takes ownership. */
export async function createDevice(options?: DeviceOptions): Promise<DeviceContext> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance", ..._getAdapterOptions() });
    if (!adapter) {
        throw new Error("WebGPU adapter not available");
    }
    // Optional features are requested opportunistically so their public enable functions can activate
    // later without recreating the device. Unsupported adapters keep the corresponding feature inactive.
    const features = OPTIONAL_DEVICE_FEATURES.filter((feature) => adapter.features.has(feature));
    const device = await adapter.requestDevice({
        requiredFeatures: _deviceFeaturesHook ? _deviceFeaturesHook(adapter, features, options) : features,
        requiredLimits: options?.requiredLimits,
    });
    return { _device: device, _options: options } as Partial<DeviceContext> as DeviceContext;
}
