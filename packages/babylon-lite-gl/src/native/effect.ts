/**
 * Native effect module — the native-backend twin of `effect.ts`. Mirrors its
 * PUBLIC API (createEffect / isEffectReady / useEffect / the setEffect* setters /
 * setEffectTexture) so consumers are source-compatible.
 *
 * NATIVE DIVERGENCES vs WebGL:
 *  - Compilation is asynchronous via `createProgramAsync`; readiness flips in the
 *    host's `onReady` callback rather than a `KHR_parallel_shader_compile` poll.
 *  - Uniform values are set through the command stream by the uniform's opaque
 *    native handle (not a `WebGLUniformLocation`), and a sampler is bound by
 *    passing its uniform handle to `COMMAND_SETTEXTURE` — there is no texture unit
 *    or one-shot `uniform1i(unit)` assignment.
 */
import type { GLEngineContext } from "./native-context.js";
import type { NativeProgram, NativeUniform } from "./native-types.js";
import type { GLTexture } from "./texture.js";
import {
    dCreateProgram,
    dDeleteProgram,
    dGetAttributeLocations,
    dGetUniformLocations,
    dSetFloat,
    dSetFloat2,
    dSetFloat3,
    dSetFloat4,
    dSetFloatArray,
    dSetFloatArray4,
    dSetInt,
    dSetIntArray,
    dSetMatrix,
    dSetMatrix3x3,
    dSetProgram,
    dSetTexture,
    dUnsetTexture,
} from "./native-device.js";

/** Inputs to {@link createEffect} — same shape as the WebGL `GLEffectOptions`. */
export interface GLEffectOptions {
    /** Human-readable label, surfaced in compile/link error messages. */
    name: string;
    /** GLSL ES 3.00 vertex source. */
    vertexSource: string;
    /** GLSL ES 3.00 fragment source. */
    fragmentSource: string;
    /** Declared uniform names. */
    uniformNames: readonly string[];
    /** Declared sampler names. */
    samplerNames: readonly string[];
    /** Attribute names (first is location 0). Default `["position"]`. */
    attributeNames?: readonly string[];
    /** Optional `#define` block prepended to both stages. */
    defines?: string;
}

/**
 * A compiled native program with cached uniform / sampler / attribute handles.
 * Field names mirror the WebGL `GLEffect` where meaningful.
 */
export interface GLEffect {
    /** The `name` from the originating options. */
    readonly name: string;
    /** The options this effect was created from (retained for device-restore). */
    readonly options: GLEffectOptions;
    /** The live native program. Swapped for a fresh handle after device-restore. */
    program: NativeProgram;
    /** Resolved uniform handles by name (null when absent). */
    uniformLocations: { [name: string]: NativeUniform | null };
    /** Resolved sampler uniform handles by name (null when absent). */
    samplerLocations: { [name: string]: NativeUniform | null };
    /** Texture unit per declared sampler (index in `samplerNames`, as on WebGL).
     *  Native binds textures to sampler uniforms, so units are emulated: the
     *  engine remembers the texture per unit and rebinds it to the current
     *  program's sampler with that unit (see `bindTexture`). */
    samplerUnits: { [name: string]: number };
    /** @internal Sampler handle per texture unit (index = unit). */
    _samplersByUnit: (NativeUniform | null)[];
    /** Resolved attribute locations by name. */
    attributeLocations: { [name: string]: number };
    /** @internal Last-uploaded scalar floats (value-cache). */
    readonly _lastF1: { [name: string]: number };
    /** @internal Last-uploaded vector floats. */
    readonly _lastVec: { [name: string]: number[] };
    /** @internal Last-uploaded ints. */
    readonly _lastI1: { [name: string]: number };
    /** True once linked + finalized; the setters are no-ops until then. */
    isReady: boolean;
    /** The engine that created (and owns) this effect. Operations on it derive
     *  their engine from here, so they take the effect alone. @internal */
    _engine: GLEngineContext;
    /** @internal Set once the async link callback has fired. */
    _linked: boolean;
    /** @internal */
    _compileError: string | null;
    /** @internal */
    _disposed: boolean;
    /** @internal Share count (identical descriptors reuse one program). */
    _refCount: number;
    /** @internal The `_effectCache` key. */
    _cacheKey: string;
    /** @internal One-shot ready callbacks. */
    readonly _onCompiled: ((effect: GLEffect) => void)[];
    /** @internal Recompile into a fresh program after device-restore. */
    _restore: (engine: GLEngineContext) => void;
    /** @internal Delete the native program (used by dispose). */
    _deleteGpu: (engine: GLEngineContext) => void;
}

