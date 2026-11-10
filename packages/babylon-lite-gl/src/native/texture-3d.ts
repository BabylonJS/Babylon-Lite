/**
 * 3D (volume) textures — the Babylon Native backend of `src/texture-3d.ts`, with
 * the same names and signatures.
 *
 * Volumes are uploaded through the host's `loadRawTexture3D`; hosts without it
 * report `engine.caps.texture3D === false` and {@link createTexture3DFromPixels}
 * throws there. Native binds textures per sampler uniform, so a volume shares
 * the emulated texture-unit table with 2D textures.
 *
 * NATIVE DIVERGENCES:
 * - `srgb: true` throws (the host creates raw volumes without sRGB sampling).
 * - {@link generateTexture3DMipMaps} throws (the host cannot build 3D mip chains).
 * - {@link unbindTexture3D} / `setEffectTexture3D(effect, name, null)` clear the
 *   unit only when it holds a volume (WebGL has separate 2D and 3D targets per
 *   unit; native has a single binding).
 */
import type { GLEngineContext } from "./native-context.js";
import type { GLEffect } from "./effect.js";
import type { GLTexture } from "./texture.js";
import type { GLPixelsTexture3DOptions } from "../texture-3d.js";
import { bindTexture } from "./texture.js";
import {
    dCreateTexture,
    dDeleteTexture,
    dLoadRawTexture3D,
    dSetTexture,
    dSetTextureSampling,
    dSetTextureWrap,
    dUnsetTexture,
    nativeAddressMode,
    nativeFilter,
} from "./native-device.js";

export type { GLPixelsTexture3DOptions } from "../texture-3d.js";

const GL_TEXTURE_3D = 0x806f;
const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_MIRRORED_REPEAT = 0x8370;

/** A managed 3D texture, usable with {@link setEffectTexture3D} and `sampler3D`.
 *  Same public shape as the WebGL `GLTexture3D`. */
export interface GLTexture3D extends Omit<GLTexture, "target"> {
    /** This target distinguishes 3D volumes from textures accepted by the 2D APIs (`TEXTURE_3D`, `0x806F`). */
    readonly target: 0x806f;
    /** Number of slices in the volume. */
    depth: number;
    /** @internal GL min filter. */
    _minFilter: GLenum;
    /** @internal GL mag filter. */
    _magFilter: GLenum;
    /** @internal GL S wrap. */
    _wrapS: GLenum;
    /** @internal GL T wrap. */
    _wrapT: GLenum;
    /** @internal GL R wrap. */
    _wrapR: GLenum;
    /** @internal Native address mode for R/W. */
    _wrapW: number;
}

/** Native handles that belong to live volumes (distinguishes 3D from 2D bindings). */
const volumeHandles = new WeakSet<object>();

function validWrap(mode: GLenum): boolean {
    return mode === GL_CLAMP_TO_EDGE || mode === GL_REPEAT || mode === GL_MIRRORED_REPEAT;
}

/** Clear emulated `unit` (and the current program's sampler on it) iff it holds a volume. */
function unbindVolumeUnit(engine: GLEngineContext, unit: number): void {
    const s = engine._state;
    const handle = s.boundTextures[unit];
    if (handle === null || handle === undefined || !volumeHandles.has(handle)) {
        return;
    }
    s.boundTextures[unit] = null;
    const loc = s.currentSamplers?.[unit];
    if (loc !== null && loc !== undefined) {
        dUnsetTexture(engine, loc);
    }
}

/**
 * Bind a 3D texture to an emulated sampler unit; repeated binds are elided. Use
 * {@link unbindTexture3D} to clear a unit. No-op on a lost/disposed engine or texture.
 *
 * @param tex - The 3D texture.
 * @param unit - The texture unit.
 */
export function bindTexture3D(tex: GLTexture3D, unit: number): void {
    bindTexture(tex as unknown as GLTexture, unit);
}

/**
 * Unbind the 3D texture on `unit` (cached). NATIVE: a 2D texture bound on the
 * unit is left untouched. No-op on a lost/disposed engine.
 *
 * @param engine - The engine.
 * @param unit - The texture unit.
 */
export function unbindTexture3D(engine: GLEngineContext, unit: number): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    unbindVolumeUnit(engine, unit);
}

