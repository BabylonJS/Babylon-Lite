import type { GLEngineContext } from "./context.js";
import { compileShader, getLinkError, isLinkComplete, linkProgram } from "./shader.js";
import { bindTexture, type GLTexture } from "./texture.js";

/** Inputs to `createEffect`: shader sources plus the uniform, sampler and
 *  attribute names whose locations are resolved during readiness finalization. */
export interface GLEffectOptions {
    /** Human-readable label, surfaced in compile/link error messages. */
    name: string;
    /** GLSL ES 3.00 source, ready for `gl.shaderSource`. */
    vertexSource: string;
    /** GLSL ES 3.00 source, ready for `gl.shaderSource`. */
    fragmentSource: string;
    /** Declared uniform names. Locations are resolved during readiness
     *  finalization. Names not declared here are legal but allocate cache
     *  slots lazily on first setter use. */
    uniformNames: readonly string[];
    /** Declared sampler names, in unit-assignment order. Each gets a fixed
     *  texture unit assigned during readiness finalization, and
     *  `gl.uniform1i(loc, unit)` is called exactly once per program lifetime
     *  (re-run after `webglcontextrestored`). */
    samplerNames: readonly string[];
    /** Default `["position"]`. The first attribute is bound to location 0 via
     *  `gl.bindAttribLocation(program, 0, name)` BEFORE link, so the shared
     *  fullscreen-quad VAO always feeds the same location. */
    attributeNames?: readonly string[];
    /** Optional `#define` block. Each unique `defines` string must be paired
     *  with the same vertex/fragment source via a separate `createEffect` call —
     *  the package does NOT cache compiled variants. */
    defines?: string;
}

/** A compiled + linked shader program with cached uniform, sampler and
 *  attribute locations. Created by `createEffect`; most fields are managed
 *  internally — drive it via `isEffectReady` / `useEffect` / the `setEffect*`
 *  setters rather than mutating it directly. */
export interface GLEffect {
    /** The `name` from the originating `GLEffectOptions`. */
    readonly name: string;
    /** The options this effect was created from (retained for context-restore). */
    readonly options: GLEffectOptions;
    /** The live `WebGLProgram`. Swapped for a fresh handle after context-restore. */
    program: WebGLProgram;
    /** @internal */
    _vs: WebGLShader;
    /** @internal */
    _fs: WebGLShader;
    /** Resolved during readiness finalization. Missing names map to `null` —
     *  setters with a `null` location are silent no-ops (matches Babylon). */
    uniformLocations: { [name: string]: WebGLUniformLocation | null };
    /** Fixed unit assignment for declared samplers, index into
     *  `_state.boundTextures`. */
    samplerUnits: { [name: string]: number };
    /**
     * True once `gl.uniform1i(samplerLoc, unit)` has been issued for every
     * declared sampler. Cleared on context-lost so finalization re-runs.
     * @internal
     */
    _samplersAssigned: boolean;
    /** Resolved attribute locations, keyed by attribute name. */
    attributeLocations: { [name: string]: number };
    /**
     * Last-UPLOADED scalar floats. A setter that skips the upload must NOT
     * update this — otherwise a later real set with the same value would
     * incorrectly elide and the GPU would keep stale data.
     * @internal
     */
    readonly _lastF1: { [name: string]: number };
    /**
     * Last-UPLOADED vector floats (vec2/vec3/vec4). Plain `number[]` (NOT
     * `Float32Array`) so values like `0.1` compare equal across frames.
     * @internal
     */
    readonly _lastVec: { [name: string]: number[] };
    /** @internal */
    readonly _lastI1: { [name: string]: number };
    /** True once the program has linked and finalization has run; the
     *  `setEffect*` setters are no-ops until then. Poll `isEffectReady` to advance it. */
    isReady: boolean;
    /** @internal */
    _compileError: string | null;
    /** @internal */
    _disposed: boolean;
    /**
     * Number of live `createEffect` callers sharing this effect (and its one
     * `WebGLProgram`). `createEffect` returns the cached effect and bumps this
     * when an identical descriptor is requested; `disposeEffect` decrements it
     * and only tears the program down when it reaches 0.
     * @internal
     */
    _refCount: number;
    /**
     * The `_effectCache` key this effect was stored under (the source
     * descriptor). Used by `disposeEffect` to evict the cache entry at refcount
     * 0.
     * @internal
     */
    _cacheKey: string;
    /**
     * Callbacks fired exactly once on the first transition to ready.
     * @internal
     */
    readonly _onCompiled: ((effect: GLEffect) => void)[];
    /**
     * Replay closure for context-restore. Re-compiles + relinks into a fresh
     * `program` field. Finalization happens lazily on the next `isEffectReady`
     * poll.
     * @internal
     */
    _restore: (engine: GLEngineContext) => void;
}

