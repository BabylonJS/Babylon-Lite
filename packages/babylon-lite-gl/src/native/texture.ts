/**
 * Native texture module — the Babylon Native twin of `texture.ts`, with the SAME
 * receiver-first public API (`bindTexture(tex, unit)`, `updateRawTexture(tex, …)`,
 * `generateTextureMipMaps(tex)`, …). Every texture carries its `_engine`, so
 * per-texture operations take the texture alone.
 *
 * Backend notes:
 * - Pixels upload through `_native.Engine#loadRawTexture` (bimg), which accepts
 *   tightly packed R8 / RGB8 / RGBA8 / RG16F / RG32F / RGBA16F / RGBA32F rows. Other
 *   WebGL layouts (RGB, RG8, LUMINANCE, unpack row padding, premultiplied alpha)
 *   are converted on the CPU at upload time (see `pixel-convert.ts`) so the
 *   texel values a shader samples match WebGL exactly.
 * - Native has no `generateMipmap`: the mip chain is built by the host during
 *   upload, so {@link generateTextureMipMaps} records the intent and replays the
 *   latest content with mips (into a fresh handle — a bgfx texture's mip count is
 *   fixed at creation).
 * - Native binds textures to SAMPLER UNIFORMS (`COMMAND_SETTEXTURE`), not units.
 *   Texture units are emulated: `_state.boundTextures[unit]` holds the bound
 *   handle and the current program's sampler for that unit (each effect maps its
 *   `samplerNames[i]` to unit `i`) receives the bind; `useEffect` replays the
 *   units when the program changes.
 */
import type { GLRawTextureOptions, GLTextureOptions, GLTextureUpdateOptions, GLFloatTextureOptions } from "../texture.js";
import { GLSamplingMode, getSamplingModeFilters } from "../texture.js";
import type { GLEngineContext } from "./native-context.js";
import type { NativeImageBitmap, NativeTexture } from "./native-types.js";
import {
    dCreateTexture,
    dDeleteTexture,
    dGetTextureHeight,
    dGetTextureWidth,
    dLoadRawTexture,
    dLoadTexture,
    dSetTexture,
    dSetTextureSampling,
    dSetTextureWrap,
    dUnsetTexture,
    nativeAddressMode,
    nativeFilter,
} from "./native-device.js";
import { premultiplyRgba8, prepareRawPixels, resolveRawLayout } from "./pixel-convert.js";

export type { GLTextureOptions, GLTextureUpdateOptions, GLRawTextureOptions, GLFloatTextureOptions, GLSamplingFilters } from "../texture.js";
export { GLSamplingMode, getSamplingModeFilters };

/** WebGL enums used for option defaults (spec constants; no GL context needed). */
const GL_TEXTURE_2D = 0x0de1;
const GL_LINEAR = 0x2601;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_HALF_FLOAT = 0x140b;

/**
 * Native texture handle — the Babylon Native counterpart of the WebGL
 * `GLTexture`, with the same public fields. `handle` is MUTABLE: device restore,
 * a resize and a mip-chain rebuild swap in a fresh native texture while every
 * consumer keeps the same `GLTexture` reference.
 */
export interface GLTexture {
    /** The live native texture handle. MUTABLE — swapped on device restore,
     *  resize and mip-chain rebuilds. */
    handle: NativeTexture;
    /** Texture target (always `TEXTURE_2D`, `0x0DE1`); 3D textures use their own API. */
    readonly target: number;
    /** Texture width in texels. Updated once an async upload resolves. */
    width: number;
    /** Texture height in texels. Updated once an async upload resolves. */
    height: number;
    /** True when the texture is safe to sample with final content. */
    isReady: boolean;
    /** The engine that created (and owns) this texture. @internal */
    _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _refCount: number;
    /** @internal Native sampling enum (`TEXTURE_<MAG>_<MIN>[_MIP*]`). */
    _filter: number;
    /** @internal Native address mode for S/U. */
    _wrapU: number;
    /** @internal Native address mode for T/V. */
    _wrapV: number;
    /** Replays the latest content into the texture (honouring `_hasMipMaps`),
     *  then re-applies sampling state and sampler bindings. @internal */
    _upload: (engine: GLEngineContext) => void;
    /** Re-creates the native handle and replays the content after device restore. @internal */
    _restore: (engine: GLEngineContext) => void;
    /** Releases the native handle (engine dispose). @internal */
    _deleteGpu: (engine: GLEngineContext) => void;
    /** Raw re-upload hook installed by `createRawTexture`. @internal */
    _updateRaw?: (engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, unpackAlignment: number) => void;
    /** Dynamic-texture source retained for replay. @internal */
    _dynSource?: unknown;
    /** `invertY` of the latest raw / dynamic / HTML-element update. @internal */
    _invertY?: boolean;
    /** `premultiplyAlpha` of the latest raw / dynamic / HTML-element update. @internal */
    _premultiplyAlpha?: boolean;
    /** Set by {@link generateTextureMipMaps}; every later upload rebuilds the chain. @internal */
    _hasMipMaps?: boolean;
}