/** Inject `options.defines` after the `#version`/precision header (same rule as
 *  the WebGL module's `applyDefines`). */
function applyDefines(source: string, defines: string | undefined): string {
    if (defines === undefined || defines.length === 0) {
        return source;
    }
    const marker = "// __DEFINES__";
    const idx = source.indexOf(marker);
    if (idx !== -1) {
        return source.slice(0, idx) + defines + source.slice(idx + marker.length);
    }
    const lines = source.split("\n");
    let insertAt = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) {
            continue;
        }
        const trimmed = line.trim();
        if (trimmed.startsWith("#version") || trimmed.startsWith("precision ")) {
            insertAt = i + 1;
        }
    }
    lines.splice(insertAt, 0, defines);
    return lines.join("\n");
}

/**
 * Native-only shader prep: the Babylon Native compiler
 * (`ShaderCompilerCommon.cpp::ProcessSamplerFlip`) REQUIRES a `#define SHADER_NAME`
 * line in every stage — it uses that line as the injection anchor for its
 * texelFetch V-flip macro and throws "Could not find shader name define" without
 * it. The WebGL backend has no such requirement, so this lives in the native
 * module only. No-op when the source already declares it.
 */
function applyShaderName(source: string, name: string): string {
    if (source.includes("#define SHADER_NAME")) {
        return source;
    }
    const id = name.replace(/[^A-Za-z0-9_]/g, "_") || "effect";
    const define = `#define SHADER_NAME ${id}\n`;
    // The define MUST sit before `main`: the native compiler's
    // `ProcessShaderCoordinates` rewrites the vertex stage as `substr(0, lastBrace)`
    // + a z-fixup, dropping anything after the final `}`. It must also stay after
    // `#version` (which has to remain the first line). lite-gl ships MINIFIED GLSL
    // (`#version 300 es\n<whole body on one line>`), so a naive "insert after the
    // precision line" lands past `main`; insert immediately after `#version`.
    if (source.startsWith("#version")) {
        const nl = source.indexOf("\n");
        if (nl !== -1) {
            return source.slice(0, nl + 1) + define + source.slice(nl + 1);
        }
    }
    return define + source;
}

/** Delete every key of a record in place — used to invalidate the per-effect
 *  uniform value caches on device-restore. The `_last*` fields are readonly refs,
 *  so they are cleared in place rather than reassigned. @internal */
function clearRecord(record: { [key: string]: unknown }): void {
    for (const key in record) {
        delete record[key];
    }
}

/**
 * Compile + link a new native effect (asynchronously). `isReady` starts false;
 * consumers poll {@link isEffectReady} (which returns the host-driven flag).
 * Identical descriptors share one program via the engine effect cache.
 */
export function createEffect(engine: GLEngineContext, options: GLEffectOptions): GLEffect {
    const attribs = options.attributeNames ?? ["position"];
    const cacheKey = [options.vertexSource, options.fragmentSource, options.defines ?? "", attribs.join(","), options.uniformNames.join(","), options.samplerNames.join(",")].join(
        "\u0000"
    );
    const cached = engine._effectCache.get(cacheKey);
    if (cached !== undefined && !cached._disposed) {
        cached._refCount++;
        return cached;
    }

    const samplerUnits: { [name: string]: number } = {};
    options.samplerNames.forEach((name, unit) => {
        samplerUnits[name] = unit;
    });
    const effect: GLEffect = {
        name: options.name,
        options,
        program: null as unknown as NativeProgram,
        uniformLocations: {},
        samplerLocations: {},
        samplerUnits,
        _samplersByUnit: [],
        attributeLocations: {},
        _lastF1: {},
        _lastVec: {},
        _lastI1: {},
        isReady: false,
        _engine: engine,
        _linked: false,
        _compileError: null,
        _disposed: false,
        _refCount: 1,
        _cacheKey: cacheKey,
        _onCompiled: [],
        _restore: () => {},
        _deleteGpu: (e) => {
            if (effect.program !== null) {
                dDeleteProgram(e, effect.program);
            }
        },
    };

    // Kick off the async build and attach the link/error callbacks (sets
    // effect.program to the real handle).
    installLinkCallbacks(engine, effect);

    effect._restore = (target: GLEngineContext): void => {
        effect.isReady = false;
        effect._linked = false;
        effect._compileError = null;
        effect.uniformLocations = {};
        effect.samplerLocations = {};
        effect._samplersByUnit = [];
        effect.attributeLocations = {};
        // The rebuilt program's uniforms default to 0, so a same-value setter
        // after restore must NOT elide against a stale value cache (mirrors the
        // WebGL backend clearing _lastF1/_lastVec/_lastI1 in context.ts on restore).
        clearRecord(effect._lastF1);
        clearRecord(effect._lastVec);
        clearRecord(effect._lastI1);
        installLinkCallbacks(target, effect);
    };

    engine._effects.push(effect);
    engine._effectCache.set(cacheKey, effect);
    return effect;
}

