import type { GLEngineContext } from "./context.js";
import type { NativeHandle } from "./runtime.js";
import { setNormalizedViewport } from "./state.js";
import { configureTexture, disposeTexture, makeTexture } from "./texture.js";
import type { GLTexture, NativeTextureHandle } from "./texture.js";

/** Options for {@link createRenderTarget}. */
export interface GLRenderTargetOptions {
    /** Caller-owned color attachment to render into instead of an owned RGBA8 texture. */
    colorTexture?: GLTexture;
}

/** Native framebuffer and its color attachment. */
export interface GLRenderTarget {
    readonly width: number;
    readonly height: number;
    readonly texture: GLTexture;
    /** @internal */
    _framebuffer: NativeHandle;
    /** @internal */
    readonly _ownsTexture: boolean;
    /** @internal The engine that owns this framebuffer. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** Creates a composition target around an owned or supplied color attachment. */
export function createRenderTarget(engine: GLEngineContext, width: number, height: number, options?: GLRenderTargetOptions): GLRenderTarget {
    const colorTexture = options?.colorTexture;
    let texture = colorTexture;
    if (!texture) {
        const handle = engine._native.createTexture();
        try {
            engine._native.initializeTexture(handle, width, height, false, engine._runtime.Engine.TEXTURE_FORMAT_RGBA8, true, false, 1);
            texture = makeTexture(engine, handle, true);
        } catch (error) {
            engine._native.deleteTexture(handle);
            throw error;
        }
    }
    try {
        const target: GLRenderTarget = {
            width,
            height,
            texture,
            _framebuffer: engine._native.createFrameBuffer(texture._handle, width, height, false, false, 1),
            _ownsTexture: !colorTexture,
            _engine: engine,
            _disposed: false,
        };
        texture._targets.push(target);
        return target;
    } catch (error) {
        if (!colorTexture) {
            disposeTexture(texture);
        }
        throw error;
    }
}

/**
 * Selects the drawing target, resolving the prior framebuffer before changing it,
 * and sets the viewport to cover it.
 */
export function bindRenderTarget(target: GLRenderTarget): void {
    selectFramebuffer(target._engine, target);
    setNormalizedViewport(target._engine, 0, 0, 1, 1, 1, 1);
}

/** Selects the default output, resolving the prior framebuffer, and sets the viewport to cover it. */
export function restoreDefaultFramebuffer(engine: GLEngineContext): void {
    selectFramebuffer(engine, null);
    setNormalizedViewport(engine, 0, 0, 1, 1, 1, 1);
}

function selectFramebuffer(engine: GLEngineContext, target: GLRenderTarget | null): void {
    if (engine._target === target) {
        return;
    }
    const commands = engine._commands;
    if (engine._target) {
        commands.start(engine._runtime.Engine.COMMAND_UNBINDFRAMEBUFFER);
        commands.handle(engine._target._framebuffer);
        commands.finish();
    }
    if (target) {
        commands.start(engine._runtime.Engine.COMMAND_BINDFRAMEBUFFER);
        commands.handle(target._framebuffer);
        commands.finish();
    }
    engine._target = target;
    // The native viewport belongs to the framebuffer binding, so the cached value no longer applies.
    engine._viewport.fill(NaN);
}

/** Repoints a borrowed texture while preserving its render-target identities. */
export function updateWrappedNativeTexture(texture: GLTexture, replacement: NativeTextureHandle): void {
    const engine = texture._engine;
    if (texture._owned || texture.width !== engine._native.getTextureWidth(replacement) || texture.height !== engine._native.getTextureHeight(replacement)) {
        throw new Error("Replacement native texture must preserve the borrowed texture's shape.");
    }
    for (const target of texture._targets) {
        if (engine._target === target) {
            selectFramebuffer(engine, null);
        }
    }
    texture._handle = replacement;
    configureTexture(engine, texture);
    for (const target of texture._targets) {
        const commands = engine._commands;
        commands.start(engine._runtime.Engine.COMMAND_DELETEFRAMEBUFFER);
        commands.handle(target._framebuffer);
        commands.finish();
        target._framebuffer = engine._native.createFrameBuffer(replacement, target.width, target.height, false, false, 1);
    }
}

/** Releases a framebuffer and only the color storage it owns. */
export function disposeRenderTarget(target: GLRenderTarget | null | undefined): void {
    if (!target || target._disposed) {
        return;
    }
    target._disposed = true;
    const engine = target._engine;
    if (engine._target === target) {
        selectFramebuffer(engine, null);
    }
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_DELETEFRAMEBUFFER);
    commands.handle(target._framebuffer);
    commands.finish();
    const index = target.texture._targets.indexOf(target);
    if (index >= 0) {
        target.texture._targets.splice(index, 1);
    }
    if (target._ownsTexture) {
        disposeTexture(target.texture);
    }
}
