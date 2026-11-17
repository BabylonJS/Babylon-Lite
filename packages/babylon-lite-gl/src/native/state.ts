import type { GLEngineContext } from "./context.js";
import { getRenderHeight, getRenderWidth } from "./context.js";

/** Pixel-space viewport rectangle passed to `setViewport`. */
export interface GLViewport {
    /** Lower-left X origin in physical pixels. */
    x: number;
    /** Lower-left Y origin in physical pixels. */
    y: number;
    /** Width in physical pixels. */
    w: number;
    /** Height in physical pixels. */
    h: number;
}

/** Options for {@link clearEngine}. */
export interface GLClearOptions {
    /** When set, clears the color buffer to this RGBA color (alpha default 1). */
    color?: { r: number; g: number; b: number; a?: number };
    /** Clear the depth buffer. */
    depth?: boolean;
    /** Clear the stencil buffer. */
    stencil?: boolean;
}

/** Blend presets shared with Lite GL: disabled, additive, combine and premultiplied. */
export type GLBlendMode = 0 | 1 | 2 | 7;

/** Changes the drawing viewport. Defaults to the full default output in pixel coordinates. */
export function setViewport(engine: GLEngineContext, viewport?: GLViewport): void {
    const outputWidth = getRenderWidth(engine);
    const outputHeight = getRenderHeight(engine);
    if (!viewport) {
        setNormalizedViewport(engine, 0, 0, outputWidth, outputHeight, outputWidth, outputHeight);
        return;
    }
    const target = engine._target;
    setNormalizedViewport(engine, viewport.x, viewport.y, viewport.w, viewport.h, target?.width ?? outputWidth, target?.height ?? outputHeight);
}

/** @internal Native viewports are fractions of the bound target. */
export function setNormalizedViewport(engine: GLEngineContext, x: number, y: number, width: number, height: number, targetWidth: number, targetHeight: number): void {
    x /= targetWidth;
    y /= targetHeight;
    width /= targetWidth;
    height /= targetHeight;
    const values = engine._viewport;
    if (values[0] === x && values[1] === y && values[2] === width && values[3] === height) {
        return;
    }
    values[0] = x;
    values[1] = y;
    values[2] = width;
    values[3] = height;
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_SETVIEWPORT);
    commands.float(x);
    commands.float(y);
    commands.float(width);
    commands.float(height);
    commands.finish();
}

/** Restricts drawing to a bottom-left-origin rectangle in physical pixels. */
export function setScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_SETSCISSOR);
    commands.float(x);
    commands.float(y);
    commands.float(width);
    commands.float(height);
    commands.finish();
}

/** Restores unrestricted drawing. */
export function disableScissor(engine: GLEngineContext): void {
    setScissor(engine, 0, 0, 0, 0);
}

/** Sets a Lite GL blend preset. */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._blend === mode) {
        return;
    }
    const native = engine._runtime.Engine;
    const resolved = mode === 0 ? native.ALPHA_DISABLE : mode === 1 ? native.ALPHA_ADD : mode === 2 ? native.ALPHA_COMBINE : native.ALPHA_PREMULTIPLIED;
    const commands = engine._commands;
    commands.start(native.COMMAND_SETBLENDMODE);
    commands.uint(resolved);
    commands.finish();
    engine._blend = mode;
}

/** Clears the current composition target without changing its scissor. */
export function clearEngine(engine: GLEngineContext, options: GLClearOptions): void {
    const color = options.color;
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_CLEAR);
    commands.uint(color ? 1 : 0);
    commands.float(color?.r ?? 0);
    commands.float(color?.g ?? 0);
    commands.float(color?.b ?? 0);
    commands.float(color?.a ?? 1);
    commands.uint(options.depth ? 1 : 0);
    commands.float(1);
    commands.uint(options.stencil ? 1 : 0);
    commands.uint(0);
    commands.finish();
}
