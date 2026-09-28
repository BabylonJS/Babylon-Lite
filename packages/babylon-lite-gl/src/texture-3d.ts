import { onContextLost, type GLEngineContext } from "./context.js";
import type { GLEffect } from "./effect.js";
import { setUnpackState, type GLTexture } from "./texture.js";

/** Sampling and format overrides for {@link createTexture3DFromPixels}. */
export interface GLPixelsTexture3DOptions {
    /** Wrap mode on all three axes. Defaults to `gl.CLAMP_TO_EDGE`. */
    addressMode?: GLenum;
    /** Minification and magnification filter. Defaults to `gl.LINEAR` (trilinear sampling without mipmaps). */
    filter?: GLenum;
    /** Decode sRGB texels on sampling. Defaults to false (`gl.RGBA8`). */
    srgb?: boolean;
}

/** A managed `gl.TEXTURE_3D` handle, usable with `setEffectTexture3D` and `sampler3D`. */
export interface GLTexture3D extends Omit<GLTexture, "target"> {
    /** This target distinguishes 3D volumes from textures accepted by the 2D APIs. */
    readonly target: WebGL2RenderingContext["TEXTURE_3D"];
    /** Number of slices in the volume. */
    depth: number;
    /** @internal */
    _minFilter: GLenum;
    /** @internal */
    _magFilter: GLenum;
    /** @internal */
    _wrapS: GLenum;
    /** @internal */
    _wrapT: GLenum;
    /** @internal */
    _wrapR: GLenum;
    /** @internal */
    _hasMipMaps: boolean;
}

function boundTextures3D(engine: GLEngineContext): (WebGLTexture | null | undefined)[] {
    const state = engine._state;
    if (state._boundTextures3D !== undefined) {
        return state._boundTextures3D;
    }
    const bound = new Array<WebGLTexture | null | undefined>(state.boundTextures.length).fill(undefined);
    state._boundTextures3D = bound;
    const invalidate = (): void => {
        bound.fill(undefined);
        state._unpack3DLayoutKnown = false;
    };
    onContextLost(engine, invalidate);
    (engine._stateCacheInvalidators ??= []).push(invalidate);
    return bound;
}

function bindTexture3DRaw(engine: GLEngineContext, unit: number, handle: WebGLTexture | null, forUpload: boolean): void {
    const state = engine._state;
    const bound = boundTextures3D(engine);
    if (bound[unit] === handle && !forUpload) {
        return;
    }
    const gl = engine.gl;
    if (state.activeTextureUnit !== unit || bound[unit] === undefined) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        state.activeTextureUnit = unit;
    }
    if (bound[unit] !== handle) {
        gl.bindTexture(gl.TEXTURE_3D, handle);
        bound[unit] = handle;
    }
}

function setUnpack3DLayout(engine: GLEngineContext): void {
    if (engine._state._unpack3DLayoutKnown) {
        return;
    }
    const gl = engine.gl;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    engine._state._unpack3DLayoutKnown = true;
}

/** Bind a 3D texture to one sampler unit. `null` unbinds only `TEXTURE_3D`; repeated binds are elided. */
export function bindTexture3D(engine: GLEngineContext, unit: number, tex: GLTexture3D | null): void {
    if (engine._isLost || engine._disposed || tex?._disposed) {
        return;
    }
    bindTexture3DRaw(engine, unit, tex?.handle ?? null, false);
}

/**
 * Bind a volume to an effect's pre-assigned `sampler3D` unit without reissuing
 * `uniform1i`. Pass `null` to unbind only the 3D target on that unit.
 */
export function setEffectTexture3D(engine: GLEngineContext, effect: GLEffect, samplerName: string, tex: GLTexture3D | null): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const unit = effect.samplerUnits[samplerName];
    if (unit === undefined) {
        return;
    }
    bindTexture3D(engine, unit, tex);
}

/**
 * Upload a tightly packed RGBA8 volume to a native WebGL2 3D texture. Useful
 * for color-grading LUTs without flattening the cube into a 2D atlas. The
 * default linear, clamp-to-edge sampling interpolates all three axes in
 * hardware. The source must remain unchanged for context-restore replay;
 * release the texture with `disposeTexture3D` when done.
 *
 * @param engine - WebGL2 engine.
 * @param data - `width * height * depth * 4` RGBA bytes; x fastest, then y, then z.
 * @param width - X dimension, a positive integer at most `MAX_3D_TEXTURE_SIZE`.
 * @param height - Y dimension, subject to the same limit.
 * @param depth - Z dimension, subject to the same limit.
 * @param options - Filter, wrap, and sRGB overrides.
 */