/** Compile + link a new effect. Does NOT block on link completion — `isReady`
 *  starts false; consumers poll `isEffectReady` (typically from their render
 *  callback) to drive finalization. */
export function createEffect(engine: GLEngineContext, options: GLEffectOptions): GLEffect {
    const attribs = options.attributeNames ?? ["position"];
    const gl = engine.gl;

    // Per-engine cache keyed by the source descriptor. Identical descriptors
    // share ONE GLEffect (and thus one WebGLProgram), so `useEffect`'s
    // current-program cache can elide redundant `gl.useProgram` across the
    // consumers. The key covers every input that affects the program or its
    // readiness finalization, joined by a NUL separator (cannot appear in GLSL).
    const cacheKey = [options.vertexSource, options.fragmentSource, options.defines ?? "", attribs.join(","), options.uniformNames.join(","), options.samplerNames.join(",")].join(
        "\u0000"
    );
    const cached = engine._effectCache.get(cacheKey);
    if (cached !== undefined && !cached._disposed) {
        cached._refCount++;
        return cached;
    }

    const compileErr: (string | null)[] = [null];
    const finalVS = applyDefines(options.vertexSource, options.defines);
    const finalFS = applyDefines(options.fragmentSource, options.defines);

    const vs = compileShader(gl, finalVS, gl.VERTEX_SHADER, compileErr);
    if (vs === null) {
        throw new Error(`lite-gl: ${options.name} vertex compile failed: ${compileErr[0] ?? "unknown"}`);
    }
    const fs = compileShader(gl, finalFS, gl.FRAGMENT_SHADER, compileErr);
    if (fs === null) {
        gl.deleteShader(vs);
        throw new Error(`lite-gl: ${options.name} fragment compile failed: ${compileErr[0] ?? "unknown"}`);
    }
    const program = linkProgram(gl, vs, fs, attribs);
    if (program === null) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        throw new Error(`lite-gl: ${options.name} program allocation failed`);
    }

    const effect: GLEffect = {
        name: options.name,
        options,
        program,
        _vs: vs,
        _fs: fs,
        uniformLocations: {},
        samplerUnits: {},
        _samplersAssigned: false,
        attributeLocations: {},
        _lastF1: {},
        _lastVec: {},
        _lastI1: {},
        isReady: false,
        _compileError: null,
        _disposed: false,
        _refCount: 1,
        _cacheKey: cacheKey,
        _onCompiled: [],
        _restore: () => {},
    };

    effect._restore = (target: GLEngineContext): void => {
        const g = target.gl;
        const newVS = compileShader(g, applyDefines(options.vertexSource, options.defines), g.VERTEX_SHADER, [null]);
        const newFS = compileShader(g, applyDefines(options.fragmentSource, options.defines), g.FRAGMENT_SHADER, [null]);
        if (newVS === null || newFS === null) {
            effect._compileError = "context-restore: shader compile failed";
            return;
        }
        const newProg = linkProgram(g, newVS, newFS, attribs);
        if (newProg === null) {
            g.deleteShader(newVS);
            g.deleteShader(newFS);
            effect._compileError = "context-restore: program allocation failed";
            return;
        }
        effect.program = newProg;
        effect._vs = newVS;
        effect._fs = newFS;
        effect.isReady = false;
        effect._samplersAssigned = false;
        effect.uniformLocations = {};
        effect.attributeLocations = {};
        effect._compileError = null;
    };

    engine._effects.push(effect);
    engine._effectCache.set(cacheKey, effect);
    return effect;
}

