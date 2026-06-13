import { describe, expect, it, vi } from "vitest";
import {
    applyEffectWrapper,
    bindTexture,
    createEffect,
    createEffectWrapper,
    createRawTexture,
    createGLEngine,
    disposeEffectWrapper,
    disposeTexture,
    disposeGLEngine,
    drawEffect,
    executeWhenCompiled,
    isEffectReady,
    offContextLost,
    offContextRestored,
    onContextLost,
    onContextRestored,
    setEffectFloat,
    setEffectFloat2,
    setEffectTexture,
    setViewport,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

const VS = "#version 300 es\nin vec2 position;\nvoid main(){ gl_Position = vec4(position,0.0,1.0); }";
const FS = "#version 300 es\nprecision highp float;\nout vec4 glFragColor;\nvoid main(){ glFragColor = vec4(1.0); }";

function makeReadyEffect() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.setParallelComplete(true);
    const effect = createEffect(engine, {
        name: "test",
        vertexSource: VS,
        fragmentSource: FS,
        uniformNames: ["u_a", "u_b"],
        samplerNames: ["s0", "s1"],
    });
    // Drive finalization
    expect(isEffectReady(engine, effect)).toBe(true);
    return { mock, canvas, engine, effect };
}

describe("lite-gl context: lost/restored callbacks", () => {
    function makeEngine() {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        return { mock, canvas, engine };
    }

    it("fires onContextLost on loss and onContextRestored on restore", () => {
        const { canvas, engine } = makeEngine();
        let lost = 0;
        let restored = 0;
        onContextLost(engine, () => lost++);
        onContextRestored(engine, () => restored++);

        fireLost(canvas);
        expect(lost).toBe(1);
        expect(restored).toBe(0);

        fireRestored(canvas);
        expect(restored).toBe(1);
    });

    it("ignores duplicate registrations (fires once per event)", () => {
        const { canvas, engine } = makeEngine();
        let n = 0;
        const cb = () => n++;
        onContextLost(engine, cb);
        onContextLost(engine, cb); // duplicate — must be ignored
        fireLost(canvas);
        expect(n).toBe(1);
    });

    it("offContextLost / offContextRestored remove the callback", () => {
        const { canvas, engine } = makeEngine();
        let lost = 0;
        let restored = 0;
        const lostCb = () => lost++;
        const restoredCb = () => restored++;
        onContextLost(engine, lostCb);
        onContextRestored(engine, restoredCb);
        offContextLost(engine, lostCb);
        offContextRestored(engine, restoredCb);

        fireLost(canvas);
        fireRestored(canvas);
        expect(lost).toBe(0);
        expect(restored).toBe(0);
    });

    it("fires context-lost callbacks in registration order", () => {
        const { canvas, engine } = makeEngine();
        const order: number[] = [];
        onContextLost(engine, () => order.push(1));
        onContextLost(engine, () => order.push(2));
        onContextLost(engine, () => order.push(3));
        fireLost(canvas);
        expect(order).toEqual([1, 2, 3]);
    });

    it("a throwing callback does not prevent later callbacks", () => {
        const { canvas, engine } = makeEngine();
        let reached = false;
        onContextLost(engine, () => {
            throw new Error("boom");
        });
        onContextLost(engine, () => {
            reached = true;
        });
        // The handler wraps each callback in try/catch and logs the error.
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        fireLost(canvas);
        spy.mockRestore();
        expect(reached).toBe(true);
    });
});

describe("lite-gl cache: uniform setters", () => {
    it("setEffectFloat elides repeat calls with identical value", () => {
        const { mock, engine, effect } = makeReadyEffect();
        mock.clear();
        setEffectFloat(engine, effect, "u_a", 0.5);
        setEffectFloat(engine, effect, "u_a", 0.5);
        setEffectFloat(engine, effect, "u_a", 0.5);
        expect(mock.count("uniform1f")).toBe(1);
    });

    it("setEffectFloat re-uploads when value changes", () => {
        const { mock, engine, effect } = makeReadyEffect();
        mock.clear();
        setEffectFloat(engine, effect, "u_a", 0.5);
        setEffectFloat(engine, effect, "u_a", 0.6);
        setEffectFloat(engine, effect, "u_a", 0.5);
        expect(mock.count("uniform1f")).toBe(3);
    });

    it("setEffectFloat with NaN re-uploads every call (NaN !== NaN)", () => {
        const { mock, engine, effect } = makeReadyEffect();
        mock.clear();
        setEffectFloat(engine, effect, "u_a", Number.NaN);
        setEffectFloat(engine, effect, "u_a", Number.NaN);
        expect(mock.count("uniform1f")).toBe(2);
    });

    it("setEffectFloat2 with 0.1 compares equal across frames (number[] not Float32Array)", () => {
        const { mock, engine, effect } = makeReadyEffect();
        mock.clear();
        setEffectFloat2(engine, effect, "u_a", 0.1, 0.2);
        setEffectFloat2(engine, effect, "u_a", 0.1, 0.2);
        setEffectFloat2(engine, effect, "u_a", 0.1, 0.2);
        expect(mock.count("uniform2f")).toBe(1);
    });

    it("setEffectFloat to an unknown uniform is a silent no-op", () => {
        const { mock, engine, effect } = makeReadyEffect();
        mock.clear();
        setEffectFloat(engine, effect, "__missing_x", 1.0);
        expect(mock.count("uniform1f")).toBe(0);
    });

    it("setEffectFloat before isReady is a no-op AND does NOT poison the cache", () => {
        const mock = createMockGL();
        mock.setParallelComplete(false);
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        const effect = createEffect(engine, {
            name: "test",
            vertexSource: VS,
            fragmentSource: FS,
            uniformNames: ["u_a"],
            samplerNames: [],
        });
        // not ready yet
        setEffectFloat(engine, effect, "u_a", 1.0);
        expect(mock.count("uniform1f")).toBe(0);
        // becomes ready
        mock.setParallelComplete(true);
        expect(isEffectReady(engine, effect)).toBe(true);
        mock.clear();
        // The first real call after readiness MUST upload even with the same value
        setEffectFloat(engine, effect, "u_a", 1.0);
        expect(mock.count("uniform1f")).toBe(1);
    });
});

