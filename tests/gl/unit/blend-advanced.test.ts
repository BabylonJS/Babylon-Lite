import { describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import { GLBlendEquation, GLBlendMode, setBlendMode, setBlendState, disableBlend } from "../../../packages/babylon-lite-gl/src/blend";
import { applyGLStates } from "../../../packages/babylon-lite-gl/src/apply-states";
import { setScissor, disableScissor } from "../../../packages/babylon-lite-gl/src/scissor";
import { createMockCanvas, createMockGL, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl setBlendState: multi-equation separate blend", () => {
    it("enables BLEND and issues equation + func (darken: MIN / FUNC_ADD)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, {
            srcRGB: gl.ONE,
            dstRGB: gl.ONE,
            srcAlpha: gl.ZERO,
            dstAlpha: gl.ONE,
            equationRGB: GLBlendEquation.MIN,
            equationAlpha: GLBlendEquation.ADD,
        });
        applyGLStates(engine);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.BLEND]);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.MIN, gl.FUNC_ADD]);
        expect(callsNamed(mock, "blendFuncSeparate")[0]?.args).toEqual([gl.ONE, gl.ONE, gl.ZERO, gl.ONE]);
    });

    it("cutout (FUNC_REVERSE_SUBTRACT) round-trips the equation", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, {
            srcRGB: gl.ONE,
            dstRGB: gl.ONE,
            srcAlpha: gl.ONE,
            dstAlpha: gl.ONE,
            equationRGB: GLBlendEquation.REVERSE_SUBTRACT,
            equationAlpha: GLBlendEquation.REVERSE_SUBTRACT,
        });
        applyGLStates(engine);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT]);
    });

    it("defaults the equation to FUNC_ADD when omitted", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, { srcRGB: gl.DST_COLOR, dstRGB: gl.ZERO, srcAlpha: gl.ZERO, dstAlpha: gl.ONE });
        applyGLStates(engine);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.FUNC_ADD, gl.FUNC_ADD]);
    });

    it("re-issues only the func when the equation is unchanged", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE });
        applyGLStates(engine);
        mock.clear();
        setBlendState(engine, { srcRGB: gl.SRC_ALPHA, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE });
        applyGLStates(engine);
        expect(callsNamed(mock, "blendEquationSeparate")).toHaveLength(0);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(1);
    });

    it("re-issues only the equation when the func is unchanged", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE });
        applyGLStates(engine);
        mock.clear();
        setBlendState(engine, { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE, equationRGB: GLBlendEquation.MAX });
        applyGLStates(engine);
        expect(callsNamed(mock, "blendFuncSeparate")).toHaveLength(0);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.MAX, gl.FUNC_ADD]);
    });

    it("fully elides a repeated identical state", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        const st = { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE, equationRGB: GLBlendEquation.MIN, equationAlpha: GLBlendEquation.ADD };
        setBlendState(engine, st);
        applyGLStates(engine);
        mock.clear();
        setBlendState(engine, st);
        applyGLStates(engine);
        expect(mock.log).toHaveLength(0);
    });
});

describe("lite-gl blend: preset + custom interop", () => {
    it("a preset after a custom state re-issues correctly (shared cache)", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE, equationRGB: GLBlendEquation.MIN, equationAlpha: GLBlendEquation.MIN });
        applyGLStates(engine);
        mock.clear();
        // ALPHA preset uses FUNC_ADD + (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE).
        setBlendMode(engine, GLBlendMode.ALPHA);
        applyGLStates(engine);
        expect(callsNamed(mock, "blendEquationSeparate")[0]?.args).toEqual([gl.FUNC_ADD, gl.FUNC_ADD]);
        expect(callsNamed(mock, "blendFuncSeparate")[0]?.args).toEqual([gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE]);
    });

    it("disableBlend after setBlendState issues gl.disable(BLEND) once", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setBlendState(engine, { srcRGB: gl.ONE, dstRGB: gl.ONE, srcAlpha: gl.ONE, dstAlpha: gl.ONE });
        applyGLStates(engine);
        mock.clear();
        disableBlend(engine);
        applyGLStates(engine);
        expect(callsNamed(mock, "disable")[0]?.args).toEqual([gl.BLEND]);
        disableBlend(engine);
        applyGLStates(engine);
        expect(callsNamed(mock, "disable")).toHaveLength(1);
    });
});

describe("lite-gl scissor", () => {
    it("enables SCISSOR_TEST + sets the rect, cached", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setScissor(engine, 10, 20, 30, 40);
        expect(callsNamed(mock, "enable")[0]?.args).toEqual([gl.SCISSOR_TEST]);
        expect(callsNamed(mock, "scissor")[0]?.args).toEqual([10, 20, 30, 40]);
        mock.clear();
        setScissor(engine, 10, 20, 30, 40);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "scissor")).toHaveLength(0);
    });

    it("updates only the rect when already enabled", () => {
        const { mock, engine } = makeEngine();
        setScissor(engine, 0, 0, 8, 8);
        mock.clear();
        setScissor(engine, 1, 2, 3, 4);
        expect(callsNamed(mock, "enable")).toHaveLength(0);
        expect(callsNamed(mock, "scissor")[0]?.args).toEqual([1, 2, 3, 4]);
    });

    it("disableScissor issues disable once", () => {
        const { mock, engine } = makeEngine();
        const gl = engine.gl;
        setScissor(engine, 0, 0, 8, 8);
        mock.clear();
        disableScissor(engine);
        expect(callsNamed(mock, "disable")[0]?.args).toEqual([gl.SCISSOR_TEST]);
        disableScissor(engine);
        expect(callsNamed(mock, "disable")).toHaveLength(1);
    });
});
