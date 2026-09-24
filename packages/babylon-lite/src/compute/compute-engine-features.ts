import type { EngineContext, EngineOptions, RenderCanvas } from "../engine/engine.js";
import { _getSupportedDeviceFeatures, _installDeviceFeaturesResolver, createEngine } from "../engine/engine.js";

/** Engine options that explicitly require additional WebGPU device features. */
export interface EngineFeatureOptions extends EngineOptions {
    readonly requiredFeatures: readonly GPUFeatureName[];
}

let _installed = false;

function installRequiredFeatureResolver(): void {
    if (_installed) {
        return;
    }
    _installed = true;
    _installDeviceFeaturesResolver((adapter, options) => {
        const features = _getSupportedDeviceFeatures(adapter);
        for (const feature of (options as EngineFeatureOptions | undefined)?.requiredFeatures ?? []) {
            if (!adapter.features.has(feature)) {
                throw new Error(`WebGPU adapter does not support required feature "${feature}".`);
            }
            if (!features.includes(feature)) {
                features.push(feature);
            }
        }
        return features;
    });
}

/** Create an engine after validating and requesting explicit adapter-supported WebGPU features. */
export function createEngineWithFeatures(canvas: RenderCanvas, options: EngineFeatureOptions): Promise<EngineContext> {
    installRequiredFeatureResolver();
    return createEngine(canvas, options);
}