/* ───────────────────────────  internal helpers  ─────────────────────────── */

/** Build the shared texture record. `_upload` / `_restore` are installed by the
 *  factory. @internal */
export function makeTexture(engine: GLEngineContext, handle: NativeTexture, width: number, height: number, isReady: boolean, options: GLTextureOptions | undefined): GLTexture {
    const tex: GLTexture = {
        handle,
        target: GL_TEXTURE_2D,
        width,
        height,
        isReady,
        _engine: engine,
        _disposed: false,
        _refCount: 1,
        _filter: nativeFilter(options?.minFilter ?? GL_LINEAR, options?.magFilter ?? GL_LINEAR),
        _wrapU: nativeAddressMode(options?.wrapS ?? GL_CLAMP_TO_EDGE),
        _wrapV: nativeAddressMode(options?.wrapT ?? GL_CLAMP_TO_EDGE),
        _upload: () => {},
        _restore: () => {},
        _deleteGpu: (e) => dDeleteTexture(e, tex.handle),
    };
    return tex;
}

/** Register a texture for device-restore + dispose bookkeeping. @internal */
export function registerTexture(engine: GLEngineContext, tex: GLTexture): void {
    engine._textures.push(tex);
}

/** Apply the texture's cached sampling + wrap state to its current handle. @internal */
export function applyTextureParameters(engine: GLEngineContext, tex: GLTexture): void {
    dSetTextureSampling(engine, tex.handle, tex._filter);
    dSetTextureWrap(engine, tex.handle, tex._wrapU, tex._wrapV, tex._wrapU);
}

/** Re-issue `COMMAND_SETTEXTURE` for every emulated unit holding `tex` whose
 *  sampler belongs to the current program (needed after an upload re-creates
 *  the host's bgfx texture, since bgfx keeps the old stage binding). @internal */
export function rebindTexture(engine: GLEngineContext, tex: GLTexture): void {
    const s = engine._state;
    const samplers = s.currentSamplers;
    if (samplers === null) {
        return;
    }
    const bound = s.boundTextures;
    for (let unit = 0; unit < samplers.length; unit++) {
        const loc = samplers[unit];
        if (loc !== null && loc !== undefined && bound[unit] === tex.handle) {
            dSetTexture(engine, loc, tex.handle);
        }
    }
}

/** Swap `tex` onto `handle`, deleting the previous native texture and
 *  re-pointing the emulated units that held it. The caller uploads into the new
 *  handle and then calls {@link applyTextureParameters} / {@link rebindTexture}.
 *  @internal */
export function replaceTextureHandle(engine: GLEngineContext, tex: GLTexture, handle: NativeTexture): void {
    const old = tex.handle;
    if (old === handle) {
        return;
    }
    const bound = engine._state.boundTextures;
    for (let unit = 0; unit < bound.length; unit++) {
        if (bound[unit] === old) {
            bound[unit] = handle;
        }
    }
    tex.handle = handle;
    if (!engine._isLost && !engine._disposed) {
        dDeleteTexture(engine, old);
    }
}

/** Finish any upload: sampling state + sampler re-binds. @internal */
export function finishTextureUpload(engine: GLEngineContext, tex: GLTexture): void {
    applyTextureParameters(engine, tex);
    rebindTexture(engine, tex);
}

/** Upload decoded native pixels (e.g. a `createImageBitmap` result) into `tex`,
 *  re-creating the handle when the size or mip intent changed since `alloc`.
 *  Returns the new allocation record. @internal */
