import type { EngineContext } from "../engine/engine.js";
import type { ComputeDispatch, ComputeImmediateData } from "./compute-dispatch.js";
import type { ComputeShader, ComputeShaderOptions } from "./compute-shader.js";
import { _assertComputeShaderLive, _installComputePipelineLayoutDescriptorExtension, createComputeShader } from "./compute-shader.js";
import { _installComputeDispatchPrepareRecord } from "./compute-task.js";

/** Compute-shader options with a fully initialized WebGPU immediate-data range. */
export interface ComputeImmediateShaderOptions extends ComputeShaderOptions {
    /** Immediate range in bytes. Must be a positive multiple of four within the device's maxImmediateSize. */
    readonly immediateByteLength: number;
}

let _hooksInstalled = false;

function ensureHooks(): void {
    if (_hooksInstalled) {
        return;
    }
    _hooksInstalled = true;
    _installComputePipelineLayoutDescriptorExtension((shader) => (shader._immediateByteLength ? { immediateSize: shader._immediateByteLength } : undefined));
    _installComputeDispatchPrepareRecord((pass, dispatch) => {
        const byteLength = dispatch.shader._immediateByteLength;
        if (!byteLength) {
            return;
        }
        const data = dispatch._immediates;
        if (!data || data.byteLength !== byteLength) {
            throw new Error(`ComputeDispatch: immediate data must initialize all ${byteLength} bytes before dispatch.`);
        }
        pass.setImmediates(0, data);
    });
}

/** Whether this browser exposes WGSL's `immediate_address_space`. */
export function isComputeImmediatesSupported(): boolean {
    return globalThis.navigator?.gpu?.wgslLanguageFeatures.has("immediate_address_space") === true;
}

/** Create a compute program whose explicit pipeline layout includes an immediate-data range. */
export function createComputeImmediateShader(engine: EngineContext, options: ComputeImmediateShaderOptions): ComputeShader {
    if (!isComputeImmediatesSupported()) {
        throw new Error("createComputeImmediateShader requires WGSL immediate_address_space support.");
    }
    const byteLength = options.immediateByteLength;
    const maximum = Number(engine._device.limits.maxImmediateSize) || 64;
    if (!Number.isInteger(byteLength) || byteLength <= 0 || (byteLength & 3) !== 0 || byteLength > maximum) {
        throw new Error(`createComputeImmediateShader: immediateByteLength must be a positive multiple of 4 no larger than ${maximum}.`);
    }
    ensureHooks();
    const shader = createComputeShader(engine, options);
    shader._immediateByteLength = byteLength;
    return shader;
}

/** Retain the complete immediate-data image used by this dispatch. The view may be mutated between executions. */
export function setComputeDispatchImmediates(dispatch: ComputeDispatch, data: ComputeImmediateData): void {
    _assertComputeShaderLive(dispatch.shader);
    const byteLength = dispatch.shader._immediateByteLength;
    if (!byteLength) {
        throw new Error("setComputeDispatchImmediates requires a shader created with createComputeImmediateShader.");
    }
    if (data.byteLength !== byteLength) {
        throw new Error(`setComputeDispatchImmediates requires exactly ${byteLength} bytes, received ${data.byteLength}.`);
    }
    ensureHooks();
    dispatch._immediates = data;
}
