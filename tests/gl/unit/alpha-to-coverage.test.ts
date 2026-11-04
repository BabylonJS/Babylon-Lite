import { describe, expect, it } from "vitest";
import { createGLEngine, disposeGLEngine, getAlphaToCoverage, getCurrentSampleCount, setAlphaToCoverage, wipeGLStateCache } from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored, type MockGL } from "./_lite-gl-mock";

function makeEngine() {
    const mock = createMockGL();
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    mock.clear();
    return { mock, canvas, engine };
}

function capabilityCalls(mock: MockGL, name: "enable" | "disable", capability: number): number {
    return mock.log.filter((call) => call.name === name && call.args[0] === capability).length;
}

describe("lite-gl alpha-to-coverage", () => {
    it("applies and caches SAMPLE_ALPHA_TO_COVERAGE state", () => {
        const { mock, engine } = makeEngine();
        const capability = engine.gl.SAMPLE_ALPHA_TO_COVERAGE;

        expect(getAlphaToCoverage(engine)).toBe(false);
        setAlphaToCoverage(engine, true);
        setAlphaToCoverage(engine, true);
        expect(getAlphaToCoverage(engine)).toBe(true);
        expect(capabilityCalls(mock, "enable", capability)).toBe(1);

        setAlphaToCoverage(engine, false);
        setAlphaToCoverage(engine, false);
        expect(getAlphaToCoverage(engine)).toBe(false);
        expect(capabilityCalls(mock, "disable", capability)).toBe(1);
    });

    it("retains requested state and reapplies it after context restoration", () => {
        const { mock, canvas, engine } = makeEngine();
        const capability = engine.gl.SAMPLE_ALPHA_TO_COVERAGE;
        setAlphaToCoverage(engine, true);
        mock.clear();

        fireLost(canvas);
        setAlphaToCoverage(engine, false);
        setAlphaToCoverage(engine, true);
        expect(capabilityCalls(mock, "enable", capability)).toBe(0);
        expect(capabilityCalls(mock, "disable", capability)).toBe(0);

        fireRestored(canvas);
        expect(getAlphaToCoverage(engine)).toBe(true);
        expect(capabilityCalls(mock, "enable", capability)).toBe(1);
    });

    it("reapplies the requested state after the shared GL cache is wiped", () => {
        const { mock, engine } = makeEngine();
        const capability = engine.gl.SAMPLE_ALPHA_TO_COVERAGE;
        setAlphaToCoverage(engine, true);
        mock.clear();

        wipeGLStateCache(engine);
        setAlphaToCoverage(engine, true);

        expect(capabilityCalls(mock, "enable", capability)).toBe(1);
    });

    it("normalizes the current draw framebuffer sample count", () => {
        const { mock, engine } = makeEngine();
        mock.setSampleCount(0);
        expect(getCurrentSampleCount(engine)).toBe(1);
        mock.setSampleCount(4);
        expect(getCurrentSampleCount(engine)).toBe(4);
    });

    it("does not mutate GL state after disposal", () => {
        const { mock, engine } = makeEngine();
        const capability = engine.gl.SAMPLE_ALPHA_TO_COVERAGE;
        disposeGLEngine(engine);
        mock.clear();

        setAlphaToCoverage(engine, true);

        expect(getAlphaToCoverage(engine)).toBe(false);
        expect(capabilityCalls(mock, "enable", capability)).toBe(0);
    });
});
