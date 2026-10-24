import type { GLEngineContext } from "./context.js";

/** High-level sampling presets, mirroring Babylon's `Texture.*_SAMPLINGMODE`
 *  numeric constants. Resolve one to GL min/mag filters with
 *  {@link getSamplingModeFilters} (≙ Babylon's `_getSamplingParameters`); only
 *  `TRILINEAR` samples the mip chain, and only when the texture has mipmaps. */
export const GLSamplingMode = {
    /** Nearest mag; nearest min, even with mipmaps.
     *  (`Texture.NEAREST_SAMPLINGMODE`) */
    NEAREST: 1,
    /** Linear mag; linear min, even with mipmaps.
     *  (`Texture.BILINEAR_SAMPLINGMODE`) */
    BILINEAR: 2,
    /** Linear mag; linear min (`LINEAR_MIPMAP_LINEAR` with mipmaps).
     *  (`Texture.TRILINEAR_SAMPLINGMODE`) */
    TRILINEAR: 3,
} as const;

/** One of the {@link GLSamplingMode} preset values (`1`, `2` or `3`). */
export type GLSamplingMode = (typeof GLSamplingMode)[keyof typeof GLSamplingMode];

/** Creation options shared by EVERY texture factory (`createRawTexture`,
 *  `createFloatTexture`, `loadTexture2D`, `createTextureFromSource`,
 *  `createDynamicTexture`, `createHtmlElementTexture`,
 *  `createTextureFromHandle`). All have GL-spec defaults.
 *
 *  Babylon-style sampling presets are opt-in so factories don't ship them:
 *  spread {@link getSamplingModeFilters} into the options. Mipmaps are not a
 *  creation option either: call {@link generateTextureMipMaps} once, after
 *  which every later upload and `webglcontextrestored` replay rebuilds the
 *  chain. */
export interface GLTextureOptions {
    /** Flip rows vertically on upload. Default: false (matches Babylon's
     *  default raw-texture behaviour). For raw / dynamic / HTML-element textures
     *  this is the default for every update that omits `invertY`. */
    invertY?: boolean;
    /** Default: gl.LINEAR. See {@link getSamplingModeFilters} for presets. */
    minFilter?: GLenum;
    /** Default: gl.LINEAR. */
    magFilter?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. May be `gl.REPEAT` / `gl.MIRRORED_REPEAT`
     *  (NPOT-safe in WebGL2). */
    wrapS?: GLenum;
    /** Default: gl.CLAMP_TO_EDGE. May be `gl.REPEAT` / `gl.MIRRORED_REPEAT`. */
    wrapT?: GLenum;
    /** `gl.pixelStorei(UNPACK_ALIGNMENT)` for the upload (1/2/4/8). Default 4.
     *  Use 1 for tightly-packed non-RGBA rows. */
    unpackAlignment?: number;
    /** Premultiply alpha at upload (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`, or
     *  decode-time for `loadTexture2D`). Default false. For raw / dynamic /
     *  HTML-element textures this is the default for every update that omits it. */
    premultiplyAlpha?: boolean;
    /** Explicit sized internalFormat for `texImage2D`. When provided it is used
     *  verbatim and the inline LDR resolver is bypassed — this is how
     *  {@link createFloatTexture} injects its `RGBA16F` / `RGBA32F` choice
     *  without the byte path ever referencing the float-format table (keeping it
     *  tree-shakeable out of RGBA8-only bundles). Default: derived from
     *  `format`/`type` via the LDR resolver. */
    internalFormat?: GLenum;
}

/** Per-update pixel-store flags shared by `updateRawTexture`,
 *  `updateDynamicTexture` and `updateHtmlElementTexture` (≙ lite's
 *  `DynamicTextureUpdateOptions`, Babylon's `updateRawTexture(…, invertY)`). Each
 *  omitted flag falls back to the texture's creation {@link GLTextureOptions}
 *  value; the flags of the latest update are reused on `webglcontextrestored`. */
export interface GLTextureUpdateOptions {
    /** Flip rows vertically on upload (`UNPACK_FLIP_Y_WEBGL`). */
    invertY?: boolean;
    /** Premultiply alpha on upload (`UNPACK_PREMULTIPLY_ALPHA_WEBGL`). */
    premultiplyAlpha?: boolean;
}

