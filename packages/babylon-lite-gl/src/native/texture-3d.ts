/**
 * 3D (volume) textures — DECLARED DIVERGENCE on Babylon Native.
 *
 * Babylon Native's `NativeEngine` exposes no 3D texture creation / upload
 * (`bgfx::createTexture3D` is never reached from JS), so this module keeps the
 * WebGL `src/texture-3d.ts` names and signatures but cannot create volumes:
 * `engine.caps.texture3D` is `false`, every call that would need a volume
 * throws `lite-gl: <fn> is not supported on Babylon Native`, and the trivially
 * safe calls (`unbindTexture3D`, `disposeTexture3D`, clearing a sampler with
 * `setEffectTexture3D(effect, name, null)`) are no-ops.
 */
import type { GLEngineContext } from "./native-context.js";
import type { GLEffect } from "./effect.js";
import type { GLTexture } from "./texture.js";
import type { GLPixelsTexture3DOptions } from "../texture-3d.js";

export type { GLPixelsTexture3DOptions } from "../texture-3d.js";

/**
 * A 3D texture record (shape-compatible with the WebGL `GLTexture3D`). Never
 * produced on Babylon Native — {@link createTexture3DFromPixels} throws.
 */
export interface GLTexture3D extends Omit<GLTexture, "target"> {
    /** This target distinguishes 3D volumes from textures accepted by the 2D APIs (`TEXTURE_3D`, `0x806F`). */
    readonly target: 0x806f;
    /** Number of slices in the volume. */
    depth: number;
}

function unsupported(fn: string): never {
    throw new Error(`lite-gl: ${fn} is not supported on Babylon Native (no 3D textures; check engine.caps.texture3D)`);
}

/**
 * Bind a 3D texture to a unit (≙ WebGL `bindTexture3D`).
 * NATIVE: always throws — 3D textures are not supported (`caps.texture3D` is false).
 * @param tex - The 3D texture.
 * @param unit - The texture unit.
 */
export function bindTexture3D(tex: GLTexture3D, unit: number): void {
    void tex;
    void unit;
    unsupported("bindTexture3D");
}

/**
 * Unbind the 3D texture on a unit (≙ WebGL `unbindTexture3D`).
 * NATIVE: no-op — nothing can be bound.
 * @param engine - The engine.
 * @param unit - The texture unit.
 */
export function unbindTexture3D(engine: GLEngineContext, unit: number): void {
    void engine;
    void unit;
}

/**
 * Assign a 3D texture to an effect's sampler (≙ WebGL `setEffectTexture3D`).
 * NATIVE: `null` is a no-op; any texture throws (3D textures are unsupported).
 * @param effect - The effect.
 * @param samplerName - The sampler uniform name.
 * @param tex - The 3D texture, or `null` to clear.
 */
export function setEffectTexture3D(effect: GLEffect, samplerName: string, tex: GLTexture3D | null): void {
    void effect;
    void samplerName;
    if (tex !== null) {
        unsupported("setEffectTexture3D");
    }
}

/**
 * Create a 3D texture from tightly packed pixels (≙ WebGL `createTexture3DFromPixels`).
 * NATIVE: always throws — 3D textures are not supported (`caps.texture3D` is false).
 * @param engine - The engine.
 * @param data - The voxel bytes.
 * @param width - Width in texels.
 * @param height - Height in texels.
 * @param depth - Depth in slices.
 * @param options - Format and sampling options.
 * @returns Never returns.
 */
export function createTexture3DFromPixels(
    engine: GLEngineContext,
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    options: GLPixelsTexture3DOptions = {}
): GLTexture3D {
    void engine;
    void data;
    void width;
    void height;
    void depth;
    void options;
    unsupported("createTexture3DFromPixels");
}

/**
 * Generate a 3D texture's mip chain (≙ WebGL `generateTexture3DMipMaps`).
 * NATIVE: always throws — 3D textures are not supported.
 * @param tex - The 3D texture.
 */
export function generateTexture3DMipMaps(tex: GLTexture3D): void {
    void tex;
    unsupported("generateTexture3DMipMaps");
}

/**
 * Change a 3D texture's filtering (≙ WebGL `updateTexture3DSamplingMode`).
 * NATIVE: always throws — 3D textures are not supported.
 * @param tex - The 3D texture.
 * @param minFilter - GL minification filter.
 * @param magFilter - GL magnification filter.
 */
export function updateTexture3DSamplingMode(tex: GLTexture3D, minFilter: GLenum, magFilter: GLenum): void {
    void tex;
    void minFilter;
    void magFilter;
    unsupported("updateTexture3DSamplingMode");
}

/**
 * Change a 3D texture's wrap modes (≙ WebGL `updateTexture3DWrapMode`).
 * NATIVE: always throws — 3D textures are not supported.
 * @param tex - The 3D texture.
 * @param wrapS - GL wrap mode for S.
 * @param wrapT - GL wrap mode for T.
 * @param wrapR - GL wrap mode for R.
 */
export function updateTexture3DWrapMode(tex: GLTexture3D, wrapS: GLenum, wrapT: GLenum, wrapR: GLenum): void {
    void tex;
    void wrapS;
    void wrapT;
    void wrapR;
    unsupported("updateTexture3DWrapMode");
}

/**
 * Dispose a 3D texture (≙ WebGL `disposeTexture3D`).
 * NATIVE: no-op — no 3D texture can exist.
 * @param tex - The 3D texture.
 */
export function disposeTexture3D(tex: GLTexture3D): void {
    void tex;
}
