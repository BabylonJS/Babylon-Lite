/**
 * Sub-entry: HTML element textures.
 *
 * Dynamic-importable via `import { ... } from "@babylonjs/lite-gl/html-texture"`
 * so consumers that don't need it (everything except NeonBrush's `InputGlow`)
 * don't pull it into their bundles.
 */
import type { GLEngineContext } from "./context.js";
import { bindTextureForUpload, setUnpackState, type GLTexture, type GLTextureOptions } from "./texture.js";

/** High-level sampling presets, mirroring Babylon's `Texture.*_SAMPLINGMODE`
 *  numeric constants. Each resolves to GL min/mag filters (and mip generation
 *  for `TRILINEAR`). */
export const GLSamplingMode = {
    /** Nearest min + mag, no mipmaps. (`Texture.NEAREST_SAMPLINGMODE`) */
    NEAREST: 1,
    /** Linear min + mag, no mipmaps. (`Texture.BILINEAR_SAMPLINGMODE`) */
    BILINEAR: 2,
    /** Linear mag + linear-mipmap-linear min, mipmaps generated.
     *  (`Texture.TRILINEAR_SAMPLINGMODE`) */
    TRILINEAR: 3,
} as const;

/** One of the {@link GLSamplingMode} preset values (`1`, `2` or `3`). */
export type GLSamplingMode = (typeof GLSamplingMode)[keyof typeof GLSamplingMode];

/** Options for `createHtmlElementTexture` — the base texture options plus
 *  HTML-source-specific settings. */
export interface GLHtmlElementTextureOptions extends GLTextureOptions {
    /** High-level sampling preset. When set, derives `minFilter`/`magFilter`
     *  (and `generateMipMaps` for `TRILINEAR`). Explicit `minFilter` /
     *  `magFilter` / `generateMipMaps` options still take precedence. Omit for
     *  the GL defaults (linear min + mag, no mipmaps). */
    samplingMode?: GLSamplingMode;
    /** Build a full mip chain after each upload. Independent of the core
     *  texture options (this factory's mip behavior is sampling-mode-driven):
     *  defaults to `true` only when `samplingMode` is `TRILINEAR`, otherwise
     *  `false`. */
    generateMipMaps?: boolean;
}

/** Create a texture backed by an `<canvas>` / `<img>` / `<video>` element.
 *  The initial upload is performed immediately; call `updateHtmlElementTexture`
 *  to re-upload after the source has changed. */
export function createHtmlElementTexture(
    engine: GLEngineContext,
    element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement,
    options?: GLHtmlElementTextureOptions
): GLTexture {
    const gl = engine.gl;
    const handle = gl.createTexture();
    if (handle === null) {
        throw new Error("lite-gl: gl.createTexture returned null");
    }
    const opts = options ?? {};
    const sm = opts.samplingMode;
    const minFilter = opts.minFilter ?? samplingMinFilter(gl, sm);
    const magFilter = opts.magFilter ?? samplingMagFilter(gl, sm);
    const wrapS = opts.wrapS ?? gl.CLAMP_TO_EDGE;
    const wrapT = opts.wrapT ?? gl.CLAMP_TO_EDGE;
    const invertY = opts.invertY ?? false;
    const generateMipMaps = opts.generateMipMaps ?? sm === GLSamplingMode.TRILINEAR;

    const sizeOf = (): [number, number] => {
        if (element instanceof HTMLVideoElement) {
            return [element.videoWidth || 1, element.videoHeight || 1];
        }
        if (element instanceof HTMLImageElement) {
            return [element.naturalWidth || 1, element.naturalHeight || 1];
        }
        return [element.width || 1, element.height || 1];
    };

    const upload = (target: GLEngineContext): void => {
        const g = target.gl;
        setUnpackState(target, invertY, false);
        bindTextureForUpload(target, tex.handle);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, element);
        const [w, h] = sizeOf();
        tex.width = w;
        tex.height = h;
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, minFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, magFilter);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, wrapS);
        g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, wrapT);
        if (generateMipMaps) {
            g.generateMipmap(g.TEXTURE_2D);
        }
    };

    const [w0, h0] = sizeOf();
    const tex: GLTexture = {
        handle,
        target: gl.TEXTURE_2D,
        width: w0,
        height: h0,
        isReady: true,
        _disposed: false,
        _refCount: 1,
        _upload: upload,
        _wasReady: true,
    };
    upload(engine);
    engine._textures.push(tex);
    return tex;
}

/** Re-upload the texture from its source element. No-op when the context is
 *  lost/disposed or the texture is disposed. */
export function updateHtmlElementTexture(engine: GLEngineContext, tex: GLTexture): void {
    if (engine._isLost || engine._disposed || tex._disposed) {
        return;
    }
    tex._upload(engine);
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** Resolve a sampling preset to a GL min filter. Defaults to `gl.LINEAR`. */
function samplingMinFilter(gl: WebGL2RenderingContext, mode: GLSamplingMode | undefined): GLenum {
    if (mode === GLSamplingMode.NEAREST) {
        return gl.NEAREST;
    }
    if (mode === GLSamplingMode.TRILINEAR) {
        return gl.LINEAR_MIPMAP_LINEAR;
    }
    return gl.LINEAR;
}

/** Resolve a sampling preset to a GL mag filter. Defaults to `gl.LINEAR`. */
function samplingMagFilter(gl: WebGL2RenderingContext, mode: GLSamplingMode | undefined): GLenum {
    return mode === GLSamplingMode.NEAREST ? gl.NEAREST : gl.LINEAR;
}
