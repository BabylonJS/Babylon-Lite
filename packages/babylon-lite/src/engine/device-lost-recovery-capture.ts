import type { EngineContext } from "./engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { PixelsTexture2DOptions } from "../texture/pixels-texture.js";
import type { Texture2D, Texture2DOptions } from "../texture/texture-2d.js";

function attachRecoveryCapture(engine: EngineContext): void {
    const state = engine._deviceLostRecovery!;
    engine._dlr = {
        u(tex: Texture2D, url: string, opts: Texture2DOptions): void {
            tex._recoverySource = { kind: "url", url, opts: { ...opts } };
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
            };
        },
        p(tex: Texture2D, data: Uint8Array, options: PixelsTexture2DOptions): void {
            tex._recoverySource = {
                kind: "pixels",
                data: data.slice(0, tex.width * tex.height * 4),
                width: tex.width,
                height: tex.height,
                options: { ...options },
            };
        },
        r(tex: Texture2D, width: number, height: number, format: GPUTextureFormat, samplerDesc: GPUSamplerDescriptor): void {
            tex._recoverySource = { kind: "render", width, height, format, samplerDesc };
        },
        w(tex: Texture2D, data: Uint8Array, x: number, y: number, width: number, height: number, dataOffset = 0, bytesPerRow = width * 4): void {
            const source = tex._recoverySource;
            if (source?.kind !== "pixels") {
                return;
            }
            const rowBytes = width * 4;
            for (let row = 0; row < height; row++) {
                const srcStart = dataOffset + row * bytesPerRow;
                const dstStart = ((y + row) * source.width + x) * 4;
                source.data.set(data.subarray(srcStart, srcStart + rowBytes), dstStart);
            }
        },
        m(
            mesh: Mesh,
            uv2s: Float32Array | null | undefined,
            tangents: Float32Array | null | undefined,
            colors: Float32Array | null | undefined,
            gpuIndices: Uint16Array | Uint32Array,
            indexFormat: GPUIndexFormat
        ): void {
            if (!engine._deviceLostRecovery?._meshCaptureRefs) {
                return;
            }
            mesh._cpuUv2s = uv2s ?? null;
            mesh._cpuTangents = tangents ?? null;
            mesh._cpuColors = colors ?? null;
            mesh._cpuGpuIndices = gpuIndices;
            mesh._cpuIndexFormat = indexFormat;
        },
        e(scene: SceneContext, url: string, brdfUrl: string): void {
            if (state._meshCaptureRefs) {
                scene._envRecoverySource = { kind: "env", url, brdfUrl };
            }
        },
        h(scene: SceneContext, url: string, faceSize: number): void {
            if (state._meshCaptureRefs) {
                scene._envRecoverySource = { kind: "hdr", url, faceSize };
            }
        },
    };
}

/** @internal Retain opt-in recovery-source capture for one enabled context kind. */
export function _retainDeviceLostRecoveryCapture(engine: EngineContext, includeMeshes = false): void {
    const state = engine._deviceLostRecovery;
    if (!state) {
        throw new Error("Device-lost recovery capture requires an enabled recovery coordinator");
    }
    state._captureRefs++;
    if (includeMeshes) {
        state._meshCaptureRefs++;
    }
    if (state._captureRefs === 1) {
        attachRecoveryCapture(engine);
    }
}

/** @internal Release recovery-source capture after the last capture-using kind is disabled. */
export function _releaseDeviceLostRecoveryCapture(engine: EngineContext, includeMeshes = false): void {
    const state = engine._deviceLostRecovery;
    if (!state || state._captureRefs === 0) {
        return;
    }
    state._captureRefs--;
    if (includeMeshes && state._meshCaptureRefs > 0) {
        state._meshCaptureRefs--;
    }
    if (state._captureRefs === 0) {
        engine._dlr = undefined;
    }
}