export function createTexture3DFromPixels(
    engine: GLEngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    options: GLPixelsTexture3DOptions = {}
): GLTexture3D {
    const gl = engine.gl;
    const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (![width, height, depth].every((size) => Number.isSafeInteger(size) && size >= 1 && size <= maxSize)) {
        throw new Error(`lite-gl: 3D texture dimensions must be positive integers <= ${maxSize} (got ${width}x${height}x${depth})`);
    }
    const expected = width * height * depth * 4;
    if (data.length < expected) {
        throw new Error(`lite-gl: 3D texture data too short: need ${expected} RGBA bytes, got ${data.length}`);
    }
    const format = options.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    const filter = options.filter ?? gl.LINEAR;
    const address = options.addressMode ?? gl.CLAMP_TO_EDGE;
    if (filter !== gl.NEAREST && filter !== gl.LINEAR) {
        throw new Error("lite-gl: 3D texture filter must be gl.NEAREST or gl.LINEAR");
    }
    if (address !== gl.CLAMP_TO_EDGE && address !== gl.REPEAT && address !== gl.MIRRORED_REPEAT) {
        throw new Error("lite-gl: 3D texture addressMode must be gl.CLAMP_TO_EDGE, gl.REPEAT or gl.MIRRORED_REPEAT");
    }
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, false, false, 4);
        setUnpack3DLayout(target);
        bindTexture3DRaw(target, 0, tex.handle, true);
        g.texImage3D(g.TEXTURE_3D, 0, format, width, height, depth, 0, g.RGBA, g.UNSIGNED_BYTE, data);
        if (tex._hasMipMaps) {
            g.generateMipmap(g.TEXTURE_3D);
        }
    };
    const initializeParameters = (target: GLEngineContext): void => {
        const g = target.gl;
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MIN_FILTER, tex._minFilter);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_MAG_FILTER, tex._magFilter);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_S, tex._wrapS);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_T, tex._wrapT);
        g.texParameteri(g.TEXTURE_3D, g.TEXTURE_WRAP_R, tex._wrapR);
    };
    const tex: GLTexture3D = {
        handle,
        target: gl.TEXTURE_3D,
        width,
        height,
        depth,
        isReady: true,
        _minFilter: filter,
        _magFilter: filter,
        _wrapS: address,
        _wrapT: address,
        _wrapR: address,
        _hasMipMaps: false,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _initializeParameters: initializeParameters,
        _wasReady: true,
    };
    upload(engine);
    initializeParameters(engine);
    engine._textures.push(tex);
    return tex;
}

/** Generate a full 3D mip chain for an existing volume and replay it on context restoration. No-op after loss or disposal. */
export function generateTexture3DMipMaps(engine: GLEngineContext, tex: GLTexture3D): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    bindTexture3DRaw(engine, 0, tex.handle, true);
    engine.gl.generateMipmap(engine.gl.TEXTURE_3D);
    tex._hasMipMaps = true;
}

/** Update changed 3D min/mag filters and retain them across context restoration. Unchanged values are elided. */
export function updateTexture3DSamplingMode(engine: GLEngineContext, tex: GLTexture3D, minFilter: GLenum, magFilter: GLenum): void {
    if (engine._isLost || engine._disposed || tex._disposed || (tex._minFilter === minFilter && tex._magFilter === magFilter)) {
        return;
    }
    const gl = engine.gl;
    if (
        minFilter !== gl.NEAREST &&
        minFilter !== gl.LINEAR &&
        minFilter !== gl.NEAREST_MIPMAP_NEAREST &&
        minFilter !== gl.LINEAR_MIPMAP_NEAREST &&
        minFilter !== gl.NEAREST_MIPMAP_LINEAR &&
        minFilter !== gl.LINEAR_MIPMAP_LINEAR
    ) {
        throw new Error("lite-gl: invalid 3D texture minification filter");
    }
    if (magFilter !== gl.NEAREST && magFilter !== gl.LINEAR) {
        throw new Error("lite-gl: 3D texture magnification filter must be gl.NEAREST or gl.LINEAR");
    }
    bindTexture3DRaw(engine, 0, tex.handle, true);
    if (tex._minFilter !== minFilter) {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, minFilter);
        tex._minFilter = minFilter;
    }
    if (tex._magFilter !== magFilter) {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, magFilter);
        tex._magFilter = magFilter;
    }
}

function validTexture3DWrap(gl: WebGL2RenderingContext, mode: GLenum): boolean {
    return mode === gl.CLAMP_TO_EDGE || mode === gl.REPEAT || mode === gl.MIRRORED_REPEAT;
}

/** Update changed S/T/R wrapping and retain it across context restoration. Unchanged values are elided. */
export function updateTexture3DWrapMode(engine: GLEngineContext, tex: GLTexture3D, wrapS: GLenum, wrapT: GLenum, wrapR: GLenum): void {
    if (engine._isLost || engine._disposed || tex._disposed || (tex._wrapS === wrapS && tex._wrapT === wrapT && tex._wrapR === wrapR)) {
        return;
    }
    const gl = engine.gl;
    if (!validTexture3DWrap(gl, wrapS) || !validTexture3DWrap(gl, wrapT) || !validTexture3DWrap(gl, wrapR)) {
        throw new Error("lite-gl: 3D texture wrap mode must be gl.CLAMP_TO_EDGE, gl.REPEAT or gl.MIRRORED_REPEAT");
    }
    bindTexture3DRaw(engine, 0, tex.handle, true);
    if (tex._wrapS !== wrapS) {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, wrapS);
        tex._wrapS = wrapS;
    }
    if (tex._wrapT !== wrapT) {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, wrapT);
        tex._wrapT = wrapT;
    }
    if (tex._wrapR !== wrapR) {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, wrapR);
        tex._wrapR = wrapR;
    }
}

/** Dispose a 3D texture and invalidate any units that still reference its handle. */
export function disposeTexture3D(engine: GLEngineContext, tex: GLTexture3D): void {
    if (tex._disposed) {
        return;
    }
    if (tex._refCount > 1) {
        tex._refCount--;
        return;
    }
    tex._disposed = true;
    const index = engine._textures.indexOf(tex);
    if (index !== -1) {
        engine._textures.splice(index, 1);
    }
    if (!engine._isLost && !engine._disposed) {
        engine.gl.deleteTexture(tex.handle);
    }
    const bound = engine._state._boundTextures3D;
    if (bound !== undefined) {
        for (let unit = 0; unit < bound.length; unit++) {
            if (bound[unit] === tex.handle) {
                bound[unit] = null;
            }
        }
    }
}
