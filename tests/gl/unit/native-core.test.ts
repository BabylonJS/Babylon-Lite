import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createMockNative, type MockNative } from "./_native-mock";
import { createNativeGLEngine, disposeNativeGLEngine, type GLEngineContext } from "../../../packages/babylon-lite-gl/src/native/native-context";
import { applyEffectWrapper, createEffectWrapper, drawEffect, setViewport } from "../../../packages/babylon-lite-gl/src/native/effect-renderer";
import { isEffectReady, setEffectFloat4 } from "../../../packages/babylon-lite-gl/src/native/effect";
import { createRawTexture } from "../../../packages/babylon-lite-gl/src/native/texture";
import { createSpriteRenderer, renderSprites, type GLSprite } from "../../../packages/babylon-lite-gl/src/native/sprites";
import { setScissor } from "../../../packages/babylon-lite-gl/src/native/scissor";
import { clearEngine } from "../../../packages/babylon-lite-gl/src/native/depth-stencil";
import { GLBlendMode, setBlendMode } from "../../../packages/babylon-lite-gl/src/native/blend";
import { applyNativeStates } from "../../../packages/babylon-lite-gl/src/native/native-apply-states";
import { createGLEngine, disposeGLEngine, resizeGLEngine } from "../../../packages/babylon-lite-gl/src/index.native";

const VIEW = new Float32Array(16);
const PROJ = new Float32Array(16);

let mock: MockNative;
let engine: GLEngineContext;

/** Count how many times a command tag appears in the encoded stream. */
function commandCount(name: string): number {
    const tag = mock.tag(name);
    return mock.streamWords.reduce((acc, w) => acc + (w === tag ? 1 : 0), 0);
}

/**
 * Locate the Nth (0-based `occurrence`) emission of `name` in the encoded
 * stream and return its `argCount` trailing arguments reinterpreted as
 * float32 (via the index-aligned `streamFloats`, since the raw `streamWords`
 * are just the uint32 bit-pattern of whatever was written -- uint32, int32, OR
 * float32 args all share the one word stream). Throws if not found, so a
 * missing command fails loudly instead of silently reading `undefined`.
 */
function commandFloatArgs(name: string, argCount: number, occurrence = 0): number[] {
    const tag = mock.tag(name);
    let seen = -1;
    for (let i = 0; i < mock.streamWords.length; i++) {
        if (mock.streamWords[i] === tag) {
            seen++;
            if (seen === occurrence) {
                return mock.streamFloats.slice(i + 1, i + 1 + argCount);
            }
        }
    }
    throw new Error(`command ${name} occurrence ${occurrence} not found in the encoded stream`);
}

/** Same as {@link commandFloatArgs} but reads the raw uint32 words (for
 *  int32/uint32-typed command arguments). */
function commandUint32Args(name: string, argCount: number, occurrence = 0): number[] {
    const tag = mock.tag(name);
    let seen = -1;
    for (let i = 0; i < mock.streamWords.length; i++) {
        if (mock.streamWords[i] === tag) {
            seen++;
            if (seen === occurrence) {
                return mock.streamWords.slice(i + 1, i + 1 + argCount);
            }
        }
    }
    throw new Error(`command ${name} occurrence ${occurrence} not found in the encoded stream`);
}

beforeEach(() => {
    mock = createMockNative();
    mock.install();
    engine = createNativeGLEngine();
});

afterEach(() => {
    disposeNativeGLEngine(engine);
    mock.uninstall();
});

describe("native context", () => {
    it("constructs the native engine + installs the command stream", () => {
        expect(mock.count("new Engine")).toBe(1);
        expect(mock.count("setCommandDataStream")).toBe(1);
        expect(mock.count("setHardwareScalingLevel")).toBeGreaterThanOrEqual(1);
        expect(engine.caps.maxTextureSize).toBe(8192);
        expect(engine.caps.maxTextureUnits).toBe(16);
    });
});