/** Poll the link state and, on first success, run finalization (uniform-
 *  location resolution + one-shot sampler-unit `uniform1i` assignment +
 *  `_onCompiled` callbacks). Returns `true` once the effect is usable. */
export function isEffectReady(engine: GLEngineContext, effect: GLEffect): boolean {
    if (effect.isReady) {
        return true;
    }
    if (effect._disposed || engine._isLost || engine._disposed) {
        return false;
    }
    if (effect._compileError !== null) {
        return false;
    }
    if (!isLinkComplete(engine.gl, effect.program, engine.caps.parallelShaderCompile)) {
        return false;
    }
    const linkErr = getLinkError(engine.gl, effect.program);
    if (linkErr !== null) {
        effect._compileError = linkErr;
        console.error(`lite-gl: ${effect.name} link failed:`, linkErr);
        return false;
    }
    finalizeEffect(engine, effect);
    return true;
}

/** Resolves uniform/attribute locations, binds the program (cached), and
 *  issues the one-time `gl.uniform1i(samplerLoc, unit)` per declared sampler. */
function finalizeEffect(engine: GLEngineContext, effect: GLEffect): void {
    const gl = engine.gl;
    const program = effect.program;
    for (const name of effect.options.uniformNames) {
        effect.uniformLocations[name] = gl.getUniformLocation(program, name);
    }
    const attribs = effect.options.attributeNames ?? ["position"];
    for (const name of attribs) {
        effect.attributeLocations[name] = gl.getAttribLocation(program, name);
    }
    // Switch to this program via the cached helper so _state.currentProgram
    // stays consistent — no raw gl.useProgram outside useEffect.
    useEffect(engine, effect);
    let unit = 0;
    for (const name of effect.options.samplerNames) {
        const loc = gl.getUniformLocation(program, name);
        if (loc !== null) {
            gl.uniform1i(loc, unit);
        }
        effect.samplerUnits[name] = unit;
        unit++;
    }
    effect._samplersAssigned = true;
    effect.isReady = true;
    // Fire and clear the one-shot ready callbacks.
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

/** Fires `cb` synchronously if the effect is already ready; otherwise queues
 *  it for the next finalization. */
export function executeWhenCompiled(engine: GLEngineContext, effect: GLEffect, cb: (e: GLEffect) => void): void {
    if (isEffectReady(engine, effect)) {
        cb(effect);
        return;
    }
    effect._onCompiled.push(cb);
}

/** Decrement the share count and, on the last release, delete the effect's
 *  program + shaders, unregister it from the context + cache, and clear the
 *  cached current-program if it pointed at this effect. A shared effect (still
 *  referenced by another `createEffect` caller) is kept alive. Call exactly ONCE
 *  per `createEffect` (each call decrements the ref count); safe (no-op) once the
 *  effect is fully torn down. */
export function disposeEffect(engine: GLEngineContext, effect: GLEffect): void {
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
    if (!engine._isLost && !engine._disposed) {
        engine.gl.deleteProgram(effect.program);
        engine.gl.deleteShader(effect._vs);
        engine.gl.deleteShader(effect._fs);
    }
    if (engine._state.currentProgram === effect.program) {
        engine._state.currentProgram = null;
    }
    effect._onCompiled.length = 0;
}

/** Cached `gl.useProgram`. No-op when the effect is not ready or already current. */
export function useEffect(engine: GLEngineContext, effect: GLEffect): void {
    if (engine._isLost || engine._disposed || effect._disposed) {
        return;
    }
    if (engine._state.currentProgram === effect.program) {
        return;
    }
    engine.gl.useProgram(effect.program);
    engine._state.currentProgram = effect.program;
}

/* ────────────────────────────  cached setters  ────────────────────────────
 *
 * Each setter has the shape:
 *   1. bail when context lost / effect not ready (no cache write)
 *   2. lookup uniform location; bail on null (no cache write)
 *   3. compare against last-UPLOADED value; bail on equality
 *   4. write to cache, issue gl.uniform*
 *
 * Step 3's comparison is intentionally bit-equal (===) — NaN inputs re-upload
 * every frame because `NaN !== NaN`, which is the correct safety net for
 * caller bugs.
 */

/** Cached `gl.uniform1f`. No-op when context-lost, the effect isn't ready, the
 *  uniform is absent, or the value is unchanged since last upload. */
export function setEffectFloat(engine: GLEngineContext, effect: GLEffect, name: string, x: number): void {
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
    engine.gl.uniform1f(loc, x);
}

/** Cached `gl.uniform2f`. No-op when context-lost, the effect isn't ready, the
 *  uniform is absent, or the value is unchanged since last upload. */
export function setEffectFloat2(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number): void {
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
    engine.gl.uniform2f(loc, x, y);
}

/** Cached `gl.uniform3f`. No-op when context-lost, the effect isn't ready, the
 *  uniform is absent, or the value is unchanged since last upload. */
export function setEffectFloat3(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number, z: number): void {
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
    engine.gl.uniform3f(loc, x, y, z);
}

/** Cached `gl.uniform4f`. No-op when context-lost, the effect isn't ready, the
 *  uniform is absent, or the value is unchanged since last upload. */
export function setEffectFloat4(engine: GLEngineContext, effect: GLEffect, name: string, x: number, y: number, z: number, w: number): void {
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
    engine.gl.uniform4f(loc, x, y, z, w);
}

/** Cached `gl.uniform3f` from an r/g/b color object. Delegates to `setEffectFloat3`. */
export function setEffectColor3(engine: GLEngineContext, effect: GLEffect, name: string, c: { r: number; g: number; b: number }): void {
    setEffectFloat3(engine, effect, name, c.r, c.g, c.b);
}

/** Cached `gl.uniform4f` from an r/g/b/a color object. Delegates to `setEffectFloat4`. */
export function setEffectColor4(engine: GLEngineContext, effect: GLEffect, name: string, c: { r: number; g: number; b: number; a: number }): void {
    setEffectFloat4(engine, effect, name, c.r, c.g, c.b, c.a);
}

/** Cached `gl.uniform2f` from an `{x,y}` vector object — the lite-gl equivalent
 *  of Babylon's `Effect.setVector2`. Delegates to `setEffectFloat2`. */
export function setEffectVector2(engine: GLEngineContext, effect: GLEffect, name: string, v: { x: number; y: number }): void {
    setEffectFloat2(engine, effect, name, v.x, v.y);
}

/** Cached `gl.uniform4f` from an r/g/b/a color WITHOUT premultiplication — the
 *  lite-gl equivalent of Babylon's `Effect.setDirectColor4`. Delegates to
 *  `setEffectFloat4` (lite-gl never premultiplies in the uniform setters, so
 *  this matches `setEffectColor4`; the distinct name eases the ShapeBuilder
 *  port). */
export function setEffectDirectColor4(engine: GLEngineContext, effect: GLEffect, name: string, c: { r: number; g: number; b: number; a: number }): void {
    setEffectFloat4(engine, effect, name, c.r, c.g, c.b, c.a);
}

/** Cached `gl.uniform1i`. No-op when context-lost, the effect isn't ready, the
 *  uniform is absent, or the value is unchanged since last upload. */
export function setEffectInt(engine: GLEngineContext, effect: GLEffect, name: string, x: number): void {
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
    engine.gl.uniform1i(loc, x);
}

/* ── Matrix / array setters (uploaded every call — not value-cached) ──────────
 *
 * Matrices and arrays usually change every frame; element-wise caching would
 * cost more than the upload it saves, so these always issue the GL call (the
 * location lookup + ready guards still apply). They cover the ShapeBuilder
 * surface (`setMatrix3x3`, `setFloatArray`, `setFloatArray4`) plus a general
 * 4×4 matrix setter for any future mesh consumer. */

/** `gl.uniformMatrix4fv` from a column-major 4×4 matrix — the lite-gl
 *  equivalent of Babylon's `Effect.setMatrix`. Not value-cached. */
export function setEffectMatrix(engine: GLEngineContext, effect: GLEffect, name: string, matrix: Float32Array | number[]): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    engine.gl.uniformMatrix4fv(loc, false, matrix);
}