/** Bind the link-complete / error callbacks by driving the async compile with
 *  callbacks that target `effect`, and store the resulting native program handle. */
function installLinkCallbacks(engine: GLEngineContext, effect: GLEffect): void {
    const vs = applyShaderName(applyDefines(effect.options.vertexSource, effect.options.defines), effect.name);
    const fs = applyShaderName(applyDefines(effect.options.fragmentSource, effect.options.defines), effect.name);
    effect.program = null as unknown as NativeProgram;
    try {
        effect.program = dCreateProgram(
            engine,
            vs,
            fs,
            () => {
                effect._linked = true;
                if (!effect._disposed && !engine._isLost && !engine._disposed) {
                    finalizeEffect(engine, effect);
                }
            },
            (error: Error) => {
                recordCompilationError(effect, error);
            }
        );
    } catch (error) {
        // Non-blocking compile contract (matches WebGL): a host that rejects the
        // sources synchronously must not make createEffect throw — the failure is
        // reported through getEffectCompilationError / waitForEffect instead.
        recordCompilationError(effect, error);
    }
}

/** Record a compile/link failure: the effect stays not-ready, the diagnostic is
 *  retained for {@link getEffectCompilationError}, and it is logged once in the
 *  WebGL backend's format. */
function recordCompilationError(effect: GLEffect, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    effect._compileError = message;
    effect.isReady = false;
    console.error(`lite-gl: ${effect.name} ${message}`);
}

/** Resolve locations, make the program current, and fire ready callbacks. */
function finalizeEffect(engine: GLEngineContext, effect: GLEffect): void {
    if (effect.isReady) {
        return;
    }
    const uniformNames = effect.options.uniformNames;
    if (uniformNames.length > 0) {
        const locs = dGetUniformLocations(engine, effect.program, uniformNames.slice());
        for (let i = 0; i < uniformNames.length; i++) {
            effect.uniformLocations[uniformNames[i]!] = locs[i] ?? null;
        }
    }
    const samplerNames = effect.options.samplerNames;
    if (samplerNames.length > 0) {
        const locs = dGetUniformLocations(engine, effect.program, samplerNames.slice());
        for (let i = 0; i < samplerNames.length; i++) {
            effect.samplerLocations[samplerNames[i]!] = locs[i] ?? null;
            effect._samplersByUnit[i] = locs[i] ?? null;
        }
    }
    const attribs = effect.options.attributeNames ?? ["position"];
    const attribLocs = dGetAttributeLocations(engine, effect.program, attribs.slice());
    for (let i = 0; i < attribs.length; i++) {
        effect.attributeLocations[attribs[i]!] = attribLocs[i] ?? -1;
    }
    useEffect(effect);
    effect.isReady = true;
    const cbs = effect._onCompiled.slice();
    effect._onCompiled.length = 0;
    for (const cb of cbs) {
        try {
            cb(effect);
        } catch (err) {
            console.error(`lite-gl: ${effect.name} onCompiled callback threw`, err);
        }
    }
}

/** Returns true once the native program has linked + finalized. Finalizes a
 *  linked-but-not-yet-finalized effect on this poll. */
export function isEffectReady(effect: GLEffect): boolean {
    const engine = effect._engine;
    if (effect.isReady) {
        return true;
    }
    if (effect._disposed || engine._isLost || engine._disposed || effect._compileError !== null) {
        return false;
    }
    if (effect._linked) {
        finalizeEffect(engine, effect);
    }
    return effect.isReady;
}

