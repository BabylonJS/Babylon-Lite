import type { EngineContext } from "./engine.js";
import { _enableDeviceLostRecovery } from "./device-lost-recovery.js";
import type { DeviceLostRecoveryHandle } from "./device-lost-recovery.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";
import type { Mesh } from "../mesh/mesh.js";
import { clearSceneBGLCache } from "../render/scene-helpers.js";

export interface DeviceLostSceneRecoveryOptions {
    /** Called immediately after loss is detected and before a replacement device is requested. */
    onLost?: (info: GPUDeviceLostInfo) => void;
    /** Called after the replacement device, surfaces, and SceneContexts are ready. */
    onRecovered?: () => void;
    /** Called when replacement-device acquisition or SceneContext rebuilding fails. */
    onRecoveryFailed?: (error: unknown) => void;
}

export type DeviceLostSceneRecoveryHandle = DeviceLostRecoveryHandle;

function attachRecoveryCapture(engine: EngineContext): void {
    engine._dlr = {
        u(tex: Texture2D, url: string, opts: Texture2DOptions): void {
            tex._recoverySource = { kind: "url", url, opts };
        },
        s(tex: Texture2D, r: number, g: number, b: number, a: number): void {
            tex._recoverySource = { kind: "solid", rgba: [r, g, b, a] };
        },
        b(tex: Texture2D, bitmap: ImageBitmap | null, srgb: boolean, mipMaps: boolean, fallback?: Uint8Array): void {
            tex._recoverySource = {
                kind: "bitmap",
                bitmap,
                srgb,
                mipMaps,
                fallback,
                samplerDesc: {
                    addressModeU: "repeat",
                    addressModeV: "repeat",
                    minFilter: "linear",
                    magFilter: "linear",
                    mipmapFilter: mipMaps ? "linear" : "nearest",
                },
            };
        },
        m(
            mesh: Mesh,
            uv2s: Float32Array | null | undefined,
            tangents: Float32Array | null | undefined,
            colors: Float32Array | null | undefined,
            gpuIndices: Uint16Array | Uint32Array,
            indexFormat: GPUIndexFormat
        ): void {
            mesh._cpuUv2s = uv2s ?? null;
            mesh._cpuTangents = tangents ?? null;
            mesh._cpuColors = colors ?? null;
            mesh._cpuGpuIndices = gpuIndices;
            mesh._cpuIndexFormat = indexFormat;
        },
    };
}

/**
 * Enable best-effort WebGPU device-lost recovery for every registered SceneContext.
 *
 * Device reacquisition is coordinated per engine so additional renderer-specific
 * recovery strategies can share the same replacement device. Active context kinds
 * without an enabled strategy cause recovery to fail explicitly.
 */
export function enableDeviceLostSceneRecovery(engine: EngineContext, options: DeviceLostSceneRecoveryOptions = {}): DeviceLostSceneRecoveryHandle {
    return _enableDeviceLostRecovery(engine, {
        _kind: "scene",
        _enable: attachRecoveryCapture,
        _disable(currentEngine): void {
            currentEngine._dlr = undefined;
        },
        async _recover(currentEngine): Promise<void> {
            clearSceneBGLCache();
            const { rebuildRegisteredScenes } = await import("./recovery-rebuild.js");
            await rebuildRegisteredScenes(currentEngine);
        },
        _onLost: options.onLost,
        _onRecovered: options.onRecovered,
        _onRecoveryFailed: options.onRecoveryFailed,
    });
}