describe("native effect-renderer", () => {
    it("compiles async, resolves locations, and emits SETPROGRAM + DRAWINDEXED", () => {
        const wrapper = createEffectWrapper(engine, {
            name: "test",
            fragmentSource: "#version 300 es\nprecision highp float;\nuniform vec4 uColor;\nout vec4 o;\nvoid main(){o=uColor;}",
            uniformNames: ["uColor"],
        });
        expect(mock.count("createProgramAsync")).toBe(1);

        // Not ready until the host fires the compile callback.
        expect(isEffectReady(wrapper.effect)).toBe(false);

        mock.fireProgramReady();
        expect(isEffectReady(wrapper.effect)).toBe(true);
        expect(mock.count("getUniforms")).toBe(1);
        expect(mock.count("getAttributes")).toBe(1);

        applyEffectWrapper(wrapper);
        // Quad is built once: 1 vertex buffer + 1 index buffer + 1 VAO + 1 record.
        expect(mock.count("createVertexBuffer")).toBe(1);
        expect(mock.count("createIndexBuffer")).toBe(1);
        expect(mock.count("createVertexArray")).toBe(1);
        expect(mock.count("recordVertexBuffer")).toBe(1);
        expect(mock.count("recordIndexBuffer")).toBe(1);

        drawEffect(engine);
        expect(commandCount("COMMAND_SETPROGRAM")).toBeGreaterThanOrEqual(1);
        expect(commandCount("COMMAND_DRAWINDEXED")).toBe(1);
    });

    it("caches the program bind across draws (SETPROGRAM once)", () => {
        const wrapper = createEffectWrapper(engine, { name: "t", fragmentSource: "#version 300 es\nout vec4 o;\nvoid main(){o=vec4(1.0);}" });
        mock.fireProgramReady();
        applyEffectWrapper(wrapper);
        drawEffect(engine);
        applyEffectWrapper(wrapper);
        drawEffect(engine);
        expect(commandCount("COMMAND_SETPROGRAM")).toBe(1);
        expect(commandCount("COMMAND_DRAWINDEXED")).toBe(2);
    });

    it("clears uniform value caches on device-restore (no stale elision)", () => {
        const wrapper = createEffectWrapper(engine, {
            name: "t",
            fragmentSource: "#version 300 es\nprecision highp float;\nuniform vec4 uColor;\nout vec4 o;\nvoid main(){o=uColor;}",
            uniformNames: ["uColor"],
        });
        mock.fireProgramReady();
        applyEffectWrapper(wrapper);
        setEffectFloat4(wrapper.effect, "uColor", 1, 0, 0, 1);
        const before = commandCount("COMMAND_SETFLOAT4");
        expect(before).toBe(1);

        // Device restore: the fresh native program's uniforms default to 0, and
        // the effect must re-link before it is ready again.
        mock.fireDeviceRestore();
        mock.fireProgramReady();
        applyEffectWrapper(wrapper);
        // Re-set the SAME value: it MUST re-emit (the value cache was cleared on
        // restore), otherwise the fresh program keeps its 0 default.
        setEffectFloat4(wrapper.effect, "uColor", 1, 0, 0, 1);
        expect(commandCount("COMMAND_SETFLOAT4")).toBe(before + 1);
    });
});

describe("native sprites", () => {
    it("records a 6-attribute VAO and emits matrices, texture, blend + draw", () => {
        const tex = createRawTexture(engine, new Uint8Array(4 * 4 * 4), 4, 4);
        const renderer = createSpriteRenderer(engine, { capacity: 4, texture: tex });
        // Sprite VAO records six vertex attributes (locations 0..5).
        expect(mock.count("recordVertexBuffer")).toBe(6);
        expect(mock.count("recordIndexBuffer")).toBe(1);

        mock.fireProgramReady();
        const sprites: GLSprite[] = [{ position: { x: 0, y: 0, z: 0 }, width: 1, height: 1, angle: 0 }];
        renderSprites(renderer, sprites, 16, VIEW, PROJ);

        expect(mock.count("updateDynamicVertexBuffer")).toBe(1);
        expect(commandCount("COMMAND_SETMATRICES")).toBe(2); // view + projection
        expect(commandCount("COMMAND_SETTEXTURE")).toBe(1);
        expect(commandCount("COMMAND_SETBLENDMODE")).toBeGreaterThanOrEqual(1);
        expect(commandCount("COMMAND_DRAWINDEXED")).toBe(1);
    });
});