/** `gl.uniformMatrix3fv` from a column-major 3×3 matrix — the lite-gl
 *  equivalent of Babylon's `Effect.setMatrix3x3`. Not value-cached. */
export function setEffectMatrix3x3(engine: GLEngineContext, effect: GLEffect, name: string, matrix: Float32Array | number[]): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    engine.gl.uniformMatrix3fv(loc, false, matrix);
}

/** `gl.uniform1fv` — a flat float array (`Effect.setFloatArray` / `setArray`).
 *  Not value-cached. */
export function setEffectFloatArray(engine: GLEngineContext, effect: GLEffect, name: string, array: Float32Array | number[]): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    engine.gl.uniform1fv(loc, array);
}

/** `gl.uniform4fv` — an array of `vec4`s (`Effect.setFloatArray4` / `setArray4`).
 *  Not value-cached. */
export function setEffectFloatArray4(engine: GLEngineContext, effect: GLEffect, name: string, array: Float32Array | number[]): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    engine.gl.uniform4fv(loc, array);
}

/** `gl.uniform1iv` — a flat int array (`Effect.setIntArray`). Not value-cached. */
export function setEffectIntArray(engine: GLEngineContext, effect: GLEffect, name: string, array: Int32Array | number[]): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const loc = effect.uniformLocations[name];
    if (loc === null || loc === undefined) {
        return;
    }
    engine.gl.uniform1iv(loc, array);
}

