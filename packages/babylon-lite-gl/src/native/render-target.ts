import type { GLEngineContext } from "./context.js";
import type { NativeResource, NativeResourceFields } from "./identity.js";
import type { NativeHandle } from "./runtime.js";
import { setNormalizedViewport } from "./state.js";
import { configureTexture, disposeTexture, makeTexture, validateTextureSize } from "./texture.js";
import type { GLTexture, NativeTextureHandle } from "./texture.js";

/** Options for {@link createRenderTarget}. */
export interface GLRenderTargetOptions {
    /** Caller-owned color attachment to render into instead of an owned RGBA8 texture. */
    colorTexture?: GLTexture;
}

/** Native framebuffer and its color attachment. */
export interface GLRenderTarget extends NativeResource<"renderTarget"> {
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

/** Creates a composition target around an owned or supplied color attachment of a live engine; a supplied attachment must be a live, renderable texture of this engine. */
export function createRenderTarget(engine: GLEngineContext, width: number, height: number, options?: GLRenderTargetOptions): GLRenderTarget {
    if (engine._disposed) {
        throw new Error("Native Lite GL createRenderTarget requires an engine that has not been disposed.");
    }
    validateTextureSize(engine, width, height);
    const colorTexture = options?.colorTexture;
    if (colorTexture && (colorTexture._engine !== engine || colorTexture._disposed)) {
        throw new Error("Native Lite GL createRenderTarget requires a color texture of this engine that has not been disposed.");
    }
    if (colorTexture?._sampledOnly) {
        throw new Error("Native Lite GL createRenderTarget cannot render into a sampled-only texture such as one from createRawTexture.");
    }
    let texture = colorTexture;
    if (!texture) {
        const handle = engine._native.createTexture();
        try {
            engine._native.initializeTexture(handle, width, height, false, engine._runtime.Engine.TEXTURE_FORMAT_RGBA8, true, false, 1);
            texture = makeTexture(engine, handle, true, false);
        } catch (error) {
            engine._native.deleteTexture(handle);
            throw error;
        }
    }
    try {
        const fields: NativeResourceFields<GLRenderTarget> = {
            width,
            height,
            texture,
            _framebuffer: engine._native.createFrameBuffer(texture._handle, width, height, false, false, 1),
            _ownsTexture: !colorTexture,
            _engine: engine,
            _disposed: false,
        };
        const target = fields as GLRenderTarget;
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
 * and sets the viewport to cover it. No-op for a disposed target or engine.
 */
export function bindRenderTarget(target: GLRenderTarget): void {
    if (target._disposed || target._engine._disposed) {
        return;
    }
    selectFramebuffer(target._engine, target);
    setNormalizedViewport(target._engine, 0, 0, 1, 1, 1, 1);
}

/** Selects the default output, resolving the prior framebuffer, and sets the viewport to cover it. No-op for a disposed engine. */
export function restoreDefaultFramebuffer(engine: GLEngineContext): void {
    if (engine._disposed) {
        return;
    }
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

const NO_FRAMEBUFFERS: readonly NativeHandle[] = [];

/**
 * Repoints a borrowed texture while preserving its render-target identities.
 * The swap is all-or-nothing: if the host cannot create a replacement
 * framebuffer, the texture and its targets keep their original storage.
 * A host can replace the storage behind the same handle object, so every call
 * rebuilds the framebuffers; call it only when the storage has changed.
 */
export function updateWrappedNativeTexture(texture: GLTexture, replacement: NativeTextureHandle): void {
    const engine = texture._engine;
    if (texture._owned || texture.width !== engine._native.getTextureWidth(replacement) || texture.height !== engine._native.getTextureHeight(replacement)) {
        throw new Error("Replacement native texture must preserve the borrowed texture's shape.");
    }
    const targets = texture._targets;
    const framebuffers = targets.length === 0 ? NO_FRAMEBUFFERS : createFramebuffers(engine, targets, replacement);
    for (const target of targets) {
        if (engine._target === target) {
            selectFramebuffer(engine, null);
        }
    }
    texture._handle = replacement;
    configureTexture(engine, texture);
    for (let index = 0; index < targets.length; index++) {
        const target = targets[index] as GLRenderTarget;
        deleteFramebuffer(engine, target._framebuffer);
        target._framebuffer = framebuffers[index] as NativeHandle;
    }
}

function createFramebuffers(engine: GLEngineContext, targets: readonly GLRenderTarget[], texture: NativeHandle): NativeHandle[] {
    const framebuffers: NativeHandle[] = [];
    try {
        for (const target of targets) {
            framebuffers.push(engine._native.createFrameBuffer(texture, target.width, target.height, false, false, 1));
        }
        return framebuffers;
    } catch (error) {
        for (const framebuffer of framebuffers) {
            deleteFramebuffer(engine, framebuffer);
        }
        throw error;
    }
}

function deleteFramebuffer(engine: GLEngineContext, framebuffer: NativeHandle): void {
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_DELETEFRAMEBUFFER);
    commands.handle(framebuffer);
    commands.finish();
}

/** Releases a framebuffer and only the color storage it owns; after engine disposal it only marks them disposed. */
export function disposeRenderTarget(target: GLRenderTarget | null | undefined): void {
    if (!target || target._disposed) {
        return;
    }
    target._disposed = true;
    const engine = target._engine;
    if (!engine._disposed) {
        if (engine._target === target) {
            selectFramebuffer(engine, null);
        }
        deleteFramebuffer(engine, target._framebuffer);
    }
    const index = target.texture._targets.indexOf(target);
    if (index >= 0) {
        target.texture._targets.splice(index, 1);
    }
    if (target._ownsTexture) {
        disposeTexture(target.texture);
    }
}