export function uploadNativePixels(
    engine: GLEngineContext,
    tex: GLTexture,
    data: ArrayBufferView,
    width: number,
    height: number,
    nativeFormat: number,
    invertY: boolean,
    alloc: TextureAllocation | null
): TextureAllocation {
    const mips = tex._hasMipMaps === true;
    if (alloc !== null && (alloc.width !== width || alloc.height !== height || alloc.mips !== mips || alloc.format !== nativeFormat)) {
        replaceTextureHandle(engine, tex, dCreateTexture(engine));
    }
    dLoadRawTexture(engine, tex.handle, data, width, height, nativeFormat, mips, invertY);
    tex.width = width;
    tex.height = height;
    finishTextureUpload(engine, tex);
    return { width, height, mips, format: nativeFormat };
}

/** The storage a native texture handle was created with (bgfx textures are
 *  immutable in size, format and mip count once created). @internal */
export interface TextureAllocation {
    width: number;
    height: number;
    mips: boolean;
    format: number;
}

/** Decode an encoded image with the host's `createImageBitmap` (requires a
 *  `LOAD_IMAGES` host). Optionally premultiplies 8-bit RGBA. @internal */
export function decodeImageBitmap(engine: GLEngineContext, bytes: Uint8Array, premultiplyAlpha: boolean): NativeImageBitmap {
    const create = engine._engine.createImageBitmap;
    if (create === undefined) {
        throw new Error("lite-gl: createImageBitmap is not available on this Babylon Native host");
    }
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
    const bitmap = create.call(engine._engine, buffer);
    if (premultiplyAlpha && (bitmap.format ?? _native.Engine.TEXTURE_FORMAT_RGBA8) === _native.Engine.TEXTURE_FORMAT_RGBA8) {
        premultiplyRgba8(bitmap.data);
    }
    return bitmap;
}

/* ─────────────────────────────  factories  ───────────────────────────────── */

/**
 * Create a raw texture from a typed array (or a zero-filled allocation when
 * `data` is null). RGBA8 by default; set {@link GLRawTextureOptions.format} /
 * `type` for other layouts. Mirrors the WebGL `createRawTexture`.
 *
 * Native specifics: RGB, RG8, LUMINANCE(_ALPHA), ALPHA and float RED sources
 * are expanded to RGBA on the CPU (sampled values are unchanged); row padding
 * from `unpackAlignment` is stripped; `premultiplyAlpha` is applied on the CPU
 * for 8-bit sources. sRGB / integer formats throw. Requires a host built with
 * `LOAD_IMAGES` (raw uploads use `loadRawTexture`).
 *
 * @param engine - The engine.
 * @param data - Initial pixels matching `format` / `type`, or `null`.
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - See {@link GLRawTextureOptions}.
 * @returns The new {@link GLTexture}.
 */
export function createRawTexture(engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, options?: GLRawTextureOptions): GLTexture {
    const opts = options ?? {};
    const layout = resolveRawLayout("createRawTexture", opts.format ?? GL_RGBA, opts.type ?? GL_UNSIGNED_BYTE, opts.internalFormat);
    const invertY = opts.invertY ?? false;
    const premultiply = opts.premultiplyAlpha ?? false;
    let curData = data;
    let curWidth = width;
    let curHeight = height;
    let curAlign = opts.unpackAlignment ?? 4;
    let alloc: TextureAllocation | null = null;

    const tex = makeTexture(engine, dCreateTexture(engine), width, height, true, opts);
    const upload = (e: GLEngineContext): void => {
        const px = prepareRawPixels(layout, curData, curWidth, curHeight, curAlign, tex._premultiplyAlpha ?? premultiply);
        alloc = uploadNativePixels(e, tex, px, curWidth, curHeight, layout.nativeFormat, tex._invertY ?? invertY, alloc);
    };
    tex._upload = upload;
    tex._restore = (e) => {
        tex.handle = dCreateTexture(e);
        alloc = null;
        upload(e);
    };
    tex._updateRaw = (e, newData, newWidth, newHeight, unpackAlignment) => {
        curData = newData;
        curWidth = newWidth;
        curHeight = newHeight;
        curAlign = unpackAlignment;
        upload(e);
    };
    upload(engine);
    registerTexture(engine, tex);
    return tex;
}

/**
 * Create a float / half-float raw texture — the HDR counterpart of
 * {@link createRawTexture}. Defaults to `HALF_FLOAT` RGBA; pass
 * `options.type = FLOAT` for 32-bit. Mirrors the WebGL `createFloatTexture`.
 *
 * @param engine - The engine.
 * @param data - `Uint16Array` (HALF_FLOAT) / `Float32Array` (FLOAT) pixels, or `null`.
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - See {@link GLFloatTextureOptions}.
 * @returns The new {@link GLTexture}.
 */