/** Bind a texture to the sampler's pre-assigned unit (§4.4). NO `gl.uniform1i`
 *  is issued — that was done exactly once per program lifetime during
 *  finalization. This is the key win over Babylon's `Effect.setTexture` which
 *  re-issues the sampler binding on every call. */
export function setEffectTexture(engine: GLEngineContext, effect: GLEffect, samplerName: string, tex: GLTexture): void {
    if (engine._isLost || !effect.isReady) {
        return;
    }
    const unit = effect.samplerUnits[samplerName];
    if (unit === undefined) {
        return;
    }
    bindTexture(engine, unit, tex);
}

/** Resolve (and cache) a vertex-attribute location by name — the lite-gl
 *  equivalent of Babylon's `Effect.getAttributeLocationByName`. Locations for
 *  declared `attributeNames` are resolved during finalization; this also serves
 *  the mesh / instancing path, where attribute names are not declared up-front.
 *  Returns `-1` when the attribute is absent (matching `gl.getAttribLocation`).
 *  @internal */
export function getEffectAttributeLocation(engine: GLEngineContext, effect: GLEffect, name: string): number {
    const cached = effect.attributeLocations[name];
    if (cached !== undefined) {
        return cached;
    }
    const loc = engine.gl.getAttribLocation(effect.program, name);
    effect.attributeLocations[name] = loc;
    return loc;
}

/* ────────────────────────────  internal helpers  ──────────────────────────── */

/** Inject `options.defines` between the `#version`/precision header and the
 *  user shader body. Supports a `// __DEFINES__` marker (preferred — keeps the
 *  runtime regex-free, per spec §6.2) OR auto-detects the end of the leading
 *  preprocessor / precision lines. */
function applyDefines(source: string, defines: string | undefined): string {
    if (defines === undefined || defines.length === 0) {
        return source;
    }
    const marker = "// __DEFINES__";
    const idx = source.indexOf(marker);
    if (idx !== -1) {
        return source.slice(0, idx) + defines + source.slice(idx + marker.length);
    }
    // Fallback: insert after the last `precision` line (or after `#version`).
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