/**
 * Pure-state texture handle. The `handle` field is MUTABLE so the same logical
 * texture survives a `webglcontextrestored` event — every consumer keeps the
 * same `GLTexture` reference; only the internal `WebGLTexture` is swapped.
 *
 * `loadTexture2D` also uses the same handle for the 1×1 placeholder upload AND
 * the final image upload — so a `bindTexture(engine, unit, tex)` made before the
 * image has decoded remains valid once the image arrives.
 */
export interface GLTexture {
    /** The live `WebGLTexture`. MUTABLE — swapped for a fresh handle on
     *  `webglcontextrestored` while consumers keep the same `GLTexture` reference. */
    handle: WebGLTexture;
    /** GL texture target (normally `gl.TEXTURE_2D`); 3D textures use their own API. */
    readonly target: GLenum;
    /** Texture width in texels. Updated once an async upload resolves. */
    width: number;
    /** Texture height in texels. Updated once an async upload resolves. */
    height: number;
    /** True when the texture is safe to sample with final content (placeholders
     *  read as not-ready until their image/upload completes). */
    isReady: boolean;
    /** @internal */
    _disposed: boolean;
    /** @internal */
    _refCount: number;
    /** Replays the latest pixel content into the currently bound texture handle. @internal */
    _upload: (engine: GLEngineContext) => void;
    /** Initializes creation-time sampling state on the bound texture handle. @internal */
    _initializeParameters?: (engine: GLEngineContext) => void;
    /**
     * Snapshot of `isReady` captured on `webglcontextlost` so the restore
     * handler knows whether to flip it back on after `_upload`. Textures
     * that were still mid-load (e.g. `loadTexture2D` whose bitmap hadn't
     * arrived) stay not-ready; the async path will set `isReady=true` once
     * the bitmap finishes decoding into the new handle.
     * @internal
     */
    _wasReady: boolean;
    /**
     * Live re-upload hook installed by `createRawTexture` — lets
     * `updateRawTexture` replace the pixel data (and optionally the size)
     * through the same closure that the context-restore replay uses, keeping
     * restore correct. Absent on image / HTML-element / external textures.
     * @internal
     */
    _updateRaw?: (engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, unpackAlignment: number) => void;
    /**
     * Dynamic-texture source captured by `updateDynamicTexture`
     * (`@babylonjs/lite-gl`) and replayed into the fresh handle
     * on `webglcontextrestored`. Null/absent on non-dynamic textures.
     * @internal
     */
    _dynSource?: TexImageSource | null;
    /** `invertY` of the latest raw / dynamic / HTML-element update
     *  ({@link GLTextureUpdateOptions}), reused by context-restore replay;
     *  `undefined` → the texture's creation `invertY`. @internal */
    _invertY?: boolean;
    /** `premultiplyAlpha` of the latest raw / dynamic / HTML-element update
     *  ({@link GLTextureUpdateOptions}), reused by context-restore replay;
     *  `undefined` → the texture's creation `premultiplyAlpha`. @internal */
    _premultiplyAlpha?: boolean;
    /**
     * The `handle` the dynamic texture's `texParameteri` filter/wrap state was
     * last applied to. `texParameteri` is per-texture GL state that survives pixel
     * re-uploads, so the dynamic-texture `_upload` re-applies it ONLY when this no
     * longer matches `handle` — i.e. at creation and after `webglcontextrestored`
     * installs a fresh handle — not on every per-frame `updateDynamicTexture`.
     * @internal
     */
    _dynParamsHandle?: WebGLTexture | null;
    /**
     * Set by {@link generateTextureMipMaps} (≙ Babylon
     * `InternalTexture.useMipMaps`, and the 3D API's `_hasMipMaps`). The mip
     * intent is retained: `_upload` is wrapped once so every later level-0
     * upload, including `webglcontextrestored` replay, rebuilds the chain.
     * @internal
     */
    _hasMipMaps?: boolean;
}

/**
 * Apply the three `UNPACK_*` pixel-store flags through the GL-state cache,
 * eliding redundant `pixelStorei` calls. Centralising this guarantees EVERY
 * upload path sets all three explicitly, so a premultiplying / flipping upload
 * never leaks its flag into a later upload that forgot to set it.
 * @internal
 */
export function setUnpackState(engine: GLEngineContext, flipY: boolean, premultiplyAlpha: boolean, alignment = 4): void {
    const gl = engine.gl;
    const s = engine._state;
    const fy = flipY ? 1 : 0;
    if (s.unpackFlipY !== fy) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, fy);
        s.unpackFlipY = fy;
    }
    const pm = premultiplyAlpha ? 1 : 0;
    if (s.unpackPremultiplyAlpha !== pm) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pm);
        s.unpackPremultiplyAlpha = pm;
    }
    if (s.unpackAlignment !== alignment) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
        s.unpackAlignment = alignment;
    }
}