describe("native state", () => {
    it("emits SETSCISSOR and caches the rectangle", () => {
        setScissor(engine, 1, 2, 3, 4);
        setScissor(engine, 1, 2, 3, 4);
        expect(commandCount("COMMAND_SETSCISSOR")).toBe(1);
    });

    it("emits CLEAR honouring the requested color", () => {
        clearEngine(engine, { color: { r: 1, g: 0, b: 0, a: 1 }, depth: true });
        expect(commandCount("COMMAND_CLEAR")).toBe(1);
    });

    it("flushes blend once and elides an unchanged mode", () => {
        setBlendMode(engine, GLBlendMode.ALPHA);
        applyNativeStates(engine);
        setBlendMode(engine, GLBlendMode.ALPHA);
        applyNativeStates(engine);
        expect(commandCount("COMMAND_SETBLENDMODE")).toBe(1);
    });
});

describe("native command-stream host ABI contract (_nativeDataStream unwrap)", () => {
    it("passes the JS NativeDataStream WRAPPER (not the raw native stream) to setCommandDataStream, exposing exactly `_nativeDataStream`", () => {
        // CommandBufferEncoder must call engine.setCommandDataStream(this._stream) -- the
        // wrapper -- and never engine.setCommandDataStream(this._stream._nativeDataStream)
        // -- the raw stream. The host unwraps by the exact property name `_nativeDataStream`
        // (NativeEngine.cpp Get("_nativeDataStream")), so passing the raw stream directly
        // would silently break on a real host (Get() on a raw stream returns undefined).
        const call = mock.calls.find((c) => c.name === "setCommandDataStream");
        expect(call, "setCommandDataStream must have been called during engine creation").toBeDefined();
        const wrapper = call!.args[0] as Record<string, unknown> | null;
        expect(wrapper, "the wrapper argument must not be null/undefined").not.toBeNull();
        expect(typeof wrapper).toBe("object");
        // The wrapper itself carries NO writeBuffer -- only its `_nativeDataStream`
        // property does. A regression that accidentally passes the raw stream would
        // make this assertion fail (the raw stream DOES have writeBuffer directly).
        expect(typeof wrapper!["writeBuffer"], "the WRAPPER must not itself expose writeBuffer").toBe("undefined");
        const unwrapped = wrapper!["_nativeDataStream"] as { writeBuffer?: unknown } | undefined;
        expect(unwrapped, "wrapper._nativeDataStream must be present (exact host ABI property name)").toBeDefined();
        expect(typeof unwrapped!.writeBuffer, "the unwrapped native stream must expose writeBuffer").toBe("function");
    });

    it("mock host rejects a wrapper missing _nativeDataStream instead of silently accepting it (guards the ABI contract itself)", () => {
        // Reach the raw mock engine directly (bypassing CommandBufferEncoder) to prove the
        // mock enforces the contract rather than rubber-stamping ANY argument -- this is
        // what would catch a production regression that swaps in the raw stream instead
        // of the wrapper.
        const rawEngine = engine._engine as unknown as { setCommandDataStream: (w: unknown) => void };
        expect(() => rawEngine.setCommandDataStream({})).toThrow(/_nativeDataStream/);
        expect(() => rawEngine.setCommandDataStream(null)).toThrow(/_nativeDataStream/);
        expect(() => rawEngine.setCommandDataStream(undefined)).toThrow(/_nativeDataStream/);
        // A raw stream-shaped object (has writeBuffer directly, like the unwrapped native
        // stream would) but with NO _nativeDataStream property must ALSO be rejected --
        // this is precisely the "pass the raw stream instead of the wrapper" regression
        // the ABI note in native-command-encoder.ts warns against.
        expect(() => rawEngine.setCommandDataStream({ writeBuffer: () => {} })).toThrow(/_nativeDataStream/);
    });

    it("mock host rejects submitCommands before a valid stream was installed (no silent no-op)", () => {
        const NativeCtor = (globalThis as unknown as { _native: { Engine: new (info: unknown) => { submitCommands: () => void } } })._native.Engine;
        const freshEngine = new NativeCtor({ version: "test", nonFloatVertexBuffers: true });
        expect(() => freshEngine.submitCommands()).toThrow(/setCommandDataStream/);
    });

    it("command encoding still flows end-to-end through the validated stream (regression: datastream wiring keeps working)", () => {
        // Sanity check that our stricter ABI enforcement did not break the actual data
        // path -- a scissor command (cheap, immediate, no async compile) must still
        // reach the encoded word stream.
        setScissor(engine, 5, 6, 7, 8);
        expect(commandCount("COMMAND_SETSCISSOR")).toBe(1);
    });
});