/**
 * Bind a volume to an effect's `sampler3D` unit. Pass `null` to unbind the
 * volume on that unit (a 2D texture there is left untouched).
 *
 * @param effect - The effect.
 * @param samplerName - The sampler uniform name.
 * @param tex - The 3D texture, or `null` to clear.
 */
export function setEffectTexture3D(effect: GLEffect, samplerName: string, tex: GLTexture3D | null): void {
    const engine = effect._engine;
    if (engine._isLost || engine._disposed || !effect.isReady) {
        return;
    }
    const unit = effect.samplerUnits[samplerName];
    const loc = effect.samplerLocations[samplerName];
    if (unit === undefined || loc === null || loc === undefined || tex?._disposed) {
        return;
    }
    if (tex === null) {
        unbindVolumeUnit(engine, unit);
        return;
    }
    engine._state.boundTextures[unit] = tex.handle;
    dSetTexture(engine, loc, tex.handle);
}

/**
 * Upload a tightly packed RGBA8 volume to a native 3D texture (≙ WebGL
 * `createTexture3DFromPixels`). The default linear, clamp-to-edge sampling
 * interpolates all three axes. The source must remain unchanged for
 * device-restore replay; release the texture with {@link disposeTexture3D}.
 *
 * @param engine - The engine. Requires `engine.caps.texture3D`.
 * @param data - `width * height * depth * 4` RGBA bytes; x fastest, then y, then z.
 * @param width - X dimension, a positive integer at most `caps.maxTextureSize`.
 * @param height - Y dimension, subject to the same limit.
 * @param depth - Z dimension, subject to the same limit.
 * @param options - Filter and wrap overrides. `srgb: true` is not supported on native.
 * @returns The new {@link GLTexture3D}.
 * @throws If the host has no 3D texture support, `srgb` is requested, or the
 *  dimensions, data length, filter or address mode are invalid.
 */
export function createTexture3DFromPixels(
    engine: GLEngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    options: GLPixelsTexture3DOptions = {}
): GLTexture3D {
    if (!engine.caps.texture3D) {
        throw new Error("lite-gl: createTexture3DFromPixels needs a Babylon Native host with loadRawTexture3D (check engine.caps.texture3D)");
    }
    const maxSize = engine.caps.maxTextureSize;
    if (![width, height, depth].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= maxSize)) {
        throw new Error(`lite-gl: 3D texture dimensions must be positive integers <= ${maxSize} (got ${width}x${height}x${depth})`);
    }
    const expected = width * height * depth * 4;
    if (data.length < expected) {
        throw new Error(`lite-gl: 3D texture data too short: need ${expected} RGBA bytes, got ${data.length}`);
    }
    if (options.srgb) {
        throw new Error("lite-gl: sRGB 3D textures are not supported on Babylon Native");
    }
    const filter = options.filter ?? GL_LINEAR;
    const address = options.addressMode ?? GL_CLAMP_TO_EDGE;
    if (filter !== GL_NEAREST && filter !== GL_LINEAR) {
        throw new Error("lite-gl: 3D texture filter must be gl.NEAREST or gl.LINEAR");
    }
    if (!validWrap(address)) {
        throw new Error("lite-gl: 3D texture addressMode must be gl.CLAMP_TO_EDGE, gl.REPEAT or gl.MIRRORED_REPEAT");
    }
    const voxels = data.length === expected ? data : data.subarray(0, expected);
    const nativeAddress = nativeAddressMode(address);

    const upload = (target: GLEngineContext): void => {
        dLoadRawTexture3D(target, tex.handle, voxels, width, height, depth, _native.Engine.TEXTURE_FORMAT_RGBA8);
        dSetTextureSampling(target, tex.handle, tex._filter);
        dSetTextureWrap(target, tex.handle, tex._wrapU, tex._wrapV, tex._wrapW);
    };
    const tex: GLTexture3D = {
        handle: dCreateTexture(engine),
        target: GL_TEXTURE_3D,
        width,
        height,
        depth,
        isReady: true,
        _engine: engine,
        _disposed: false,
        _refCount: 1,
        _minFilter: filter,
        _magFilter: filter,
        _wrapS: address,
        _wrapT: address,
        _wrapR: address,
        _filter: nativeFilter(filter, filter),
        _wrapU: nativeAddress,
        _wrapV: nativeAddress,
        _wrapW: nativeAddress,
        _upload: upload,
        _restore: (target) => {
            tex.handle = dCreateTexture(target);
            volumeHandles.add(tex.handle);
            upload(target);
        },
        _deleteGpu: (target) => dDeleteTexture(target, tex.handle),
    };
    volumeHandles.add(tex.handle);
    upload(engine);
    engine._textures.push(tex as unknown as GLTexture);
    return tex;
}

