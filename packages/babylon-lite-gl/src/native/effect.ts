import type { GLEngineContext } from "./context.js";
import type { NativeHandle } from "./runtime.js";
import type { GLTexture } from "./texture.js";

/** GLSL ES 3.00 program inputs, matching Lite GL's effect descriptor. */
export interface GLEffectOptions {
    name: string;
    vertexSource: string;
    fragmentSource: string;
    uniformNames: readonly string[];
    samplerNames: readonly string[];
    attributeNames?: readonly string[];
    defines?: string;
}

/** Native shader program and its retained upload state. */
export interface GLEffect {
    readonly name: string;
    /** @internal */
    readonly _program: NativeHandle;
    /** @internal */
    readonly _uniforms: Record<string, NativeHandle | null>;
    /** @internal */
    readonly _values: Record<string, number[]>;
    /** @internal */
    readonly _textures: Record<string, NativeHandle | undefined>;
    /** @internal */
    readonly _samplers: readonly string[];
    /** @internal */
    _textureGeneration: number;
    /** @internal */
    readonly _attributes: Record<string, number>;
    /** @internal The engine that owns this effect; effect operations derive it from here. */
    readonly _engine: GLEngineContext;
    /** @internal */
    _disposed: boolean;
}

/** Compiles a native effect from host-prepared GLSL. */
export function createEffect(engine: GLEngineContext, options: GLEffectOptions): GLEffect {
    const defines = options.defines ?? "";
    const program = engine._native.createProgram(withDefines(options.vertexSource, defines), withDefines(options.fragmentSource, defines));
    const names = [...options.uniformNames, ...options.samplerNames];
    const handles = engine._native.getUniforms(program, names);
    const uniforms: GLEffect["_uniforms"] = {};
    const values: GLEffect["_values"] = {};
    for (let index = 0; index < names.length; index++) {
        const name = names[index] as string;
        uniforms[name] = handles[index] ?? null;
        values[name] = [];
    }
    const attributeNames = [...(options.attributeNames ?? ["position"])];
    const locations = engine._native.getAttributes(program, attributeNames);
    const attributes: GLEffect["_attributes"] = {};
    for (let index = 0; index < attributeNames.length; index++) {
        attributes[attributeNames[index] as string] = locations[index] ?? -1;
    }
    const textures: GLEffect["_textures"] = {};
    for (const name of options.samplerNames) {
        textures[name] = undefined;
    }
    return {
        name: options.name,
        _program: program,
        _uniforms: uniforms,
        _values: values,
        _textures: textures,
        _samplers: [...options.samplerNames],
        _textureGeneration: -1,
        _attributes: attributes,
        _engine: engine,
        _disposed: false,
    };
}

/** Native compiles unversioned GLSL, so the WebGL2 `#version` header is dropped and defines lead the source. */
function withDefines(source: string, defines: string): string {
    const body = source.startsWith("#version") ? source.slice(source.indexOf("\n") + 1) : source;
    return defines ? `${defines}\n${body}` : body;
}

/** Selects a program without reissuing an unchanged native binding. */
export function useEffect(effect: GLEffect): void {
    const engine = effect._engine;
    if (engine._program !== effect._program) {
        const commands = engine._commands;
        commands.start(engine._runtime.Engine.COMMAND_SETPROGRAM);
        commands.handle(effect._program);
        commands.finish();
        engine._program = effect._program;
        engine._textureGeneration++;
    }
}

/** Reports whether the effect's synchronous compilation succeeded and it is still owned. */
export function isEffectReady(effect: GLEffect): boolean {
    return !effect._disposed;
}

/** Native compilation failures throw from {@link createEffect}, so there is never a deferred error. */
export function getEffectCompilationError(_effect: GLEffect): string | null {
    return null;
}

/** Releases the owned shader program. */
export function disposeEffect(effect: GLEffect): void {
    if (effect._disposed) {
        return;
    }
    effect._disposed = true;
    const engine = effect._engine;
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_DELETEPROGRAM);
    commands.handle(effect._program);
    commands.finish();
    if (engine._program === effect._program) {
        engine._program = null;
    }
}

function changed(effect: GLEffect, name: string, count: number, x: number, y = 0, z = 0, w = 0): boolean {
    const values = effect._values[name];
    if (!values || !effect._uniforms[name]) {
        return false;
    }
    if (values.length === count && values[0] === x && (count < 2 || values[1] === y) && (count < 3 || values[2] === z) && (count < 4 || values[3] === w)) {
        return false;
    }
    values.length = count;
    values[0] = x;
    if (count > 1) {
        values[1] = y;
    }
    if (count > 2) {
        values[2] = z;
    }
    if (count > 3) {
        values[3] = w;
    }
    return true;
}

function uniformCommand(effect: GLEffect, name: string, command: NativeHandle): void {
    useEffect(effect);
    const commands = effect._engine._commands;
    commands.start(command);
    commands.handle(effect._uniforms[name] as NativeHandle);
}