/** Apply sampling and wrap state to the texture currently bound for upload. @internal */
export function setBoundTextureParams(gl: WebGL2RenderingContext, minFilter: GLenum, magFilter: GLenum, wrapS: GLenum, wrapT: GLenum): void {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
}

/** GL min/mag filters resolved from a {@link GLSamplingMode} preset. Spread
 *  into any {@link GLTextureOptions}, or pass to {@link updateTextureSamplingMode}. */
export interface GLSamplingFilters {
    /** `TEXTURE_MIN_FILTER` value. */
    minFilter: GLenum;
    /** `TEXTURE_MAG_FILTER` value. */
    magFilter: GLenum;
}

/**
 * Resolve a Babylon-style sampling preset to GL min/mag filters — the lite-gl
 * counterpart of Babylon's `_getSamplingParameters(samplingMode, generateMipMaps)`.
 * Pure (no GL context needed; WebGL filter enums are spec constants) and
 * tree-shaken unless imported, so preset-free bundles ship none of it.
 *
 * | Preset      | min (no mips) | min (mips)             | mag       |
 * | ----------- | ------------- | ---------------------- | --------- |
 * | `NEAREST`   | `NEAREST`     | `NEAREST`              | `NEAREST` |
 * | `BILINEAR`  | `LINEAR`      | `LINEAR`               | `LINEAR`  |
 * | `TRILINEAR` | `LINEAR`      | `LINEAR_MIPMAP_LINEAR` | `LINEAR`  |
 *
 * Babylon's mipmapped nearest / bilinear variants are separate modes
 * (`NEAREST_LINEAR_MIPNEAREST` …); pass their raw filters instead.
 *
 * @example
 * ```ts
 * const tex = createRawTexture(engine, data, w, h, gl.RGBA, gl.UNSIGNED_BYTE, { ...getSamplingModeFilters(GLSamplingMode.TRILINEAR, true) });
 * generateTextureMipMaps(engine, tex); // required by the mipmapped min filter
 * ```
 *
 * @param samplingMode - The {@link GLSamplingMode} preset.
 * @param useMipMaps - Whether the texture has (or will get, via
 *  {@link generateTextureMipMaps}) a mip chain. Default false, so the min
 *  filter never references a missing chain.
 * @returns The preset's `{ minFilter, magFilter }`.
 */
export function getSamplingModeFilters(samplingMode: GLSamplingMode, useMipMaps = false): GLSamplingFilters {
    // WebGL filter enums: NEAREST 0x2600, LINEAR 0x2601, LINEAR_MIPMAP_LINEAR 0x2703.
    const magFilter = samplingMode === GLSamplingMode.NEAREST ? 0x2600 : 0x2601;
    return { minFilter: useMipMaps && samplingMode === GLSamplingMode.TRILINEAR ? 0x2703 : magFilter, magFilter };
}

/** Size-bearing fields across the `TexImageSource` variants. @internal */
interface TexImageSourceSize {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
}

/** Write the pixel size of a `TexImageSource` as `texImage2D` will upload it
 *  into `tex.width` / `tex.height`: the intrinsic size for video
 *  (`videoWidth`), image (`naturalWidth`) and `VideoFrame` (`displayWidth`)
 *  sources, `width`/`height` otherwise. Clamped to ≥ 1. Allocation-free — it
 *  runs on every dynamic / HTML-element re-upload. @internal */
export function setTexImageSourceSize(tex: GLTexture, source: TexImageSourceSize): void {
    tex.width = (source.videoWidth ?? source.naturalWidth ?? source.displayWidth ?? source.width) || 1;
    tex.height = (source.videoHeight ?? source.naturalHeight ?? source.displayHeight ?? source.height) || 1;
}

/** Uint8 / float raw texture upload. The pixel data can be replaced later via
 *  {@link updateRawTexture}; the sampling and wrap can be changed via
 *  {@link updateTextureSamplingMode} / {@link updateTextureWrapMode}. */
