import { describe, expect, it } from "vitest";
import { createGLEngine } from "../../../packages/babylon-lite-gl/src/context";
import {
    createEffect,
    isEffectReady,
    setEffectVector2,
    setEffectDirectColor4,
    setEffectMatrix,
    setEffectMatrix3x3,
    setEffectFloatArray,
    setEffectFloatArray4,
    setEffectIntArray,
    type GLEffect,
} from "../../../packages/babylon-lite-gl/src/effect";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockCall, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    return { mock, canvas, engine };
}

function makeReadyEffect(engine: ReturnType<typeof makeEngine>["engine"]): GLEffect {
    const eff = createEffect(engine, {
        name: "setters",
        vertexSource: "v",
        fragmentSource: "f",
        uniformNames: ["u_v2", "u_col", "u_mat", "u_mat3", "u_arr", "u_arr4", "u_iarr"],
        samplerNames: [],
    });
    isEffectReady(engine, eff);
    return eff;
}

function callsNamed(mock: MockGL, name: string): MockCall[] {
    return mock.log.filter((c) => c.name === name);
}

describe("lite-gl effect: extended uniform setters", () => {
    it("setEffectVector2 → uniform2f from {x,y} (cached like the vec path)", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        mock.clear();
        setEffectVector2(engine, eff, "u_v2", { x: 0.1, y: 0.2 });
        expect(callsNamed(mock, "uniform2f")[0]?.args).toEqual([expect.anything(), 0.1, 0.2]);
        setEffectVector2(engine, eff, "u_v2", { x: 0.1, y: 0.2 });
        expect(callsNamed(mock, "uniform2f")).toHaveLength(1); // cached
    });

    it("setEffectDirectColor4 → uniform4f from {r,g,b,a}", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        mock.clear();
        setEffectDirectColor4(engine, eff, "u_col", { r: 1, g: 0.5, b: 0.25, a: 0.75 });
        expect(callsNamed(mock, "uniform4f")[0]?.args).toEqual([expect.anything(), 1, 0.5, 0.25, 0.75]);
    });

    it("setEffectMatrix → uniformMatrix4fv (transpose false)", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const m = new Float32Array(16);
        mock.clear();
        setEffectMatrix(engine, eff, "u_mat", m);
        const c = callsNamed(mock, "uniformMatrix4fv")[0];
        expect(c?.args[1]).toBe(false);
        expect(c?.args[2]).toBe(m);
    });

    it("setEffectMatrix3x3 → uniformMatrix3fv", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const m = new Float32Array(9);
        mock.clear();
        setEffectMatrix3x3(engine, eff, "u_mat3", m);
        expect(callsNamed(mock, "uniformMatrix3fv")[0]?.args[2]).toBe(m);
    });

    it("setEffectFloatArray → uniform1fv; setEffectFloatArray4 → uniform4fv", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const a = new Float32Array([1, 2, 3]);
        const a4 = new Float32Array([1, 2, 3, 4]);
        mock.clear();
        setEffectFloatArray(engine, eff, "u_arr", a);
        setEffectFloatArray4(engine, eff, "u_arr4", a4);
        expect(callsNamed(mock, "uniform1fv")[0]?.args[1]).toBe(a);
        expect(callsNamed(mock, "uniform4fv")[0]?.args[1]).toBe(a4);
    });

    it("setEffectIntArray → uniform1iv", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        const a = new Int32Array([5, 6, 7]);
        mock.clear();
        setEffectIntArray(engine, eff, "u_iarr", a);
        expect(callsNamed(mock, "uniform1iv")[0]?.args[1]).toBe(a);
    });

    it("matrix/array setters no-op on a missing uniform", () => {
        const { mock, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        mock.clear();
        setEffectMatrix(engine, eff, "__missing_x", new Float32Array(16));
        setEffectFloatArray(engine, eff, "__missing_y", [1, 2]);
        expect(callsNamed(mock, "uniformMatrix4fv")).toHaveLength(0);
        expect(callsNamed(mock, "uniform1fv")).toHaveLength(0);
    });

    it("setters are no-ops before the effect is ready", () => {
        const { mock, engine } = makeEngine();
        const eff = createEffect(engine, { name: "x", vertexSource: "v", fragmentSource: "f", uniformNames: ["u_mat"], samplerNames: [] });
        // Not finalized yet (isEffectReady not polled).
        eff.isReady = false;
        mock.clear();
        setEffectMatrix(engine, eff, "u_mat", new Float32Array(16));
        expect(callsNamed(mock, "uniformMatrix4fv")).toHaveLength(0);
    });

    it("value cache is invalidated on context-loss → an unchanged uniform re-uploads after restore", () => {
        const { mock, canvas, engine } = makeEngine();
        const eff = makeReadyEffect(engine);
        setEffectVector2(engine, eff, "u_v2", { x: 0.1, y: 0.2 }); // uploaded + cached
        expect(callsNamed(mock, "uniform2f")).toHaveLength(1);
        // Lose + restore the context: the re-linked program's uniforms reset to 0,
        // so the value cache MUST have been cleared on loss.
        fireLost(canvas);
        fireRestored(canvas);
        isEffectReady(engine, eff); // re-finalize (re-resolve locations) after restore
        mock.clear();
        // Same value as before the loss — must STILL re-upload (cache was cleared),
        // otherwise the uniform would wrongly stay at the new program's 0 default.
        setEffectVector2(engine, eff, "u_v2", { x: 0.1, y: 0.2 });
        expect(callsNamed(mock, "uniform2f")).toHaveLength(1);
        // ...and a genuine repeat after that is elided again (cache re-primed).
        setEffectVector2(engine, eff, "u_v2", { x: 0.1, y: 0.2 });
        expect(callsNamed(mock, "uniform2f")).toHaveLength(1);
    });
});
