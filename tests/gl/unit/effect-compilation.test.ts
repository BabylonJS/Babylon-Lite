import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createEffect,
    createGLEngine,
    disposeEffect,
    executeWhenCompiled,
    getEffectCompilationError,
    isEffectReady,
    type GLEffectOptions,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

const OPTIONS: GLEffectOptions = {
    name: "compilation-test",
    vertexSource: "#version 300 es\nin vec2 position;\nvoid main(){gl_Position=vec4(position,0.,1.);}",
    fragmentSource: "#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main(){color=vec4(1.);}",
    uniformNames: ["u_value"],
    samplerNames: ["u_texture"],
};

function setup(parallel = true) {
    const mock = createMockGL();
    mock.setParallelAvailable(parallel);
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("lite-gl: non-blocking effect compilation", () => {
    it("submits both shaders and links before querying any compilation results", () => {
        const { mock, engine } = setup();
        mock.setParallelComplete(false);
        const effect = createEffect(engine, OPTIONS);
        expect(mock.count("compileShader")).toBe(2);
        expect(mock.count("linkProgram")).toBe(1);
        expect(mock.count("getShaderParameter")).toBe(0);
        expect(mock.count("getProgramParameter")).toBe(0);
        expect(mock.count("getShaderInfoLog")).toBe(0);
        expect(effect.isReady).toBe(false);
        mock.clear();
        expect(isEffectReady(engine, effect)).toBe(false);
        expect(mock.log).toEqual([{ name: "getProgramParameter", args: [effect.program, engine.caps.parallelShaderCompile!.COMPLETION_STATUS_KHR] }]);
        expect(getEffectCompilationError(engine, effect)).toBeNull();
        expect(mock.count("getShaderParameter")).toBe(0);
    });

    it.each([true, false])("never queries shader status after successful linking (parallel=%s)", (parallel) => {
        const { mock, engine } = setup(parallel);
        const effect = createEffect(engine, OPTIONS);
        mock.clear();
        expect(isEffectReady(engine, effect)).toBe(true);
        expect(mock.log.filter((call) => call.name === "getProgramParameter").map((call) => call.args[1])).toEqual(
            parallel ? [engine.caps.parallelShaderCompile!.COMPLETION_STATUS_KHR, engine.gl.LINK_STATUS] : [engine.gl.LINK_STATUS]
        );
        expect(mock.count("getShaderParameter")).toBe(0);
        expect(mock.count("getShaderInfoLog")).toBe(0);
        expect(mock.count("getProgramInfoLog")).toBe(0);
        expect(mock.count("uniform1i")).toBe(1);
        mock.clear();
        expect(getEffectCompilationError(engine, effect)).toBeNull();
        expect(isEffectReady(engine, effect)).toBe(true);
        expect(mock.log).toEqual([]);
    });

    it.each([true, false])("exposes deferred shader errors with stage and program logs (parallel=%s)", (parallel) => {
        const { mock, engine } = setup(parallel);
        mock.setCompileSuccess(false);
        mock.setParallelComplete(false);
        const effect = createEffect(engine, OPTIONS);
        const compiled = vi.fn();
        executeWhenCompiled(engine, effect, compiled);
        if (parallel) {
            expect(getEffectCompilationError(engine, effect)).toBeNull();
            expect(mock.count("getShaderParameter")).toBe(0);
        }
        mock.setParallelComplete(true);
        const error = getEffectCompilationError(engine, effect);
        expect(error).toContain("link failed: mock link error");
        expect(error).toContain("vertex compile failed: mock compile error");
        expect(error).toContain("fragment compile failed: mock compile error");
        expect(effect.isReady).toBe(false);
        expect(compiled).not.toHaveBeenCalled();
        expect(mock.count("getShaderParameter")).toBe(2);
        expect(mock.count("uniform1i")).toBe(0);
        expect(console.error).toHaveBeenCalledTimes(1);
        mock.clear();
        expect(getEffectCompilationError(engine, effect)).toBe(error);
        expect(isEffectReady(engine, effect)).toBe(false);
        expect(mock.log).toEqual([]);
        expect(console.error).toHaveBeenCalledTimes(1);
        disposeEffect(engine, effect);
        expect(getEffectCompilationError(engine, effect)).toBe(error);
    });

    it("collects info logs only for failed shader stages", () => {
        const { mock, engine } = setup();
        mock.setLinkSuccess(false);
        const effect = createEffect(engine, OPTIONS);
        vi.spyOn(engine.gl, "getShaderParameter").mockImplementation((shader) => shader !== effect._fs);
        const shaderLog = vi.spyOn(engine.gl, "getShaderInfoLog").mockReturnValue("fragment syntax error");
        expect(getEffectCompilationError(engine, effect)).toBe("link failed: mock link error\nfragment compile failed: fragment syntax error");
        expect(shaderLog).toHaveBeenCalledExactlyOnceWith(effect._fs);
    });

    it("reports a pure link error without fetching successful shaders' logs", () => {
        const { mock, engine } = setup();
        mock.setLinkSuccess(false);
        const effect = createEffect(engine, OPTIONS);
        expect(getEffectCompilationError(engine, effect)).toBe("link failed: mock link error");
        expect(mock.count("getShaderParameter")).toBe(2);
        expect(mock.count("getShaderInfoLog")).toBe(0);
    });

    it.each(["", null])("supplies non-empty diagnostics for missing info logs (%s)", (log) => {
        const { mock, engine } = setup();
        mock.setCompileSuccess(false);
        const effect = createEffect(engine, OPTIONS);
        vi.spyOn(engine.gl, "getProgramInfoLog").mockReturnValue(log);
        vi.spyOn(engine.gl, "getShaderInfoLog").mockReturnValue(log);
        expect(getEffectCompilationError(engine, effect)).toBe(
            "link failed: no program info log\nvertex compile failed: no shader info log\nfragment compile failed: no shader info log"
        );
    });

    it.each(["vertex", "fragment", "program"] as const)("throws on %s allocation failure and releases partial resources", (stage) => {
        const { mock, engine } = setup();
        if (stage === "program") {
            mock.setProgramAllocationSuccess(false);
        } else {
            const createShader = vi.spyOn(engine.gl, "createShader");
            if (stage === "fragment") {
                createShader.mockReturnValueOnce({}).mockReturnValueOnce(null);
            } else {
                createShader.mockReturnValueOnce(null);
            }
        }
        expect(() => createEffect(engine, OPTIONS)).toThrow(stage === "program" ? "program allocation failed" : `${stage} shader allocation failed`);
        expect(mock.count("deleteShader")).toBe(stage === "vertex" ? 0 : stage === "fragment" ? 1 : 2);
        expect(engine._effects).toHaveLength(0);
        expect(engine._effectCache.size).toBe(0);
    });

    it("keeps restored compilation non-blocking and clears an old error on a successful retry", () => {
        const { mock, canvas, engine } = setup();
        const effect = createEffect(engine, OPTIONS);
        expect(isEffectReady(engine, effect)).toBe(true);
        fireLost(canvas);
        mock.setParallelComplete(false);
        mock.setCompileSuccess(false);
        mock.clear();
        fireRestored(canvas);
        expect(mock.count("getShaderParameter")).toBe(0);
        expect(mock.count("getProgramParameter")).toBe(0);
        expect(getEffectCompilationError(engine, effect)).toBeNull();
        mock.setParallelComplete(true);
        expect(getEffectCompilationError(engine, effect)).toContain("mock compile error");
        fireLost(canvas);
        mock.setCompileSuccess(true);
        fireRestored(canvas);
        expect(getEffectCompilationError(engine, effect)).toBeNull();
        expect(effect.isReady).toBe(true);
    });

    it.each(["vertex", "fragment", "program"] as const)("exposes %s restore allocation failure and releases partial resources", (stage) => {
        const { mock, canvas, engine } = setup();
        const effect = createEffect(engine, OPTIONS);
        expect(isEffectReady(engine, effect)).toBe(true);
        fireLost(canvas);
        mock.clear();
        if (stage === "program") {
            mock.setProgramAllocationSuccess(false);
        } else {
            const createShader = vi.spyOn(engine.gl, "createShader");
            if (stage === "fragment") {
                createShader.mockReturnValueOnce({}).mockReturnValueOnce(null);
            } else {
                createShader.mockReturnValueOnce(null);
            }
        }
        fireRestored(canvas);
        expect(getEffectCompilationError(engine, effect)).toBe(`context-restore: ${stage}${stage === "program" ? "" : " shader"} allocation failed`);
        expect(mock.count("deleteShader")).toBe(stage === "vertex" ? 0 : stage === "fragment" ? 1 : 2);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(effect.isReady).toBe(false);
        expect(mock.count("getProgramParameter")).toBe(0);
    });
});