export function createRawTexture(
    engine: GLEngineContext,
    data: ArrayBufferView | null,
    width: number,
    height: number,
    format: GLenum,
    type: GLenum,
    options?: GLTextureOptions
): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const opts = options ?? {};
    const minFilter = opts.minFilter ?? gl.LINEAR;
    const magFilter = opts.magFilter ?? gl.LINEAR;
    const wrapS = opts.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = opts.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = opts.invertY ?? false;
    const premultiply = opts.premultiplyAlpha ?? false;
    // LDR byte formats are resolved INLINE here; the float-format table in
    // `pickSizedInternalFormat` is deliberately NOT referenced from this path so
    // it tree-shakes out of byte-only bundles. `createFloatTexture` injects its
    // sized float format via `opts.internalFormat`.
    const internalFormat = opts.internalFormat ?? resolveLdrInternalFormat(gl, format, type);

    // Mutable upload state — `updateRawTexture` mutates these and re-runs
    // `upload`, so the context-restore replay (which calls the same `upload`)
    // always reproduces the latest contents.
    let curData = data;
    let curWidth = width;
    let curHeight = height;
    let curAlign = opts.unpackAlignment ?? 4;

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, tex._invertY ?? invertY, tex._premultiplyAlpha ?? premultiply, curAlign);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, internalFormat, curWidth, curHeight, 0, format, type, curData);
    };

    const initializeParameters = (target: GLEngineContext): void => {
        setBoundTextureParams(target.gl, minFilter, magFilter, wrapS, wrapT);
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width,
        height,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _initializeParameters: initializeParameters,
        _wasReady: true,
    };
    tex._updateRaw = (target: GLEngineContext, newData: ArrayBufferView | null, newWidth: number, newHeight: number, unpackAlignment: number): void => {
        curData = newData;
        curWidth = newWidth;
        curHeight = newHeight;
        curAlign = unpackAlignment;
        tex.width = newWidth;
        tex.height = newHeight;
        upload(target);
    };
    upload(engine);
    initializeParameters(engine);
    engine._textures.add(tex);
    return tex;
}

/** Options for {@link createFloatTexture} — the shared {@link GLTextureOptions}
 *  plus the float-specific `type` / `format`. */
export interface GLFloatTextureOptions extends GLTextureOptions {
    /** Float texel type — `gl.HALF_FLOAT` (default) or `gl.FLOAT`. */
    type?: GLenum;
    /** Color format. Default `gl.RGBA`. */
    format?: GLenum;
}

/**
 * Create a float / half-float raw texture — the HDR counterpart of
 * {@link createRawTexture}. This is the ONLY texture factory that carries the
 * `RGBA16F` / `RGBA32F` sized-format knowledge (via {@link pickSizedInternalFormat}),
 * so byte-only consumers calling {@link createRawTexture} ship none of it.
 * Defaults to `gl.HALF_FLOAT`; pass `options.type = gl.FLOAT` for full 32-bit.
 * The caller is responsible for the matching engine cap (e.g.
 * `caps.textureFloatLinearFiltering`) when sampling these with `LINEAR`.
 *
 * @param engine - The engine.
 * @param data - Initial pixels (`Float32Array` for FLOAT, `Uint16Array` for
 *  HALF_FLOAT), or `null` for an uninitialised allocation.
 * @param width - Texture width in texels (≥ 1).
 * @param height - Texture height in texels (≥ 1).
 * @param options - See {@link GLFloatTextureOptions}.
 * @returns The new {@link GLTexture}.
 */
export function createFloatTexture(engine: GLEngineContext, data: ArrayBufferView | null, width: number, height: number, options?: GLFloatTextureOptions): GLTexture {
    const gl = engine.gl;
    const o = options ?? {};
    const format = o.format ?? gl.RGBA;
    const type = o.type ?? gl.HALF_FLOAT;
    // Precompute the sized float internalFormat HERE and pass it through, so
    // `createRawTexture`'s inline LDR resolver is bypassed and the float table
    // stays out of byte-only bundles.
    const internalFormat = pickSizedInternalFormat(gl, format, type);
    return createRawTexture(engine, data, width, height, format, type, { ...o, internalFormat });
}

/**
 * Generate the mip chain for a texture from its level-0 contents and keep it
 * current (≙ Babylon's `useMipMaps` / lite-gl's `generateTexture3DMipMaps`).
 * The intent is retained: every later level-0 upload — `updateRawTexture`,
 * `updateDynamicTexture`, `updateHtmlElementTexture`, the `loadTexture2D` image
 * arrival and `webglcontextrestored` replay — rebuilds the chain, so a
 * mipmapped min filter never samples an incomplete texture. Only bundles that
 * call it pay for mipmapping. Calling it again just regenerates now.
 *
 * Binds for upload (unit 0). The format must be filterable (float textures need
 * the matching linear-filtering cap). Render targets use
 * `generateRenderTargetMipMaps` instead. No-op on a lost/disposed context or a
 * disposed texture.
 */