describe("native viewport normalization", () => {
    it("defaults an omitted viewport to the full normalized 0..1 render-target rect", () => {
        setViewport(engine);
        expect(commandCount("COMMAND_SETVIEWPORT")).toBe(1);
        const [x, y, w, h] = commandFloatArgs("COMMAND_SETVIEWPORT", 4);
        expect(x).toBe(0);
        expect(y).toBe(0);
        expect(w).toBe(1);
        expect(h).toBe(1);
    });

    it("normalizes an explicit pixel-rectangle viewport to 0..1 fractions of the render target (256x256 mock backbuffer)", () => {
        setViewport(engine, { x: 64, y: 32, w: 128, h: 96 });
        expect(commandCount("COMMAND_SETVIEWPORT")).toBe(1);
        const [x, y, w, h] = commandFloatArgs("COMMAND_SETVIEWPORT", 4);
        expect(x).toBeCloseTo(64 / 256, 6);
        expect(y).toBeCloseTo(32 / 256, 6);
        expect(w).toBeCloseTo(128 / 256, 6);
        expect(h).toBeCloseTo(96 / 256, 6);
    });

    it("elides a redundant SETVIEWPORT when the normalized rect is unchanged", () => {
        setViewport(engine, { x: 0, y: 0, w: 256, h: 256 });
        setViewport(engine, { x: 0, y: 0, w: 256, h: 256 });
        expect(commandCount("COMMAND_SETVIEWPORT")).toBe(1);
    });

    it("re-emits SETVIEWPORT when the normalized rect actually changes", () => {
        setViewport(engine, { x: 0, y: 0, w: 256, h: 256 });
        setViewport(engine, { x: 0, y: 0, w: 128, h: 128 });
        expect(commandCount("COMMAND_SETVIEWPORT")).toBe(2);
        const [, , w, h] = commandFloatArgs("COMMAND_SETVIEWPORT", 4, 1);
        expect(w).toBeCloseTo(0.5, 6);
        expect(h).toBeCloseTo(0.5, 6);
    });

    it("guards a zero-sized render target (would-be divide-by-zero) by normalizing against 1 instead of NaN/Infinity", () => {
        // Establish a non-zero cached viewport first (0,0,0,0 is the ENGINE's
        // initial default cache -- starting from there would let the zero-sized
        // case below get silently elided as "unchanged" rather than exercising
        // the x/rw divide-by-zero guard).
        setViewport(engine, { x: 10, y: 10, w: 50, h: 50 });
        expect(commandCount("COMMAND_SETVIEWPORT")).toBe(1);

        const rawEngine = engine._engine as unknown as { getRenderWidth: () => number; getRenderHeight: () => number };
        const originalWidth = rawEngine.getRenderWidth;
        const originalHeight = rawEngine.getRenderHeight;
        rawEngine.getRenderWidth = () => 0;
        rawEngine.getRenderHeight = () => 0;
        try {
            setViewport(engine, { x: 0, y: 0, w: 0, h: 0 });
            expect(commandCount("COMMAND_SETVIEWPORT")).toBe(2);
            const [x, y, w, h] = commandFloatArgs("COMMAND_SETVIEWPORT", 4, 1);
            for (const value of [x, y, w, h]) {
                expect(Number.isFinite(value), "expected a finite normalized coordinate, got " + value).toBe(true);
            }
        } finally {
            rawEngine.getRenderWidth = originalWidth;
            rawEngine.getRenderHeight = originalHeight;
        }
    });
});

