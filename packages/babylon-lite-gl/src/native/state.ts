import type { GLEngineContext } from "./context.js";
import { getRenderHeight, getRenderWidth } from "./context.js";
import type { GLClearOptions, GLViewport } from "../family.js";

/** Blend presets shared with Lite GL: disabled, additive, combine and premultiplied. */
export type GLBlendMode = 0 | 1 | 2 | 7;

/** Changes the drawing viewport in pixels of the bound target. Defaults to the size of the default output, whichever target is bound. No-op for a disposed engine. */
export function setViewport(engine: GLEngineContext, viewport?: GLViewport): void {
    if (engine._disposed) {
        return;
    }
    const outputWidth = getRenderWidth(engine);
    const outputHeight = getRenderHeight(engine);
    const target = engine._target;
    setNormalizedViewport(
        engine,
        viewport?.x ?? 0,
        viewport?.y ?? 0,
        viewport?.w ?? outputWidth,
        viewport?.h ?? outputHeight,
        target?.width ?? outputWidth,
        target?.height ?? outputHeight
    );
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

/**
 * Restricts drawing and clearing to a bottom-left-origin rectangle in physical
 * pixels; portable callers pass nonnegative integer dimensions. A rectangle
 * without area allows neither until the scissor changes. No-op for a disposed
 * engine.
 */
export function setScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    if (engine._disposed) {
        return;
    }
    // The host reads an all-zero rectangle as "no scissor", so an empty one is enforced here instead.
    engine._scissorEmpty = width <= 0 || height <= 0;
    if (!engine._scissorEmpty) {
        encodeScissor(engine, x, y, width, height);
    }
}

/** Restores unrestricted drawing. No-op for a disposed engine. */
export function disableScissor(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
    engine._scissorEmpty = false;
    encodeScissor(engine, 0, 0, 0, 0);
}

function encodeScissor(engine: GLEngineContext, x: number, y: number, width: number, height: number): void {
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_SETSCISSOR);
    commands.float(x);
    commands.float(y);
    commands.float(width);
    commands.float(height);
    commands.finish();
}

/** Sets a Lite GL blend preset. No-op for a disposed engine. */
export function setBlendMode(engine: GLEngineContext, mode: GLBlendMode): void {
    if (engine._blend === mode || engine._disposed) {
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

/** Clears the current composition target within its scissor, without changing the scissor. No-op for a disposed engine. */
export function clearEngine(engine: GLEngineContext, options: GLClearOptions): void {
    if (engine._scissorEmpty || engine._disposed) {
        return;
    }
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
