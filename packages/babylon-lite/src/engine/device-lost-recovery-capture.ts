import type { DeviceLostRecoveryState } from "./device-lost-recovery.js";
import type { EngineContext } from "./engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { PixelsTexture2DOptions } from "../texture/pixels-texture.js";
import type { Texture2D, Texture2DOptions, Texture2DRecoverySource } from "../texture/texture-2d.js";
import { _setDerivedTexture2DHook } from "../texture/texture-2d.js";

/** Smallest tracked-texture count worth compacting; below this, scanning costs more than it saves. */
const TEXTURE_PRUNE_FLOOR = 64;

/** The recovery state that captured each source.
 *
 *  A wrapper derived from a captured texture has to be tracked by the engine that captured it, and
 *  `cloneTexture2D` — public API, reached from glTF through `GltfFeature.wrapTexture` — is handed
 *  no engine. Keyed by source rather than by base wrapper because that is what every wrapper in a
 *  family has in common — a clone does not keep its base alive, so the base may well be collected
 *  first. The state is held weakly so an app holding a texture past its engine does not pin that
 *  engine's registrations, and through them its whole scene graph. */
let _sourceOwners: WeakMap<Texture2DRecoverySource, WeakRef<DeviceLostRecoveryState>> | null = null;

/**
 * Stamps `source` on `tex` and tracks `tex` so recovery rebuilds it.
 *
 * Recovery reaches most textures by walking a registered rendering context's object graph (scene
 * materials, sprite layer atlases). An app is free to own a recoverable texture that no such graph
 * currently references — a sprite atlas page whose glyphs have not been drawn yet is the canonical
 * case — and that texture would then survive recovery still pointing at the lost device. Every
 * captured texture goes through here, so it is rebuilt whether or not anything references it, and
 * textures are held weakly so tracking never extends a texture's lifetime.
 */
function stampTexture(state: DeviceLostRecoveryState, tex: Texture2D, source: Texture2DRecoverySource): void {
    tex._recoverySource = source;
    const textures = state._textures;
    if (textures.size >= state._texturesPruneAt) {
        for (const ref of textures) {
            if (!ref.deref()) {
                textures.delete(ref);
            }
        }
        state._texturesPruneAt = Math.max(TEXTURE_PRUNE_FLOOR, textures.size * 2);
    }
    textures.add(new WeakRef(tex));
}

/**
 * Tracks a wrapper derived from an already-captured texture as a captured texture in its own right.
 *
 * A derived wrapper is a plain spread of its base, so it inherits `_recoverySource` without ever
 * passing through the capture stamp — nothing tracked it, yet it owns its own `texture` field.
 * Left untracked it survives recovery still holding the lost device's `GPUTexture`, which is the
 * use-after-free tracking exists to prevent, reached one hop later. Tracking it here rather than in
 * a parallel registry means it is found even if its base is collected first, and it is pruned on
 * the same schedule as every other tracked texture. Rebuilding is keyed on the shared source, so a
 * whole wrapper family still costs a single upload.
 */
function trackDerivedTexture(base: Texture2D, derived: Texture2D): void {
    const source = base._recoverySource;
    if (!source) {
        return;
    }
    const state = _sourceOwners?.get(source)?.deref();
    if (state) {
        stampTexture(state, derived, source);
    }
}

function attachRecoveryCapture(engine: EngineContext): void {
    const state = engine._deviceLostRecovery!;
    const owner = new WeakRef(state);
    const stamp = (tex: Texture2D, source: Texture2DRecoverySource): void => {
        (_sourceOwners ??= new WeakMap()).set(source, owner);
        stampTexture(state, tex, source);
    };
    // Engine-agnostic and inert unless a source has been captured, so it is installed on first
    // capture and left in place — clearing it when one engine releases capture would stop tracking
    // for any other engine still capturing.
    _setDerivedTexture2DHook(trackDerivedTexture);
    engine._dlr = {
        t: stamp,
        d: trackDerivedTexture,
        u(tex: Texture2D, url: string, opts: Texture2DOptions): void {
            stamp(tex, { kind: "url", url, opts: { ...opts } });
        },
        s(tex: Texture2D, r: number, g: number, b: number, a: number): void {
            stamp(tex, { kind: "solid", rgba: [r, g, b, a] });
        },
        b(tex: Texture2D, bitmap: ImageBitmap | null, srgb: boolean, mipMaps: boolean, fallback?: Uint8Array): void {
            stamp(tex, {
                kind: "bitmap",
                bitmap,
                srgb,
                mipMaps,
                fallback,
            });
        },
        p(tex: Texture2D, data: Uint8Array, options: PixelsTexture2DOptions): void {
            stamp(tex, {
                kind: "pixels",
                data: data.slice(0, tex.width * tex.height * 4),
                width: tex.width,
                height: tex.height,
                options: { ...options },
            });
        },
        r(tex: Texture2D, width: number, height: number, format: GPUTextureFormat, samplerDesc: GPUSamplerDescriptor): void {
            stamp(tex, { kind: "render", width, height, format, samplerDesc });
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