describe("native default draw state (WebGL-equivalent, established at engine creation)", () => {
    it("establishes depth test/write OFF, cull OFF, RGBA write ON, blend OFF -- flushed on the first state application", () => {
        const NativeEngineStatics = (globalThis as unknown as { _native: { Engine: Record<string, number> } })._native.Engine;

        // Defaults are recorded as DESIRED at creation but are DEFERRED -- nothing is
        // flushed to the command stream until the next state-application point
        // (draw/clear/explicit flush). Confirm that quiescent state first:
        expect(commandCount("COMMAND_SETDEPTHTEST")).toBe(0);
        expect(commandCount("COMMAND_SETDEPTHWRITE")).toBe(0);
        expect(commandCount("COMMAND_SETSTATE")).toBe(0);
        expect(commandCount("COMMAND_SETCOLORWRITE")).toBe(0);
        expect(commandCount("COMMAND_SETBLENDMODE")).toBe(0);

        applyNativeStates(engine);

        expect(commandCount("COMMAND_SETDEPTHTEST")).toBe(1);
        expect(commandCount("COMMAND_SETDEPTHWRITE")).toBe(1);
        expect(commandCount("COMMAND_SETSTATE")).toBe(1);
        expect(commandCount("COMMAND_SETCOLORWRITE")).toBe(1);
        expect(commandCount("COMMAND_SETBLENDMODE")).toBe(1);

        // Depth test OFF: native conflates enable+func, so off encodes as ALWAYS.
        const [depthTestArg] = commandUint32Args("COMMAND_SETDEPTHTEST", 1);
        expect(depthTestArg).toBe(NativeEngineStatics.DEPTH_TEST_ALWAYS);

        // Depth write OFF.
        const [depthWriteArg] = commandUint32Args("COMMAND_SETDEPTHWRITE", 1);
        expect(depthWriteArg).toBe(0);

        // Cull OFF (COMMAND_SETSTATE args: enabled, offsetFactor, offsetUnits, cullBack, reserved).
        const cullArgs = commandUint32Args("COMMAND_SETSTATE", 5);
        expect(cullArgs[0], "cull must be disabled by default").toBe(0);

        // RGBA write ON (all four channels).
        const [colorWriteArg] = commandUint32Args("COMMAND_SETCOLORWRITE", 1);
        expect(colorWriteArg).toBe(1);

        // Blend OFF.
        const [blendArg] = commandUint32Args("COMMAND_SETBLENDMODE", 1);
        expect(blendArg).toBe(NativeEngineStatics.ALPHA_DISABLE);
    });

    it("re-establishes the identical default draw state after a device-restore (bgfx reset discards prior GPU state)", () => {
        const NativeEngineStatics = (globalThis as unknown as { _native: { Engine: Record<string, number> } })._native.Engine;
        applyNativeStates(engine);
        const before = {
            depthTest: commandCount("COMMAND_SETDEPTHTEST"),
            depthWrite: commandCount("COMMAND_SETDEPTHWRITE"),
            cull: commandCount("COMMAND_SETSTATE"),
            colorWrite: commandCount("COMMAND_SETCOLORWRITE"),
            blend: commandCount("COMMAND_SETBLENDMODE"),
        };

        mock.fireDeviceRestore();
        // The restore handler only records fresh DESIRED defaults and marks the state
        // dirty again; a consumer must flush before the next draw/clear.
        applyNativeStates(engine);

        expect(commandCount("COMMAND_SETDEPTHTEST")).toBe(before.depthTest + 1);
        expect(commandCount("COMMAND_SETDEPTHWRITE")).toBe(before.depthWrite + 1);
        expect(commandCount("COMMAND_SETSTATE")).toBe(before.cull + 1);
        expect(commandCount("COMMAND_SETCOLORWRITE")).toBe(before.colorWrite + 1);
        expect(commandCount("COMMAND_SETBLENDMODE")).toBe(before.blend + 1);

        // Counts alone are worthless here: the restore path must replay the SAME
        // WebGL-equivalent values, not merely emit five commands with bad state.
        expect(commandUint32Args("COMMAND_SETDEPTHTEST", 1, before.depthTest)).toEqual([NativeEngineStatics.DEPTH_TEST_ALWAYS]);
        expect(commandUint32Args("COMMAND_SETDEPTHWRITE", 1, before.depthWrite)).toEqual([0]);
        expect(commandUint32Args("COMMAND_SETSTATE", 5, before.cull)[0], "cull must remain disabled after restore").toBe(0);
        expect(commandUint32Args("COMMAND_SETCOLORWRITE", 1, before.colorWrite)).toEqual([1]);
        expect(commandUint32Args("COMMAND_SETBLENDMODE", 1, before.blend)).toEqual([NativeEngineStatics.ALPHA_DISABLE]);
    });
});

