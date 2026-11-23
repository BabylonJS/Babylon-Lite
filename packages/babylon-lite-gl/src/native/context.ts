import { CommandStream } from "./command-stream.js";
import type { NativeResource, NativeResourceFields } from "./identity.js";
import { getRuntime } from "./runtime.js";
import type { NativeEngine, NativeHandle, NativeRuntime } from "./runtime.js";
import type { GLRenderTarget } from "./render-target.js";

/** Device limits used by composition producers. */
export interface GLEngineCaps {
    /** Largest supported texture dimension, or 0 when the host has not reported one. */
    readonly maxTextureSize: number;
}

/** Composition state owned by one Babylon Native engine. */
export interface GLEngineContext extends NativeResource<"engine"> {
    /** Device limits. */
    readonly caps: GLEngineCaps;
    /** @internal */
    readonly _runtime: NativeRuntime;
    /** @internal */
    readonly _native: NativeEngine;
    /** @internal */
    readonly _commands: CommandStream;
    /** @internal */
    _target: GLRenderTarget | null;
    /** @internal */
    _program: NativeHandle | null;
    /** @internal */
    _vertexArray: NativeHandle | null;
    /** @internal */
    _blend: number;
    /** @internal Normalized viewport last sent to the native engine. */
    readonly _viewport: number[];
    /** @internal */
    _textureGeneration: number;
    /** @internal Whether the scissor rectangle has no area, so drawing and clearing do nothing. */
    _scissorEmpty: boolean;
    /** @internal */
    _disposed: boolean;
}

/** Creates the native composition engine without a scene graph. */
export function createNativeEngine(): GLEngineContext {
    const runtime = getRuntime();
    const nativeEngine = new runtime.Engine({ version: "@babylonjs/lite-gl/native", nonFloatVertexBuffers: true });
    const fields: NativeResourceFields<GLEngineContext> = {
        caps: { maxTextureSize: runtime.Engine.CAPS_LIMITS_MAX_TEXTURE_SIZE },
        _runtime: runtime,
        _native: nativeEngine,
        _commands: new CommandStream(runtime, nativeEngine),
        _target: null,
        _program: null,
        _vertexArray: null,
        _blend: -1,
        _viewport: [NaN, NaN, NaN, NaN],
        _textureGeneration: 0,
        _scissorEmpty: false,
        _disposed: false,
    };
    const engine = fields as GLEngineContext;
    nativeEngine.setHardwareScalingLevel(1);
    nativeEngine.setRenderResetCallback(() => {
        engine._target = null;
        engine._program = null;
        engine._vertexArray = null;
        engine._blend = -1;
        engine._viewport.fill(NaN);
        engine._textureGeneration++;
        engine._scissorEmpty = false;
        initializeCompositionState(engine);
    });
    initializeCompositionState(engine);
    return engine;
}

/** Composition draws without depth testing, culling or a scissor rectangle. */
function initializeCompositionState(engine: GLEngineContext): void {
    const runtime = engine._runtime;
    const commands = engine._commands;
    commands.start(runtime.Engine.COMMAND_SETDEPTHTEST);
    commands.uint(runtime.Engine.DEPTH_TEST_ALWAYS);
    commands.finish();
    commands.start(runtime.Engine.COMMAND_SETDEPTHWRITE);
    commands.uint(0);
    commands.finish();
    commands.start(runtime.Engine.COMMAND_SETSTATE);
    commands.uint(0);
    commands.float(0);
    commands.float(0);
    commands.uint(1);
    commands.uint(0);
    commands.finish();
    // The host keeps the default output's scissor across a device reset; an all-zero rectangle removes it.
    commands.start(runtime.Engine.COMMAND_SETSCISSOR);
    commands.float(0);
    commands.float(0);
    commands.float(0);
    commands.float(0);
    commands.finish();
}

/** Begins a native command submission scope. */
export function beginFrame(engine: GLEngineContext): void {
    engine._commands.begin();
    engine._textureGeneration++;
}

/** Submits a native frame, including commands recorded before a caller error. */
export function endFrame(engine: GLEngineContext): void {
    engine._commands.end();
}

/** Releases the engine after its renderer resources have been disposed. */
export function disposeNativeEngine(engine: GLEngineContext): void {
    if (!engine._disposed) {
        engine._disposed = true;
        engine._native.dispose();
    }
}

/** Default output width in physical pixels, the native counterpart of the canvas width. */
export function getRenderWidth(engine: GLEngineContext): number {
    return engine._native.getRenderWidth();
}

/** Default output height in physical pixels, the native counterpart of the canvas height. */
export function getRenderHeight(engine: GLEngineContext): number {
    return engine._native.getRenderHeight();
}

/** Current drawing target, or null for the default output. */
export function getCurrentRenderTarget(engine: GLEngineContext): GLRenderTarget | null {
    return engine._target;
}