export function createFloatTexture(engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, options?: GLFloatTextureOptions): GLTexture {
    const o = options ?? {};
    return createRawTexture(engine, data, width, height, { ...o, format: o.format ?? GL_RGBA, type: o.type ?? GL_HALF_FLOAT, internalFormat: undefined });
}

/**
 * Generate the mip chain for a texture and keep it current (≙ the WebGL
 * `generateTextureMipMaps`). Native has no `generateMipmap`: the intent is
 * recorded and the latest content is re-uploaded with host-generated mips (into
 * a fresh handle); every later upload, image arrival and device-restore replay
 * rebuilds the chain. For `loadTexture2D` textures the rebuild re-decodes
 * asynchronously (the previous content stays bound meanwhile). No effect on
 * render-target / external-handle textures or canvas-backed dynamic textures,
 * whose content the host owns. No-op on a lost/disposed engine or texture.
 *
 * @param tex - The texture whose mip chain to generate.
 */
export function generateTextureMipMaps(tex: GLTexture): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._hasMipMaps = true;
    tex._upload(engine);
}

/**
 * Re-upload the pixel data (and optionally resize) of a texture created by
 * {@link createRawTexture} / {@link createFloatTexture}. Mirrors the WebGL
 * `updateRawTexture`; a size change re-creates the native handle (bound
 * samplers are re-pointed). No-op on a lost/disposed/non-raw texture.
 *
 * @param tex - The raw texture to update.
 * @param data - New pixel data (same `format` / `type` as at creation).
 * @param options - Optional new `width`/`height`, `unpackAlignment` (default 4)
 *  and `invertY` / `premultiplyAlpha` (default: the creation values).
 */
export function updateRawTexture(
    tex: GLTexture,
    data: ArrayBufferView | null,
    options?: GLTextureUpdateOptions & { width?: number; height?: number; unpackAlignment?: number }
): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed || tex._updateRaw === undefined) {
        return;
    }
    const o = options ?? {};
    tex._invertY = o.invertY;
    tex._premultiplyAlpha = o.premultiplyAlpha;
    tex._updateRaw(engine, data, o.width ?? tex.width, o.height ?? tex.height, o.unpackAlignment ?? 4);
}

/**
 * Update a texture's WebGL min/mag sampling filters (mapped to the exact native
 * `TEXTURE_<MAG>_<MIN>[_MIP*]` mode). Unlike WebGL, the change IS replayed on
 * device restore. No-op on a lost/disposed engine or texture.
 *
 * @param tex - The texture to update.
 * @param minFilter - WebGL `TEXTURE_MIN_FILTER` value.
 * @param magFilter - WebGL `TEXTURE_MAG_FILTER` value.
 */
export function updateTextureSamplingMode(tex: GLTexture, minFilter: number, magFilter: number): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._filter = nativeFilter(minFilter, magFilter);
    dSetTextureSampling(engine, tex.handle, tex._filter);
}

/**
 * Update a texture's sampling from a Babylon-style {@link GLSamplingMode} preset
 * (≙ the WebGL `updateTextureSamplingPreset`): the mipmapped `TRILINEAR` min
 * filter is used when the texture has mips or `generateMipMaps` is true, and
 * `generateMipMaps` builds (and retains) the chain for `TRILINEAR` only.
 *
 * @param tex - The texture to update.
 * @param samplingMode - The {@link GLSamplingMode} preset.
 * @param generateMipMaps - Generate the mip chain now (`TRILINEAR` only). Default false.
 */
export function updateTextureSamplingPreset(tex: GLTexture, samplingMode: GLSamplingMode, generateMipMaps?: boolean): void {
    const generate = generateMipMaps === true && samplingMode === GLSamplingMode.TRILINEAR;
    const filters = getSamplingModeFilters(samplingMode, generate || tex._hasMipMaps === true);
    updateTextureSamplingMode(tex, filters.minFilter, filters.magFilter);
    if (generate && !tex._hasMipMaps) {
        generateTextureMipMaps(tex);
    }
}

/**
 * Whether a texture holds its final content and can be sampled (≙ the WebGL
 * `isTextureReady`). False while `loadTexture2D` is decoding, after disposal
 * and while the engine is lost/disposed.
 *
 * @param tex - The texture to query.
 * @returns `true` when the texture is ready to sample.
 */
export function isTextureReady(tex: GLTexture): boolean {
    const engine = tex._engine;
    return tex.isReady && !tex._disposed && !engine._isLost && !engine._disposed;
}