describe("lite-gl cache: textures + samplers", () => {
    it("sampler uniforms assigned exactly once at finalization (not per setEffectTexture call)", () => {
        const { mock, engine, effect } = makeReadyEffect();
        // After finalization, there should be exactly 2 uniform1i calls — one per sampler.
        expect(mock.count("uniform1i")).toBe(2);
        mock.clear();
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        // Repeated setEffectTexture calls must NEVER re-issue uniform1i
        for (let i = 0; i < 50; i++) {
            setEffectTexture(engine, effect, "s0", tex);
        }
        expect(mock.count("uniform1i")).toBe(0);
    });

    it("bindTexture elides when same texture is already bound on the unit", () => {
        const { mock, engine } = makeReadyEffect();
        const tex = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        mock.clear();
        bindTexture(engine, 0, tex);
        bindTexture(engine, 0, tex);
        bindTexture(engine, 0, tex);
        expect(mock.count("bindTexture")).toBe(0);
        expect(mock.count("activeTexture")).toBe(0);
    });

    it("bindTexture switches handle on same unit (no extra activeTexture)", () => {
        const { mock, engine } = makeReadyEffect();
        const a = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const b = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        // Park unit 0 on `a`
        bindTexture(engine, 0, a);
        mock.clear();
        bindTexture(engine, 0, b);
        expect(mock.count("bindTexture")).toBe(1);
        expect(mock.count("activeTexture")).toBe(0); // unit already 0
    });

    it("disposeTexture clears _state.boundTextures (next bind to same unit is NOT elided)", () => {
        const { mock, engine } = makeReadyEffect();
        const a = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const b = createRawTexture(engine, new Uint8Array(4), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        bindTexture(engine, 0, a);
        disposeTexture(engine, a);
        mock.clear();
        bindTexture(engine, 0, b);
        expect(mock.count("bindTexture")).toBe(1);
    });
});

describe("lite-gl cache: program + viewport + quad", () => {
    it("setViewport elides identical rectangles", () => {
        const { mock, engine } = makeReadyEffect();
        mock.clear();
        setViewport(engine, { x: 0, y: 0, w: 64, h: 48 });
        setViewport(engine, { x: 0, y: 0, w: 64, h: 48 });
        setViewport(engine, { x: 0, y: 0, w: 64, h: 48 });
        expect(mock.count("viewport")).toBe(1);
    });

    it("applyEffectWrapper builds the quad exactly once", () => {
        const { mock, engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        mock.clear();
        applyEffectWrapper(wrapper);
        applyEffectWrapper(wrapper);
        applyEffectWrapper(wrapper);
        // Quad VAO created on the first call only.
        expect(mock.count("createVertexArray")).toBe(1);
        // The wrapper's program is bound once, then cached.
        expect(mock.count("useProgram")).toBe(1);
    });

    it("useProgram is cached — same program swap is a no-op", () => {
        const { mock, engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        applyEffectWrapper(wrapper);
        mock.clear();
        applyEffectWrapper(wrapper);
        expect(mock.count("useProgram")).toBe(0);
    });
});

describe("lite-gl: executeWhenCompiled", () => {
    it("fires synchronously when already ready", () => {
        const { engine, effect } = makeReadyEffect();
        let fired = 0;
        executeWhenCompiled(engine, effect, () => {
            fired++;
        });
        expect(fired).toBe(1);
    });

    it("fires exactly once on first transition to ready", () => {
        const mock = createMockGL();
        mock.setParallelComplete(false);
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        const effect = createEffect(engine, {
            name: "test",
            vertexSource: VS,
            fragmentSource: FS,
            uniformNames: [],
            samplerNames: [],
        });
        let fired = 0;
        executeWhenCompiled(engine, effect, () => {
            fired++;
        });
        // Not ready yet — callback queued, not fired
        expect(fired).toBe(0);
        // Still not ready after polling
        expect(isEffectReady(engine, effect)).toBe(false);
        expect(fired).toBe(0);
        // Flip ready
        mock.setParallelComplete(true);
        expect(isEffectReady(engine, effect)).toBe(true);
        expect(fired).toBe(1);
        // Subsequent polls don't re-fire
        expect(isEffectReady(engine, effect)).toBe(true);
        expect(fired).toBe(1);
    });
});

describe("lite-gl: disposal", () => {
    it("disposeGLEngine makes later setters no-ops without throwing", () => {
        const { mock, engine, effect } = makeReadyEffect();
        disposeGLEngine(engine);
        mock.clear();
        expect(() => setEffectFloat(engine, effect, "u_a", 1.0)).not.toThrow();
        expect(() => drawEffect(engine)).not.toThrow();
        expect(mock.count("uniform1f")).toBe(0);
        expect(mock.count("drawElements")).toBe(0);
    });
});

describe("lite-gl: context loss / restore", () => {
    it("context lost → setters become no-ops and do not poison the cache", () => {
        const { mock, canvas, engine, effect } = makeReadyEffect();
        // First, prove the value cache is poppulated.
        setEffectFloat(engine, effect, "u_a", 0.5);
        mock.clear();
        fireLost(canvas);
        expect(engine._isLost).toBe(true);
        setEffectFloat(engine, effect, "u_a", 0.7);
        expect(mock.count("uniform1f")).toBe(0);
        // Effect should have been marked not-ready
        expect(effect.isReady).toBe(false);
    });

    it("context restored → quad VAO rebuilt and samplers re-bound exactly once each", () => {
        const mock = createMockGL();
        const canvas = createMockCanvas(mock);
        const engine = createGLEngine(canvas);
        mock.setParallelComplete(true);
        const wrapper = createEffectWrapper(engine, {
            name: "w",
            fragmentSource: FS,
            uniformNames: ["u_a", "u_b"],
            samplerNames: ["s0", "s1"],
        });
        expect(isEffectReady(engine, wrapper.effect)).toBe(true);
        applyEffectWrapper(wrapper);
        const vaosBefore = mock.count("createVertexArray");
        fireLost(canvas);
        fireRestored(canvas);
        mock.clear();
        // Restart the cycle
        expect(isEffectReady(engine, wrapper.effect)).toBe(true);
        applyEffectWrapper(wrapper);
        const vaosAfter = vaosBefore + mock.count("createVertexArray");
        expect(vaosAfter).toBe(vaosBefore + 1); // exactly one new VAO
        // sampler1i should have been re-issued exactly once per declared sampler
        expect(mock.count("uniform1i")).toBe(2);
    });

    it("context restored → raw texture upload replayed via _upload closure", () => {
        const { mock, canvas, engine } = makeReadyEffect();
        const tex = createRawTexture(engine, new Uint8Array([255, 0, 0, 255]), 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE);
        const handleBefore = tex.handle;
        fireLost(canvas);
        mock.clear();
        fireRestored(canvas);
        // texImage2D should have been replayed
        expect(mock.count("texImage2D")).toBeGreaterThan(0);
        // The handle is a fresh WebGLTexture — same reference IS allowed if the
        // mock returns identical objects, but the new texture has been registered.
        expect(tex.handle).not.toBe(handleBefore);
        expect(tex.isReady).toBe(true);
    });
});

describe("lite-gl: effect wrapper ownership", () => {
    it("disposeEffectWrapper disposes the effect the wrapper owns", () => {
        const { mock, engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        mock.clear();
        disposeEffectWrapper(wrapper);
        expect(mock.count("deleteProgram")).toBe(1);
        expect(wrapper.effect._disposed).toBe(true);
    });

    it("disposeEffectWrapper is idempotent", () => {
        const { mock, engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        mock.clear();
        disposeEffectWrapper(wrapper);
        disposeEffectWrapper(wrapper);
        disposeEffectWrapper(wrapper);
        expect(mock.count("deleteProgram")).toBe(1);
    });

    it("applyEffectWrapper is a no-op after the wrapper is disposed", () => {
        const { mock, engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        disposeEffectWrapper(wrapper);
        mock.clear();
        applyEffectWrapper(wrapper);
        expect(mock.count("createVertexArray")).toBe(0);
        expect(mock.count("useProgram")).toBe(0);
    });

    it("createEffectWrapper defaults to the built-in fullscreen vertex shader", () => {
        const { engine } = makeReadyEffect();
        const wrapper = createEffectWrapper(engine, { name: "w", fragmentSource: FS });
        expect(wrapper.effect.options.vertexSource).toContain("gl_Position");
        expect(wrapper.effect.options.vertexSource).toContain("vUv");
    });
});