export function generateTextureMipMaps(engine: GLEngineContext, tex: GLTexture): void {
    if (engine._isLost || engine._disposed || tex._disposed || tex.handle === null) {
        return;
    }
    bindTextureForUpload(engine, tex.handle);
    engine.gl.generateMipmap(engine.gl.TEXTURE_2D);
    if (!tex._hasMipMaps) {
        tex._hasMipMaps = true;
        // Every `_upload` that runs (update / restore-registry replay) leaves
        // this texture bound for upload; handle/RT textures are never replayed.
        const upload = tex._upload;
        tex._upload = (target: GLEngineContext): void => {
            upload(target);
            target.gl.generateMipmap(target.gl.TEXTURE_2D);
        };
    }
}

/**
 * Re-upload the pixel data (and optionally resize) of a texture created by
 * {@link createRawTexture} — the lite-gl equivalent of Babylon's
 * `updateRawTexture` / `_uploadDataToTextureDirectly`. Goes through the same
 * upload closure used by context-restore, so the new contents survive a context
 * loss, and rebuilds the mip chain after {@link generateTextureMipMaps}. No-op
 * on a lost/disposed/non-raw texture.
 *
 * @param engine - The engine.
 * @param tex - The raw texture to update.
 * @param data - New pixel data (must match the original `format`/`type`).
 * @param options - Optional new `width`/`height` (default: unchanged),
 *  `unpackAlignment` (default 4) and `invertY` / `premultiplyAlpha` (default:
 *  the creation values; ≙ Babylon's `updateRawTexture(…, invertY)`). The flags
 *  are reused by context-restore replay.
 */
export function updateRawTexture(
    engine: GLEngineContext,
    tex: GLTexture,
    data: ArrayBufferView | null,
    options?: GLTextureUpdateOptions & { width?: number; height?: number; unpackAlignment?: number }
): void {
    if (engine._isLost || engine._disposed || tex._disposed || tex._updateRaw === undefined) {
        return;
    }
    const o = options ?? {};
    tex._invertY = o.invertY;
    tex._premultiplyAlpha = o.premultiplyAlpha;
    tex._updateRaw(engine, data, o.width ?? tex.width, o.height ?? tex.height, o.unpackAlignment ?? 4);
    if (tex._hasMipMaps) {
        // `_updateRaw` leaves the texture bound for upload (unit 0).
        engine.gl.generateMipmap(engine.gl.TEXTURE_2D);
    }
}

/**
 * Update a texture's sampling mode from a Babylon-style preset — the lite-gl
 * equivalent of Babylon's
 * `updateTextureSamplingMode(samplingMode, texture, generateMipMaps)`. The
 * filters come from {@link getSamplingModeFilters}, using the mipmapped
 * `TRILINEAR` min filter when the texture already has mipmaps (from
 * {@link generateTextureMipMaps}) or `generateMipMaps` is true. Like Babylon,
 * `generateMipMaps` only generates (and retains) the chain for `TRILINEAR`,
 * right after the filters are set; `NEAREST` / `BILINEAR` never sample mips.
 * Unlike Babylon, an existing chain is not regenerated (lite-gl already
 * rebuilds it on every upload); call {@link generateTextureMipMaps} to force it.
 *
 * Binds for upload (unit 0) so the `texParameteri` lands on this texture. The
 * change is not replayed on `webglcontextrestored` (creation options are).
 * No-op on a lost/disposed context or a disposed texture.
 *
 * @param engine - The engine.
 * @param tex - The texture to update.
 * @param samplingMode - The {@link GLSamplingMode} preset.
 * @param generateMipMaps - Generate the mip chain now (`TRILINEAR` only). Default false.
 */
export function updateTextureSamplingMode(engine: GLEngineContext, tex: GLTexture, samplingMode: GLSamplingMode, generateMipMaps?: boolean): void;
/**
 * Update a texture's raw GL min/mag sampling filters (e.g. `gl.NEAREST`,
 * `gl.LINEAR_MIPMAP_LINEAR`). A mipmapped min filter needs
 * {@link generateTextureMipMaps}. Binds for upload (unit 0); not replayed on
 * `webglcontextrestored`. No-op on a lost/disposed context or a disposed
 * texture.
 *
 * @param engine - The engine.
 * @param tex - The texture to update.
 * @param minFilter - `TEXTURE_MIN_FILTER` value.
 * @param magFilter - `TEXTURE_MAG_FILTER` value.
 */