/**
 * Update a texture's S/T wrap modes (WebGL `CLAMP_TO_EDGE` / `REPEAT` /
 * `MIRRORED_REPEAT`). Replayed on device restore. No-op on a lost/disposed
 * engine or texture.
 *
 * @param tex - The texture to update.
 * @param wrapS - WebGL `TEXTURE_WRAP_S` value.
 * @param wrapT - WebGL `TEXTURE_WRAP_T` value.
 */
export function updateTextureWrapMode(tex: GLTexture, wrapS: number, wrapT: number): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._wrapU = nativeAddressMode(wrapS);
    tex._wrapV = nativeAddressMode(wrapT);
    dSetTextureWrap(engine, tex.handle, tex._wrapU, tex._wrapV, tex._wrapU);
}

/**
 * Wrap an existing native texture handle (e.g. created by the host or another
 * renderer) as a {@link GLTexture} (≙ the WebGL `createTextureFromHandle`, which
 * takes a `WebGLTexture`). Not replayed on device restore (the external owner
 * is responsible for that); `disposeTexture` still deletes the handle.
 *
 * @param engine - The engine.
 * @param handle - The external native texture handle.
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - Optional sampling state (min/mag/wrapS/wrapT) applied once.
 * @returns A {@link GLTexture} wrapping the handle.
 */
export function createTextureFromHandle(engine: GLEngineContext, handle: NativeTexture, width: number, height: number, options?: GLTextureOptions): GLTexture {
    const tex = makeTexture(engine, handle, width, height, true, options);
    if (options !== undefined) {
        applyTextureParameters(engine, tex);
    }
    return tex;
}

/**
 * Asynchronous image load (≙ the WebGL `loadTexture2D`). The returned texture is
 * immediately usable (1×1 transparent placeholder); `isReady` flips true once
 * the image has been fetched (`fetch`, polyfilled by Babylon Native's
 * JsRuntimeHost) and decoded host-side. The encoded bytes are retained for
 * device-restore replay and mip-chain rebuilds. `invertY` maps to the host's
 * decode-time flip; `premultiplyAlpha` decodes through `createImageBitmap` and
 * premultiplies 8-bit RGBA on the CPU. Requires a host built with `LOAD_IMAGES`.
 *
 * @param engine - The engine.
 * @param url - Image URL (resolved by the host's `fetch`).
 * @param options - See {@link GLTextureOptions}.
 * @param onLoad - Called once the image is uploaded.
 * @param onError - Called on fetch / decode failure (default: `console.error`).
 * @returns The placeholder-backed {@link GLTexture}.
 */
export function loadTexture2D(engine: GLEngineContext, url: string, options?: GLTextureOptions, onLoad?: (tex: GLTexture) => void, onError?: (err: Error) => void): GLTexture {
    const opts = options ?? {};
    const invertY = opts.invertY ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    const tex = makeTexture(engine, dCreateTexture(engine), 1, 1, false, opts);
    let encoded: Uint8Array | null = null;
    let alloc: TextureAllocation | null = null;
    let generation = 0;
    let loaded = false;

    const fail = (err: unknown): void => {
        const e = err instanceof Error ? err : new Error(String(err));
        if (onError !== undefined) {
            onError(e);
        } else {
            console.error("lite-gl: loadTexture2D failed", e);
        }
    };
    const complete = (): void => {
        tex.isReady = true;
        if (!loaded) {
            loaded = true;
            onLoad?.(tex);
        }
    };
    const upload = (e: GLEngineContext): void => {
        if (encoded === null) {
            alloc = uploadNativePixels(e, tex, new Uint8Array(4), 1, 1, _native.Engine.TEXTURE_FORMAT_RGBA8, false, alloc);
            return;
        }
        if (premultiplyAlpha) {
            // Synchronous decode so the premultiply can run on the CPU.
            const bitmap = decodeImageBitmap(e, encoded, true);
            alloc = uploadNativePixels(e, tex, bitmap.data, bitmap.width, bitmap.height, bitmap.format ?? _native.Engine.TEXTURE_FORMAT_RGBA8, invertY, alloc);
            complete();
            return;
        }
        // Host decode is async: decode into a fresh handle and swap it in on
        // success, so the previous content stays sampleable meanwhile.
        const target = dCreateTexture(e);
        const gen = ++generation;
        const mips = tex._hasMipMaps === true;
        dLoadTexture(
            e,
            target,
            encoded,
            mips,
            invertY,
            () => {
                if (tex._disposed || gen !== generation || e._isLost || e._disposed) {
                    if (!e._isLost && !e._disposed) {
                        dDeleteTexture(e, target);
                    }
                    return;
                }
                replaceTextureHandle(e, tex, target);
                tex.width = dGetTextureWidth(e, target);
                tex.height = dGetTextureHeight(e, target);
                alloc = { width: tex.width, height: tex.height, mips, format: -1 };
                finishTextureUpload(e, tex);
                complete();
            },
            () => {
                if (!e._isLost && !e._disposed) {
                    dDeleteTexture(e, target);
                }
                if (gen === generation && !tex._disposed) {
                    fail(new Error(`lite-gl: loadTexture2D could not decode ${url}`));
                }
            }
        );
    };
    tex._upload = upload;
    tex._restore = (e) => {
        tex.handle = dCreateTexture(e);
        alloc = null;
        const ready = encoded !== null;
        const bytes = encoded;
        // Placeholder first so the restored handle is immediately valid.
        encoded = null;
        upload(e);
        encoded = bytes;
        tex.isReady = false;
        if (ready) {
            try {
                upload(e);
            } catch (err) {
                fail(err);
            }
        }
    };
    upload(engine);
    registerTexture(engine, tex);

    fetch(url)
        .then((r) => {
            if (!r.ok) {
                throw new Error(`lite-gl: fetch ${url} -> HTTP ${r.status}`);
            }
            return r.arrayBuffer();
        })
        .then((buffer) => {
            if (tex._disposed) {
                return;
            }
            encoded = new Uint8Array(buffer);
            if (!engine._isLost && !engine._disposed) {
                tex._upload(engine);
            }
        })
        .catch(fail);

    return tex;
}