/** Uploads a changed scalar float. */
export function setEffectFloat(effect: GLEffect, name: string, x: number): void {
    if (changed(effect, name, 1, x)) {
        const engine = effect._engine;
        uniformCommand(effect, name, engine._runtime.Engine.COMMAND_SETFLOAT);
        engine._commands.float(x);
        engine._commands.finish();
    }
}

/** Uploads a changed two-component float. */
export function setEffectFloat2(effect: GLEffect, name: string, x: number, y: number): void {
    if (changed(effect, name, 2, x, y)) {
        const engine = effect._engine;
        uniformCommand(effect, name, engine._runtime.Engine.COMMAND_SETFLOAT2);
        engine._commands.float(x);
        engine._commands.float(y);
        engine._commands.finish();
    }
}

/** Uploads a changed three-component float. */
export function setEffectFloat3(effect: GLEffect, name: string, x: number, y: number, z: number): void {
    if (changed(effect, name, 3, x, y, z)) {
        const engine = effect._engine;
        uniformCommand(effect, name, engine._runtime.Engine.COMMAND_SETFLOAT3);
        engine._commands.float(x);
        engine._commands.float(y);
        engine._commands.float(z);
        engine._commands.finish();
    }
}

/** Uploads a changed four-component float. */
export function setEffectFloat4(effect: GLEffect, name: string, x: number, y: number, z: number, w: number): void {
    if (changed(effect, name, 4, x, y, z, w)) {
        const engine = effect._engine;
        uniformCommand(effect, name, engine._runtime.Engine.COMMAND_SETFLOAT4);
        engine._commands.float(x);
        engine._commands.float(y);
        engine._commands.float(z);
        engine._commands.float(w);
        engine._commands.finish();
    }
}

/** Uploads a changed scalar integer or Boolean uniform. */
export function setEffectInt(effect: GLEffect, name: string, value: number): void {
    if (changed(effect, name, 1, value)) {
        const engine = effect._engine;
        uniformCommand(effect, name, engine._runtime.Engine.COMMAND_SETINT);
        engine._commands.int(value);
        engine._commands.finish();
    }
}

/** @internal */
export function setUniformArray(effect: GLEffect, name: string, values: ArrayLike<number>, command: NativeHandle): void {
    const cached = effect._values[name];
    if (!cached || !effect._uniforms[name]) {
        return;
    }
    let differs = cached.length !== values.length;
    for (let index = 0; index < values.length; index++) {
        differs ||= cached[index] !== values[index];
    }
    if (!differs) {
        return;
    }
    cached.length = values.length;
    for (let index = 0; index < values.length; index++) {
        cached[index] = values[index] as number;
    }
    uniformCommand(effect, name, command);
    effect._engine._commands.array(values);
    effect._engine._commands.finish();
}

/** Uploads a changed matrix in column-major order. */
export function setEffectMatrix(effect: GLEffect, name: string, values: ArrayLike<number>): void {
    setUniformArray(effect, name, values, effect._engine._runtime.Engine.COMMAND_SETMATRICES);
}

/** Uploads a changed scalar float array. */
export function setEffectFloatArray(effect: GLEffect, name: string, values: ArrayLike<number>): void {
    setUniformArray(effect, name, values, effect._engine._runtime.Engine.COMMAND_SETFLOATARRAY);
}

/** Uploads a changed array of two-component floats. */
export function setEffectFloatArray2(effect: GLEffect, name: string, values: ArrayLike<number>): void {
    setUniformArray(effect, name, values, effect._engine._runtime.Engine.COMMAND_SETFLOATARRAY2);
}

/** Uploads a changed array of three-component floats. */
export function setEffectFloatArray3(effect: GLEffect, name: string, values: ArrayLike<number>): void {
    setUniformArray(effect, name, values, effect._engine._runtime.Engine.COMMAND_SETFLOATARRAY3);
}

/** Uploads a changed array of four-component floats. */
export function setEffectFloatArray4(effect: GLEffect, name: string, values: ArrayLike<number>): void {
    setUniformArray(effect, name, values, effect._engine._runtime.Engine.COMMAND_SETFLOATARRAY4);
}

/** Binds a sampler without repeating an unchanged texture binding. */
export function setEffectTexture(effect: GLEffect, name: string, texture: GLTexture): void {
    useEffect(effect);
    const engine = effect._engine;
    // Native retains program uniforms, but sampler slots belong to the current frame's encoder.
    if (effect._textureGeneration !== engine._textureGeneration) {
        for (let index = 0; index < effect._samplers.length; index++) {
            effect._textures[effect._samplers[index] as string] = undefined;
        }
        effect._textureGeneration = engine._textureGeneration;
    }
    const uniform = effect._uniforms[name];
    if (!uniform || effect._textures[name] === texture._handle) {
        return;
    }
    const commands = engine._commands;
    commands.start(engine._runtime.Engine.COMMAND_SETTEXTURE);
    commands.handle(uniform);
    commands.handle(texture._handle);
    commands.finish();
    effect._textures[name] = texture._handle;
}