/**
 * Poll readiness once and return the recorded compile/link diagnostic, or
 * `null` while pending / when no failure has been recorded (not a readiness
 * guarantee). On native the diagnostic arrives through `createProgramAsync`'s
 * error callback, so it may become non-null on a later frame.
 *
 * @param effect - The effect to query.
 * @returns The compile/link error message, or `null`.
 */
export function getEffectCompilationError(effect: GLEffect): string | null {
    isEffectReady(effect);
    return effect._compileError;
}

/** Fire `cb` now if ready, else queue it for finalization. */
export function executeWhenCompiled(effect: GLEffect, cb: (e: GLEffect) => void): void {
    if (isEffectReady(effect)) {
        cb(effect);
        return;
    }
    effect._onCompiled.push(cb);
}

/** Cached `COMMAND_SETPROGRAM`. No-op when not ready or already current. */
export function useEffect(effect: GLEffect): void {
    const engine = effect._engine;
    if (engine._isLost || engine._disposed || effect._disposed) {
        return;
    }
    if (engine._state.currentProgram === effect.program) {
        return;
    }
    const s = engine._state;
    dSetProgram(engine, effect.program);
    s.currentProgram = effect.program;
    s.currentSamplers = effect._samplersByUnit;
    // Emulated texture units: re-point this program's samplers at the textures
    // bound to their units. bgfx keeps stage bindings across programs, so an
    // empty unit is explicitly unset rather than inheriting a stale (possibly
    // deleted) texture from another program's sampler on the same stage.
    const samplers = effect._samplersByUnit;
    for (let unit = 0; unit < samplers.length; unit++) {
        const loc = samplers[unit];
        if (loc === null || loc === undefined) {
            continue;
        }
        const handle = s.boundTextures[unit];
        if (handle !== null && handle !== undefined) {
            dSetTexture(engine, loc, handle);
        } else {
            dUnsetTexture(engine, loc);
        }
    }
}

/** Decrement the share count; delete the program on last release. */
export function disposeEffect(effect: GLEffect): void {
    const engine = effect._engine;
    if (effect._disposed) {
        return;
    }
    if (--effect._refCount > 0) {
        return;
    }
    effect._disposed = true;
    effect.isReady = false;
    const i = engine._effects.indexOf(effect);
    if (i !== -1) {
        engine._effects.splice(i, 1);
    }
    engine._effectCache.delete(effect._cacheKey);
    if (!engine._isLost && !engine._disposed && effect.program !== null) {
        dDeleteProgram(engine, effect.program);
    }
    if (engine._state.currentProgram === effect.program) {
        engine._state.currentProgram = null;
        engine._state.currentSamplers = null;
    }
    effect._onCompiled.length = 0;
}

/* ────────────────────────────  cached setters  ──────────────────────────── */

/** Cached `COMMAND_SETFLOAT`. */
export function setEffectFloat(effect: GLEffect, name: string, x: number): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    if (effect._lastF1[name] === x) {
        return;
    }
    effect._lastF1[name] = x;
    dSetFloat(engine, loc, x);
}

/** Cached `COMMAND_SETFLOAT2`. */
export function setEffectFloat2(effect: GLEffect, name: string, x: number, y: number): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    let v = effect._lastVec[name];
    if (v !== undefined && v[0] === x && v[1] === y) {
        return;
    }
    if (v === undefined) {
        v = [x, y];
        effect._lastVec[name] = v;
    } else {
        v[0] = x;
        v[1] = y;
    }
    dSetFloat2(engine, loc, x, y);
}

/** Cached `COMMAND_SETFLOAT3`. */
export function setEffectFloat3(effect: GLEffect, name: string, x: number, y: number, z: number): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    let v = effect._lastVec[name];
    if (v !== undefined && v[0] === x && v[1] === y && v[2] === z) {
        return;
    }
    if (v === undefined) {
        v = [x, y, z];
        effect._lastVec[name] = v;
    } else {
        v[0] = x;
        v[1] = y;
        v[2] = z;
    }
    dSetFloat3(engine, loc, x, y, z);
}