/* ─────────────────────────────  binding  ─────────────────────────────────── */

/**
 * Bind `tex` on emulated texture `unit` (≙ the WebGL `bindTexture`). If the
 * current program has a sampler on that unit it is bound immediately
 * (`COMMAND_SETTEXTURE`); otherwise the bind is applied when a program using
 * the unit becomes current. Cached: re-binding the same texture is elided. No-op
 * when the texture is disposed or the engine is lost/disposed.
 *
 * @param tex - The texture to bind.
 * @param unit - Texture unit (the index of the sampler in `GLEffectOptions.samplerNames`).
 */
export function bindTexture(tex: GLTexture, unit: number): void {
    const engine = tex._engine;
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    const s = engine._state;
    if (s.boundTextures[unit] === tex.handle) {
        return;
    }
    s.boundTextures[unit] = tex.handle;
    const loc = s.currentSamplers?.[unit];
    if (loc !== null && loc !== undefined) {
        dSetTexture(engine, loc, tex.handle);
    }
}

/**
 * Unbind emulated texture `unit` (≙ the WebGL `unbindTexture`); the current
 * program's sampler on that unit is cleared (`COMMAND_UNSETTEXTURE`). Cached.
 * No-op on a lost/disposed engine.
 *
 * @param engine - The engine.
 * @param unit - Texture unit to clear.
 */
export function unbindTexture(engine: GLEngineContext, unit: number): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    const s = engine._state;
    if (s.boundTextures[unit] === null || s.boundTextures[unit] === undefined) {
        return;
    }
    s.boundTextures[unit] = null;
    const loc = s.currentSamplers?.[unit];
    if (loc !== null && loc !== undefined) {
        dUnsetTexture(engine, loc);
    }
}

/**
 * Release a texture (≙ the WebGL `disposeTexture`): shared references
 * decrement; the final release deletes the native handle, unregisters it and
 * clears (and unsets on the current program) every emulated unit that still
 * references it. Repeated disposal is a no-op.
 *
 * @param tex - The texture to release.
 */
export function disposeTexture(tex: GLTexture): void {
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
    const i = engine._textures.indexOf(tex);
    if (i !== -1) {
        engine._textures.splice(i, 1);
    }
    const live = !engine._isLost && !engine._disposed;
    const s = engine._state;
    const bound = s.boundTextures;
    for (let unit = 0; unit < bound.length; unit++) {
        if (bound[unit] === tex.handle) {
            bound[unit] = null;
            const loc = s.currentSamplers?.[unit];
            if (live && loc !== null && loc !== undefined) {
                dUnsetTexture(engine, loc);
            }
        }
    }
    if (live) {
        dDeleteTexture(engine, tex.handle);
    }
}
