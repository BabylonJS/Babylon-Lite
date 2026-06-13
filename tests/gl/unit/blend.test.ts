import { describe, expect, it } from "vitest";
import { GLBlendMode, createGLEngine, disposeGLEngine, setBlendMode } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

/** All recorded calls with the given name, in order. */
function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl blend: exact GL calls per mode (matches Babylon setAlphaMode)", () => {
    it("DISABLE issues gl.disable(BLEND) and no func/equation", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.DISABLE);
        const dc = callsNamed(mock, "disable");
        expect(dc).toHaveLength(1);
        expect(dc[0]?.args).toEqual([gl.BLEND]);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(0);
        expect(callsNamed(mock, "blendEquationSeparate")).toHaveLength(0);
    });

    it("ADD enables BLEND, pins FUNC_ADD, and uses (SRC_ALPHA, ONE, ZERO, ONE)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.ADD);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.BLEND]);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.FUNC_ADD, gl.FUNC_ADD]);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE]);
    });

    it("ALPHA (COMBINE) uses (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.ALPHA);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.BLEND]);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE]);
    });

    it("PREMULTIPLIED uses (ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.PREMULTIPLIED);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.BLEND]);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE]);
    });
});

describe("lite-gl blend: cache elision", () => {
    it("repeating the same enabled mode is fully elided", () => {
        const { mock, engine } = makeEngine();
        setBlendMode(engine, GLBlendMode.ALPHA);
        mock.clear();
        setBlendMode(engine, GLBlendMode.ALPHA);
        setBlendMode(engine, GLBlendMode.ALPHA);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(0);
        expect(callsNamed(mock, "blendEquationSeparate")).toHaveLength(0);
    });

    it("repeating DISABLE is elided after the first call", () => {
        const { mock, engine } = makeEngine();
        setBlendMode(engine, GLBlendMode.DISABLE);
        mock.clear();
        setBlendMode(engine, GLBlendMode.DISABLE);
        setBlendMode(engine, GLBlendMode.DISABLE);
        expect(callsNamed(mock, "disable")).toHaveLength(0);
    });

    it("switching between two enabled modes only re-issues blendFuncSeparate (no re-enable)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.ALPHA);
        mock.clear();
        setBlendMode(engine, GLBlendMode.ADD);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "blendEquationSeparate")).toHaveLength(0);
        const fc = callsNamed(mock, "blendFuncSeparate");
        expect(fc).toHaveLength(1);
        expect(fc[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE]);
    });

    it("re-enabling after DISABLE issues enable + equation again", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendMode(engine, GLBlendMode.ALPHA);
        setBlendMode(engine, GLBlendMode.DISABLE);
        mock.clear();
        setBlendMode(engine, GLBlendMode.ALPHA);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.BLEND]);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.FUNC_ADD, gl.FUNC_ADD]);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(1);
    });
});

describe("lite-gl blend: lost / disposed safety", () => {
    it("setBlendMode is a no-op on a lost context and does not throw", () => {
        const { mock, canvas, engine } = makeEngine();
        fireLost(canvas);
        expect(engine._isLost).toBe(true);
        mock.clear();
        expect(() => setBlendMode(engine, GLBlendMode.ALPHA)).not.toThrow();
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "disable")).toHaveLength(0);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(0);
    });

    it("setBlendMode is a no-op after the engine is disposed", () => {
        const { mock, engine } = makeEngine();
        disposeGLEngine(engine);
        mock.clear();
        expect(() => setBlendMode(engine, GLBlendMode.PREMULTIPLIED)).not.toThrow();
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(0);
    });
});