/** Cached `COMMAND_SETFLOAT4`. */
export function setEffectFloat4(effect: GLEffect, name: string, x: number, y: number, z: number, w: number): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    let v = effect._lastVec[name];
    if (v !== undefined && v[0] === x && v[1] === y && v[2] === z && v[3] === w) {
        return;
    }
    if (v === undefined) {
        v = [x, y, z, w];
        effect._lastVec[name] = v;
    } else {
        v[0] = x;
        v[1] = y;
        v[2] = z;
        v[3] = w;
    }
    dSetFloat4(engine, loc, x, y, z, w);
}

/** Cached float3 from an r/g/b color. */
export function setEffectColor3(effect: GLEffect, name: string, c: { r: number; g: number; b: number }): void {
    setEffectFloat3(effect, name, c.r, c.g, c.b);
}

/** Cached float4 from an r/g/b/a color. */
export function setEffectColor4(effect: GLEffect, name: string, c: { r: number; g: number; b: number; a: number }): void {
    setEffectFloat4(effect, name, c.r, c.g, c.b, c.a);
}

/** Cached float2 from an `{x,y}` vector. */
export function setEffectVector2(effect: GLEffect, name: string, v: { x: number; y: number }): void {
    setEffectFloat2(effect, name, v.x, v.y);
}

/** Cached float4 from an r/g/b/a color (no premultiply) — parity alias. */
export function setEffectDirectColor4(effect: GLEffect, name: string, c: { r: number; g: number; b: number; a: number }): void {
    setEffectFloat4(effect, name, c.r, c.g, c.b, c.a);
}

/** Cached `COMMAND_SETINT`. */
export function setEffectInt(effect: GLEffect, name: string, x: number): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    if (effect._lastI1[name] === x) {
        return;
    }
    effect._lastI1[name] = x;
    dSetInt(engine, loc, x);
}

/** `COMMAND_SETMATRICES` from a column-major 4×4 (not value-cached). */
export function setEffectMatrix(effect: GLEffect, name: string, matrix: Float32Array | number[]): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    dSetMatrix(engine, loc, matrix);
}

/** `COMMAND_SETMATRIX3X3` (not value-cached). */
export function setEffectMatrix3x3(effect: GLEffect, name: string, matrix: Float32Array | number[]): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    dSetMatrix3x3(engine, loc, matrix);
}

/** `COMMAND_SETFLOATARRAY` (not value-cached). */
export function setEffectFloatArray(effect: GLEffect, name: string, array: Float32Array | number[]): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    dSetFloatArray(engine, loc, array);
}

/** `COMMAND_SETFLOATARRAY4` (not value-cached). */
export function setEffectFloatArray4(effect: GLEffect, name: string, array: Float32Array | number[]): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    dSetFloatArray4(engine, loc, array);
}

/** `COMMAND_SETINTARRAY` (not value-cached). */
export function setEffectIntArray(effect: GLEffect, name: string, array: Int32Array | number[]): void {
    const engine = effect._engine;
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    dSetIntArray(engine, loc, array instanceof Int32Array ? array : Int32Array.from(array));
}

/**
 * Bind a texture to a sampler by its uniform handle (`COMMAND_SETTEXTURE`) — the
 * native equivalent of the WebGL `setEffectTexture` (which binds to the sampler's
 * texture unit).
 */
export function setEffectTexture(effect: GLEffect, samplerName: string, tex: GLTexture | null): void {
    const engine = effect._engine;
    if (engine._isLost || engine._disposed || !effect.isReady) {
        return;
    }
    const unit = effect.samplerUnits[samplerName];
    const loc = effect.samplerLocations[samplerName];
    if (unit === undefined || loc === null || loc === undefined || tex?._disposed) {
        return;
    }
    // Always re-issue: a re-uploaded native texture swaps its bgfx handle, so a
    // cached stage binding could be stale.
    engine._state.boundTextures[unit] = tex === null ? null : tex.handle;
    if (tex === null) {
        dUnsetTexture(engine, loc);
    } else {
        dSetTexture(engine, loc, tex.handle);
    }
}

/** Resolve (and cache) a vertex-attribute location by name (`-1` when absent).
 *  Mirrors the WebGL `getEffectAttributeLocation`. @internal */
export function getEffectAttributeLocation(effect: GLEffect, name: string): number {
    const engine = effect._engine;
    const cached = effect.attributeLocations[name];
    if (cached !== undefined) {
        return cached;
    }
    const loc = dGetAttributeLocations(engine, effect.program, [name])[0] ?? -1;
    effect.attributeLocations[name] = loc;
    return loc;
}