/**
 * Generate a 3D texture's mip chain (≙ WebGL `generateTexture3DMipMaps`).
 *
 * NATIVE DIVERGENCE: throws — Babylon Native cannot build 3D mip chains. No-op
 * on a lost/disposed engine or texture (as WebGL).
 *
 * @param tex - The 3D texture.
 */
export function generateTexture3DMipMaps(tex: GLTexture3D): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    throw new Error("lite-gl: generateTexture3DMipMaps is not supported on Babylon Native (no 3D mip chains)");
}

/**
 * Update changed 3D min/mag filters, retained across device restore. Unchanged
 * values are elided.
 *
 * @param tex - The 3D texture.
 * @param minFilter - GL minification filter.
 * @param magFilter - GL magnification filter (`NEAREST` / `LINEAR`).
 */
export function updateTexture3DSamplingMode(tex: GLTexture3D, minFilter: GLenum, magFilter: GLenum): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed || (tex._minFilter === minFilter && tex._magFilter === magFilter)) {
        return;
    }
    if (minFilter !== GL_NEAREST && minFilter !== GL_LINEAR && (minFilter < GL_NEAREST_MIPMAP_NEAREST || minFilter > GL_LINEAR_MIPMAP_LINEAR)) {
        throw new Error("lite-gl: invalid 3D texture minification filter");
    }
    if (magFilter !== GL_NEAREST && magFilter !== GL_LINEAR) {
        throw new Error("lite-gl: 3D texture magnification filter must be gl.NEAREST or gl.LINEAR");
    }
    tex._minFilter = minFilter;
    tex._magFilter = magFilter;
    tex._filter = nativeFilter(minFilter, magFilter);
    dSetTextureSampling(engine, tex.handle, tex._filter);
}

/**
 * Update changed S/T/R wrapping, retained across device restore. Unchanged
 * values are elided.
 *
 * @param tex - The 3D texture.
 * @param wrapS - GL wrap mode for S.
 * @param wrapT - GL wrap mode for T.
 * @param wrapR - GL wrap mode for R.
 */
export function updateTexture3DWrapMode(tex: GLTexture3D, wrapS: GLenum, wrapT: GLenum, wrapR: GLenum): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed || (tex._wrapS === wrapS && tex._wrapT === wrapT && tex._wrapR === wrapR)) {
        return;
    }
    if (!validWrap(wrapS) || !validWrap(wrapT) || !validWrap(wrapR)) {
        throw new Error("lite-gl: 3D texture wrap mode must be gl.CLAMP_TO_EDGE, gl.REPEAT or gl.MIRRORED_REPEAT");
    }
    tex._wrapS = wrapS;
    tex._wrapT = wrapT;
    tex._wrapR = wrapR;
    tex._wrapU = nativeAddressMode(wrapS);
    tex._wrapV = nativeAddressMode(wrapT);
    tex._wrapW = nativeAddressMode(wrapR);
    dSetTextureWrap(engine, tex.handle, tex._wrapU, tex._wrapV, tex._wrapW);
}

/**
 * Dispose a 3D texture: shared references decrement; the final release deletes
 * the native handle, unregisters it and clears every unit still holding it.
 * Repeated disposal is a no-op.
 *
 * @param tex - The 3D texture.
 */
export function disposeTexture3D(tex: GLTexture3D): void {
    if (tex._disposed) {
        return;
    }
    if (tex._refCount > 1) {
        tex._refCount--;
        return;
    }
    const engine = tex._engine;
    tex._disposed = true;
    tex.isReady = false;
    const i = engine._textures.indexOf(tex as unknown as GLTexture);
    if (i !== -1) {
        engine._textures.splice(i, 1);
    }
    const live = !engine._isLost && !engine._disposed;
    const s = engine._state;
    for (let unit = 0; unit < s.boundTextures.length; unit++) {
        if (s.boundTextures[unit] === tex.handle) {
            if (live) {
                unbindVolumeUnit(engine, unit);
            } else {
                s.boundTextures[unit] = null;
            }
        }
    }
    volumeHandles.delete(tex.handle);
    if (live) {
        dDeleteTexture(engine, tex.handle);
    }
}
