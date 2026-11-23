import type { GLEngineContext } from "./context.js";
import type { NativeResource, NativeResourceFields } from "./identity.js";
import type { NativeHandle } from "./runtime.js";
import type { GLRenderTarget } from "./render-target.js";

/** Opaque texture storage supplied by the Babylon Native host. */
export type NativeTextureHandle = Uint32Array<ArrayBuffer>;

/** Sampled native image with explicit storage ownership. */
export interface GLTexture extends NativeResource<"texture"> {
    readonly width: number;
    readonly height: number;
    /** Whether the image is available for sampling. */
    isReady: boolean;
    /** @internal */
    _handle: NativeHandle;
    /** @internal */
    readonly _owned: boolean;
    /** @internal Whether the storage is known to be unusable as a render-target attachment. */
    readonly _sampledOnly: boolean;
    /** @internal */
    readonly _targets: GLRenderTarget[];
    /** @internal The engine that owns this texture wrapper. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** @internal */
export function configureTexture(engine: GLEngineContext, texture: GLTexture, linear = true): void {
    const native = engine._runtime.Engine;
    const commands = engine._commands;
    commands.start(native.COMMAND_SETTEXTURESAMPLING);
    commands.handle(texture._handle);
    commands.uint(linear ? native.TEXTURE_LINEAR_LINEAR : native.TEXTURE_NEAREST_NEAREST);
    commands.finish();
    commands.start(native.COMMAND_SETTEXTUREWRAPMODE);
    commands.handle(texture._handle);
    commands.uint(native.ADDRESS_MODE_CLAMP);
    commands.uint(native.ADDRESS_MODE_CLAMP);
    commands.uint(native.ADDRESS_MODE_CLAMP);
    commands.finish();
    commands.start(native.COMMAND_SETTEXTUREANISOTROPICLEVEL);
    commands.handle(texture._handle);
    commands.uint(1);
    commands.finish();
}

/** @internal */
export function makeTexture(engine: GLEngineContext, handle: NativeHandle, owned: boolean, sampledOnly: boolean): GLTexture {
    const fields: NativeResourceFields<GLTexture> = {
        width: engine._native.getTextureWidth(handle),
        height: engine._native.getTextureHeight(handle),
        isReady: true,
        _handle: handle,
        _owned: owned,
        _sampledOnly: sampledOnly,
        _targets: [],
        _engine: engine,
        _disposed: false,
    };
    const texture = fields as GLTexture;
    configureTexture(engine, texture);
    return texture;
}

/** Borrows native texture storage without taking responsibility for deleting it. */
export function wrapNativeTexture(engine: GLEngineContext, handle: NativeTextureHandle): GLTexture {
    return makeTexture(engine, handle, false, false);
}

/** Upload options shared by native texture creators. */
export interface GLTextureOptions {
    /** Flip rows during upload. Default `false`. */
    invertY?: boolean;
}

/** Options for {@link createRawTexture}. */
export interface GLRawTextureOptions extends GLTextureOptions {
    /** Pixel format of `data`. Only `gl.RGBA` (the default) is supported. */
    format?: number;
    /** Pixel type of `data`. Only `gl.UNSIGNED_BYTE` (the default) is supported. */
    type?: number;
}

const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;

/** @internal Rejects a texture size the host cannot allocate, before any host call. */
export function validateTextureSize(engine: GLEngineContext, width: number, height: number): void {
    const max = engine.caps.maxTextureSize;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > max || height > max) {
        throw new Error(`Native Lite GL texture size must be positive integers no larger than ${max}, got ${width}x${height}.`);
    }
}

/**
 * Creates an owned, sampled-only texture from raw pixels. Only `gl.RGBA` / `gl.UNSIGNED_BYTE` data is supported.
 * The host submits the commands recorded so far before uploading, so create raw textures before `beginFrame` when the number of submissions matters.
 */
export function createRawTexture(engine: GLEngineContext, data: Uint8Array, width: number, height: number, options?: GLRawTextureOptions): GLTexture {
    if ((options?.format ?? GL_RGBA) !== GL_RGBA || (options?.type ?? GL_UNSIGNED_BYTE) !== GL_UNSIGNED_BYTE) {
        throw new Error("Native Lite GL raw textures support only RGBA / UNSIGNED_BYTE data.");
    }
    validateTextureSize(engine, width, height);
    const handle = engine._native.createTexture();
    try {
        engine._native.loadRawTexture(handle, data, width, height, engine._runtime.Engine.TEXTURE_FORMAT_RGBA8, false, options?.invertY ?? false);
        return makeTexture(engine, handle, true, true);
    } catch (error) {
        engine._native.deleteTexture(handle);
        throw error;
    }
}

/**
 * Releases owned image storage, never a borrowed host texture. The storage
 * outlives every command already recorded, so a frame may still draw with,
 * or into, a texture it disposes. After engine disposal it only marks the
 * texture disposed.
 */
export function disposeTexture(texture: GLTexture): void {
    if (!texture._disposed) {
        texture._disposed = true;
        texture.isReady = false;
        if (texture._owned && !texture._engine._disposed) {
            texture._engine._commands.deleteTexture(texture._handle);
        }
    }
}