export function updateTextureSamplingMode(engine: GLEngineContext, tex: GLTexture, minFilter: GLenum, magFilter: GLenum): void;
export function updateTextureSamplingMode(engine: GLEngineContext, tex: GLTexture, modeOrMinFilter: number, magFilterOrGenerateMipMaps?: number | boolean): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    let minFilter = modeOrMinFilter;
    let magFilter: GLenum;
    let generateMipMaps = false;
    // The raw overload passes a GL enum as 4th argument; the preset one a boolean or nothing.
    if (typeof magFilterOrGenerateMipMaps === "number") {
        magFilter = magFilterOrGenerateMipMaps;
    } else {
        // ≙ Babylon: mips are generated only for a mipmapped preset (`TRILINEAR`).
        generateMipMaps = magFilterOrGenerateMipMaps === true && modeOrMinFilter === GLSamplingMode.TRILINEAR;
        const filters = getSamplingModeFilters(modeOrMinFilter as GLSamplingMode, generateMipMaps || tex._hasMipMaps === true);
        minFilter = filters.minFilter;
        magFilter = filters.magFilter;
    }
    const gl = engine.gl;
    bindTextureForUpload(engine, tex.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
    // An existing chain is already rebuilt on every upload; call
    // `generateTextureMipMaps` directly to force a regeneration.
    if (generateMipMaps && !tex._hasMipMaps) {
        generateTextureMipMaps(engine, tex);
    }
}

/**
 * Whether a texture holds its final content and can be sampled — the function
 * form of {@link GLTexture.isReady}, mirroring `isEffectReady(engine, effect)`
 * (≙ Babylon's `texture.isReady()`). False while `loadTexture2D` is still
 * decoding (the 1×1 placeholder is bound meanwhile), after disposal, and while
 * the context is lost/disposed.
 *
 * @param engine - The engine that owns the texture.
 * @param tex - The texture to query.
 * @returns `true` when the texture is ready to sample.
 */
export function isTextureReady(engine: GLEngineContext, tex: GLTexture): boolean {
    return tex.isReady && !tex._disposed && !engine._isLost && !engine._disposed;
}

/** Update a texture's S/T wrap modes (`gl.CLAMP_TO_EDGE` / `gl.REPEAT` /
 *  `gl.MIRRORED_REPEAT`) — the lite-gl equivalent of Babylon's
 *  `updateTextureWrappingMode`. No-op on a lost/disposed context. */
export function updateTextureWrapMode(engine: GLEngineContext, tex: GLTexture, wrapS: GLenum, wrapT: GLenum): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    const gl = engine.gl;
    bindTextureForUpload(engine, tex.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
}

/**
 * Wrap an existing raw `WebGLTexture` (e.g. one created by a host renderer or a
 * previous engine) as a {@link GLTexture} — the lite-gl equivalent of
 * ShapeBuilder's `createTextureGraphicsResourceFromExternalWebGLTexture`.
 *
 * The wrapper does NOT own the underlying handle's upload — it is NOT registered
 * for context-restore replay (the external owner is responsible for that) and is
 * marked ready immediately. `disposeTexture` will still `gl.deleteTexture` it, so
 * only wrap a handle whose deletion you intend lite-gl to manage.
 *
 * @param engine - The engine.
 * @param handle - The external `WebGLTexture`.
 * @param width - Texture width in texels.
 * @param height - Texture height in texels.
 * @param options - Optional sampling state to apply once (min/mag/wrapS/wrapT).
 *  Upload-only options (`invertY`, `premultiplyAlpha`, `unpackAlignment`,
 *  `internalFormat`) do not apply — the handle's pixels are owned externally.
 * @returns A {@link GLTexture} wrapping the handle.
 */
export function createTextureFromHandle(engine: GLEngineContext, handle: WebGLTexture, width: number, height: number, options?: GLTextureOptions): GLTexture {
    const tex: GLTexture = {
        handle,
        target: engine.gl.TEXTURE_2D,
        width,
        height,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        // External handle — restore replay is the external owner's job.
        _upload: () => {},
        _wasReady: true,
    };
    if (options !== undefined) {
        const gl = engine.gl;
        bindTextureForUpload(engine, handle);
        setBoundTextureParams(gl, options.minFilter ?? gl.LINEAR, options.magFilter ?? gl.LINEAR, options.wrapS ?? gl.CLAMP_TO_EDGE, options.wrapT ?? gl.CLAMP_TO_EDGE);
    }
    return tex;
}