describe("native shader-name injection (#define SHADER_NAME)", () => {
    function lastCompiledSources(): { vs: string; fs: string } {
        const call = mock.calls.filter((c) => c.name === "createProgramAsync").at(-1);
        expect(call, "createProgramAsync must have been called").toBeDefined();
        const [vs, fs] = call!.args as [string, string];
        return { vs, fs };
    }

    it("injects #define SHADER_NAME <safeName> immediately after #version, before main, in both stages", () => {
        createEffectWrapper(engine, {
            name: "My Effect!42",
            vertexSource: "#version 300 es\nlayout(location = 0) in vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }",
            fragmentSource: "#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main(){o=vec4(1.0);}",
        });
        const { vs, fs } = lastCompiledSources();
        const expectedDefine = "#define SHADER_NAME My_Effect_42";
        for (const src of [vs, fs]) {
            const lines = src.split("\n");
            expect(lines[0], "line 0 must stay #version (it must remain the first line)").toBe("#version 300 es");
            expect(lines[1], "the SHADER_NAME define must be inserted immediately after #version").toBe(expectedDefine);
            const defineIdx = src.indexOf(expectedDefine);
            const mainIdx = src.indexOf("void main");
            expect(defineIdx).toBeGreaterThan(-1);
            expect(defineIdx, "the define must sit before main").toBeLessThan(mainIdx);
        }
    });

    it("injects SHADER_NAME correctly into minified single-line GLSL in both stages (whole body on one line after #version)", () => {
        const minifiedVertex = "#version 300 es\nlayout(location=0)in vec2 position;void main(){gl_Position=vec4(position,0.,1.);}";
        const minifiedFrag = "#version 300 es\nprecision highp float;out vec4 o;void main(){o=vec4(1.0);}";
        createEffectWrapper(engine, { name: "min", vertexSource: minifiedVertex, fragmentSource: minifiedFrag });
        const { vs, fs } = lastCompiledSources();
        for (const src of [vs, fs]) {
            expect(src.startsWith("#version 300 es\n#define SHADER_NAME min\n")).toBe(true);
            expect(src.indexOf("#define SHADER_NAME min"), "define must land before main even when the body is minified onto one line").toBeLessThan(src.indexOf("void main"));
        }
    });

    it("does not duplicate #define SHADER_NAME when either shader stage already declares one", () => {
        const customVertex = "#version 300 es\n#define SHADER_NAME VertexAlreadyThere\nlayout(location=0)in vec2 position;void main(){gl_Position=vec4(position,0.,1.);}";
        const customFragment = "#version 300 es\n#define SHADER_NAME FragmentAlreadyThere\nprecision highp float;out vec4 o;void main(){o=vec4(1.0);}";
        createEffectWrapper(engine, { name: "should-not-appear", vertexSource: customVertex, fragmentSource: customFragment });
        const { vs, fs } = lastCompiledSources();
        for (const [src, existingName] of [
            [vs, "VertexAlreadyThere"],
            [fs, "FragmentAlreadyThere"],
        ] as const) {
            const occurrences = src.split("#define SHADER_NAME").length - 1;
            expect(occurrences, "no-op path must not add a second define").toBe(1);
            expect(src).toContain(`#define SHADER_NAME ${existingName}`);
            expect(src).not.toContain("should_not_appear");
        }
    });

    it("sanitizes non [A-Za-z0-9_] characters in the effect name to underscores", () => {
        createEffectWrapper(engine, { name: "fx.name/weird 99", fragmentSource: "#version 300 es\nout vec4 o;\nvoid main(){o=vec4(1.0);}" });
        const { fs } = lastCompiledSources();
        expect(fs).toContain("#define SHADER_NAME fx_name_weird_99");
    });

    it("replaces each disallowed character with an underscore (not a single collapsed one) for a punctuation-only name", () => {
        // "!!!".replace(/[^A-Za-z0-9_]/g, "_") is "___" (three underscores) --
        // NOT the "effect" fallback, since the sanitized id is non-empty.
        createEffectWrapper(engine, { name: "!!!", fragmentSource: "#version 300 es\nout vec4 o;\nvoid main(){o=vec4(1.0);}" });
        const { fs } = lastCompiledSources();
        expect(fs).toContain("#define SHADER_NAME ___");
    });

    it("falls back to a safe default id when the name itself is empty (sanitizes to an empty string)", () => {
        createEffectWrapper(engine, { name: "", fragmentSource: "#version 300 es\nout vec4 o;\nvoid main(){o=vec4(1.0);}" });
        const { fs } = lastCompiledSources();
        expect(fs).toContain("#define SHADER_NAME effect");
    });
});