/** Asynchronous image upload.The returned texture is immediately usable (1×1
 *  transparent placeholder); `isReady` flips true once the image has been
 *  decoded and uploaded. The decoded `ImageBitmap` is retained on the texture
 *  for offline-safe `webglcontextrestored` replay. `invertY` and
 *  `premultiplyAlpha` are applied at decode time (`createImageBitmap`'s
 *  `imageOrientation` / `premultiplyAlpha`) because the `UNPACK_*` flags are
 *  ignored for `ImageBitmap` sources. */
export function loadTexture2D(engine: GLEngineContext, url: string, options?: GLTextureOptions, onLoad?: (tex: GLTexture) => void, onError?: (err: Error) => void): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const opts = options ?? {};
    const minFilter = opts.minFilter ?? gl.LINEAR;
    const magFilter = opts.magFilter ?? gl.LINEAR;
    const wrapS = opts.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = opts.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = opts.invertY ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;

    let bitmap: ImageBitmap | null = null;
    const placeholderPixels = new Uint8Array([0, 0, 0, 0]);

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        // invertY / premultiplyAlpha are applied at decode time via createImageBitmap
        // because UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL are IGNORED for
        // ImageBitmap sources (and the transparent 1×1 placeholder is invariant to
        // both), so keep flip + premultiply off here.
        setUnpackState(target, false, false);
        bindTextureForUpload(target, tex.handle);
        if (bitmap !== null) {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, bitmap);
            tex.width = bitmap.width;
            tex.height = bitmap.height;
        } else {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 1, 1, 0, g.RGBA, g.UNSIGNED_BYTE, placeholderPixels);
        }
    };

    const initializeParameters = (target: GLEngineContext): void => {
        setBoundTextureParams(target.gl, minFilter, magFilter, wrapS, wrapT);
    };

    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width: 1,
        height: 1,
        isReady: false,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _initializeParameters: initializeParameters,
        _wasReady: false,
    };
    // Placeholder upload — makes the texture sampleable before the real image arrives.
    upload(engine);
    initializeParameters(engine);
    engine._textures.add(tex);

    // Fetch + decode the real image. Re-uploads via the same closure once the
    // bitmap is in hand (so context-restore replay sees the real image too).
    fetch(url)
        .then((r) => {
            if (!r.ok) {
                throw new Error(`lite-gl: fetch ${url} -> HTTP ${r.status}`);
            }
            return r.blob();
        })
        .then((blob) => createImageBitmap(blob, { premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none", imageOrientation: invertY ? "flipY" : "none" }))
        .then((bm) => {
            if (tex._disposed) {
                bm.close();
                return;
            }
            bitmap = bm;
            // If the context is lost mid-flight, defer the upload — the restore
            // handler will call _upload again, which will then see `bitmap !== null`
            // and replay the real image.
            if (!engine._isLost) {
                // Through `tex._upload` so a retained mip chain is rebuilt.
                tex._upload(engine);
                tex.isReady = true;
            }
            tex._wasReady = true;
            if (onLoad !== undefined) {
                onLoad(tex);
            }
        })
        .catch((err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            if (onError !== undefined) {
                onError(e);
            } else {
                console.error("lite-gl: loadTexture2D failed", e);
            }
        });

    return tex;
}

/** Cached bind. Skips `gl.activeTexture` and/or `gl.bindTexture` when nothing
 *  changes. No-op when `tex._disposed` or `engine._isLost`. */
export function bindTexture(engine: GLEngineContext, unit: number, tex: GLTexture | null): void {
    if (engine._isLost || engine._disposed) {
        return;
    }
    if (tex !== null && tex._disposed) {
        return;
    }
    bindTextureRaw(engine, unit, tex === null ? null : tex.handle);
}

/** @internal — for callers that already hold a raw `WebGLTexture`. Not part of
 *  the public API: `bindTexture` (public) and the texture `_upload` closures bind
 *  through the cache, so consumers never call this directly. */
export function bindTextureRaw(engine: GLEngineContext, unit: number, handle: WebGLTexture | null): void {
    const s = engine._state;
    const gl = engine.gl;
    if (s.boundTextures[unit] === handle) {
        return;
    }
    if (s.activeTextureUnit !== unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        s.activeTextureUnit = unit;
    }
    gl.bindTexture(gl.TEXTURE_2D, handle);
    s.boundTextures[unit] = handle;
}

/** @internal Bind `handle` on texture unit 0 **for an upload** (`texImage2D`).
 *  Unlike {@link bindTextureRaw} — which elides the entire bind when the handle is
 *  already bound on the unit (correct for *sampling*, where the active unit is
 *  irrelevant) — an upload writes into the texture on the ACTIVE unit. A prior
 *  multi-sampler draw may have left a non-zero unit active while this handle is
 *  still bound on unit 0, so we must force unit 0 active even on a bind cache-hit,
 *  keeping the `_state` cache coherent. */
export function bindTextureForUpload(engine: GLEngineContext, handle: WebGLTexture): void {
    const s = engine._state;
    const gl = engine.gl;
    if (s.activeTextureUnit !== 0) {
        gl.activeTexture(gl.TEXTURE0);
        s.activeTextureUnit = 0;
    }
    if (s.boundTextures[0] !== handle) {
        gl.bindTexture(gl.TEXTURE_2D, handle);
        s.boundTextures[0] = handle;
    }
}

/** Disposes the texture. Walks `_state.boundTextures` and clears every slot
 *  that still references the handle — otherwise a later `bindTexture(unit, B)`
 *  to the same unit would be wrongly elided when slot still showed handle A.
 *  Deregistration is expected O(1), independent of the live texture count.
 *  Shared references keep the texture registered until its final release;
 *  repeated disposal is a no-op. Unregistered wrappers keep their existing
 *  handle-deletion semantics without affecting the live registry. */
export function disposeTexture(engine: GLEngineContext, tex: GLTexture): void {
    if (tex._disposed) {
        return;
    }
    if (tex._refCount > 1) {
        tex._refCount--;
        return;
    }
    tex._disposed = true;
    engine._textures.delete(tex);
    if (!engine._isLost && !engine._disposed) {
        engine.gl.deleteTexture(tex.handle);
    }
    const bound = engine._state.boundTextures;
    for (let u = 0; u < bound.length; u++) {
        if (bound[u] === tex.handle) {
            bound[u] = null;
        }
    }
}

/** Internal — resolve the sized internalFormat for the LDR (byte) `texImage2D`
 *  paths ONLY: RGBA→RGBA8, RGB→RGB8, RG→RG8, RED→R8, LUMINANCE passthrough.
 *  Deliberately knows nothing about FLOAT / HALF_FLOAT so the float-format table
 *  in {@link pickSizedInternalFormat} tree-shakes out of byte-only bundles.
 *  @internal */
function resolveLdrInternalFormat(gl: WebGL2RenderingContext, format: GLenum, type: GLenum): GLenum {
    if (type === gl.UNSIGNED_BYTE) {
        if (format === gl.RGBA) {
            return gl.RGBA8;
        }
        if (format === gl.RGB) {
            return gl.RGB8;
        }
        if (format === gl.RG) {
            return gl.RG8;
        }
        if (format === gl.RED) {
            return gl.R8;
        }
        if (format === gl.LUMINANCE) {
            return gl.LUMINANCE;
        }
    }
    return format;
}

/** Internal — pick a sized internalFormat for `texImage2D`. WebGL2 prefers
 *  sized formats for non-color-renderable / non-readback paths; for the
 *  NeonBrush use cases (sample-only) the unsized format works too, but sized
 *  is more portable. Shared with the render-target module.
 *  @internal */
export function pickSizedInternalFormat(gl: WebGL2RenderingContext, format: GLenum, type: GLenum): GLenum {
    if (type === gl.UNSIGNED_BYTE) {
        if (format === gl.RGBA) {
            return gl.RGBA8;
        }
        if (format === gl.RGB) {
            return gl.RGB8;
        }
        if (format === gl.LUMINANCE) {
            return gl.LUMINANCE;
        }
    }
    if (type === gl.FLOAT) {
        if (format === gl.RGBA) {
            return gl.RGBA32F;
        }
        if (format === gl.RGB) {
            return gl.RGB32F;
        }
    }
    if (type === gl.HALF_FLOAT) {
        if (format === gl.RGBA) {
            return gl.RGBA16F;
        }
        if (format === gl.RGB) {
            return gl.RGB16F;
        }
    }
    return format;
}