describe("native context canvas contract", () => {
    it("exposes canvas: null -- no HTML canvas backs a Babylon Native device", () => {
        expect(engine.canvas).toBeNull();
    });
});

describe("native barrel WebGL-compat lifecycle aliases (createGLEngine/disposeGLEngine/resizeGLEngine)", () => {
    it("createGLEngine ignores any canvas argument and bridges to createNativeGLEngine; disposeGLEngine is idempotent; resizeGLEngine is a true no-op", () => {
        const enginesBefore = mock.count("new Engine");
        // Pass a canvas-shaped value: the alias must ignore it (native has no canvas).
        const aliasEngine = createGLEngine({ nodeName: "CANVAS" } as unknown as never, {});
        expect(mock.count("new Engine")).toBe(enginesBefore + 1);
        expect(aliasEngine.canvas).toBeNull();

        // resizeGLEngine is documented as host-managed: it must not record any native
        // engine call (a regression that wired it to something would show up as extra calls).
        const callsBefore = mock.calls.length;
        resizeGLEngine(aliasEngine);
        expect(mock.calls.length, "resizeGLEngine must not touch the native engine").toBe(callsBefore);

        const disposesBefore = mock.count("dispose");
        disposeGLEngine(aliasEngine);
        expect(mock.count("dispose"), "first disposeGLEngine call must dispose the native engine exactly once").toBe(disposesBefore + 1);
        // Idempotent means more than "does not throw": it must not dispose the host twice.
        expect(() => disposeGLEngine(aliasEngine)).not.toThrow();
        expect(mock.count("dispose"), "second disposeGLEngine call must be a no-op").toBe(disposesBefore + 1);
    });
});
