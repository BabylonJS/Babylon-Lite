import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createEffect,
    createGLEngine,
    disposeEffect,
    disposeGLEngine,
    executeWhenCompiled,
    isEffectReady,
    onContextLost,
    waitForEffect,
    type GLEffectOptions,
} from "../../../packages/babylon-lite-gl/src/index";
import { createMockCanvas, createMockGL, fireLost, fireRestored } from "./_lite-gl-mock";

const OPTIONS: GLEffectOptions = {
    name: "wait-test",
    vertexSource: "#version 300 es\nin vec2 position;\nvoid main(){gl_Position=vec4(position,0.,1.);}",
    fragmentSource: "#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main(){color=vec4(1.);}",
    uniformNames: [],
    samplerNames: ["u_texture"],
};

let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
    frames = new Map();
    let nextId = 0;
    vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((callback: FrameRequestCallback) => {
            const id = nextId++;
            frames.set(id, callback);
            return id;
        })
    );
    vi.stubGlobal(
        "cancelAnimationFrame",
        vi.fn((id: number) => frames.delete(id))
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function setup() {
    const mock = createMockGL();
    mock.setParallelComplete(false);
    const canvas = createMockCanvas(mock);
    const engine = createGLEngine(canvas);
    const effect = createEffect(engine, OPTIONS);
    return { mock, canvas, engine, effect };
}

function advanceFrame(): void {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) {
        callback(16);
    }
}

describe("lite-gl: opt-in effect waiting", () => {
    it("does not schedule work for manual polling or executeWhenCompiled", () => {
        const { engine, effect } = setup();
        isEffectReady(engine, effect);
        executeWhenCompiled(engine, effect, () => undefined);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(engine._onLost).toHaveLength(0);
    });

    it("finalizes without a render loop, fires ready callbacks once, and stops polling", async () => {
        const { mock, engine, effect } = setup();
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        const compiled = vi.fn();
        executeWhenCompiled(engine, effect, compiled);
        const promise = waitForEffect(engine, effect, { signal: controller.signal });
        expect(frames.size).toBe(1);
        expect(engine._loops).toHaveLength(0);
        advanceFrame();
        expect(frames.size).toBe(1);
        expect(compiled).not.toHaveBeenCalled();
        mock.setParallelComplete(true);
        advanceFrame();
        await expect(promise).resolves.toBe(effect);
        expect(compiled).toHaveBeenCalledExactlyOnceWith(effect);
        expect(mock.count("uniform1i")).toBe(1);
        expect(frames.size).toBe(0);
        expect(engine._onLost).toHaveLength(0);
        expect(effect._onCompiled).toHaveLength(0);
        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("resolves immediately for a completed link without scheduling a frame", async () => {
        const { mock, engine, effect } = setup();
        mock.setParallelComplete(true);
        await expect(waitForEffect(engine, effect)).resolves.toBe(effect);
        await expect(waitForEffect(engine, effect)).resolves.toBe(effect);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(engine._onLost).toHaveLength(0);
    });

    it("works without the parallel extension", async () => {
        const mock = createMockGL();
        mock.setParallelAvailable(false);
        const engine = createGLEngine(createMockCanvas(mock));
        const effect = createEffect(engine, OPTIONS);
        await expect(waitForEffect(engine, effect)).resolves.toBe(effect);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it.each([true, false])("rejects deferred compilation/link errors and cleans up (compile=%s)", async (compile) => {
        const { mock, engine, effect } = setup();
        const promise = waitForEffect(engine, effect);
        const rejected = expect(promise).rejects.toThrow(compile ? "wait-test link failed: mock link error\nvertex compile failed" : "wait-test link failed: mock link error");
        if (compile) {
            mock.setCompileSuccess(false);
        } else {
            mock.setLinkSuccess(false);
        }
        mock.setParallelComplete(true);
        advanceFrame();
        await rejected;
        expect(frames.size).toBe(0);
        expect(engine._onLost).toHaveLength(0);
        await expect(waitForEffect(engine, effect)).rejects.toThrow("mock link error");
        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it("rejects immediately on context loss, cancels frame zero, and leaves unrelated listeners", async () => {
        const { canvas, engine, effect } = setup();
        const otherListener = vi.fn();
        onContextLost(engine, otherListener);
        const promise = waitForEffect(engine, effect);
        const rejected = expect(promise).rejects.toThrow("wait-test context lost");
        fireLost(canvas);
        await rejected;
        expect(cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(0);
        expect(frames.size).toBe(0);
        expect(engine._onLost).toEqual([otherListener]);
        expect(otherListener).toHaveBeenCalledTimes(1);
    });

    it("can wait again after context restoration", async () => {
        const { mock, canvas, engine, effect } = setup();
        const rejected = expect(waitForEffect(engine, effect)).rejects.toThrow("context lost");
        fireLost(canvas);
        await rejected;
        fireRestored(canvas);
        const promise = waitForEffect(engine, effect);
        mock.setParallelComplete(true);
        advanceFrame();
        await expect(promise).resolves.toBe(effect);
        expect(engine._onLost).toHaveLength(0);
    });

    it("rejects a recorded restore allocation error without scheduling", async () => {
        const { mock, canvas, engine, effect } = setup();
        fireLost(canvas);
        mock.setProgramAllocationSuccess(false);
        fireRestored(canvas);
        await expect(waitForEffect(engine, effect)).rejects.toThrow("wait-test context-restore: program allocation failed");
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(engine._onLost).toHaveLength(0);
    });

    it.each(["effect", "engine"] as const)("rejects %s disposal on the next poll", async (target) => {
        const { engine, effect } = setup();
        const promise = waitForEffect(engine, effect);
        const rejected = expect(promise).rejects.toThrow("wait-test disposed");
        if (target === "effect") {
            disposeEffect(engine, effect);
        } else {
            disposeGLEngine(engine);
        }
        advanceFrame();
        await rejected;
        expect(frames.size).toBe(0);
        expect(engine._onLost).toHaveLength(0);
    });

    it("rejects an already disposed or lost effect without scheduling", async () => {
        const { canvas, engine, effect } = setup();
        fireLost(canvas);
        await expect(waitForEffect(engine, effect)).rejects.toThrow("context lost");
        disposeEffect(engine, effect);
        await expect(waitForEffect(engine, effect)).rejects.toThrow("disposed");
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(engine._onLost).toHaveLength(0);
    });

    it("rejects an already aborted signal without scheduling", async () => {
        const { engine, effect } = setup();
        const controller = new AbortController();
        const reason = new Error("cancelled before waiting");
        controller.abort(reason);
        await expect(waitForEffect(engine, effect, { signal: controller.signal })).rejects.toBe(reason);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        expect(engine._onLost).toHaveLength(0);
    });

    it("wraps a non-Error abort reason without losing it", async () => {
        const { engine, effect } = setup();
        const controller = new AbortController();
        controller.abort("user cancelled");
        await expect(waitForEffect(engine, effect, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError", cause: "user cancelled" });
        expect(engine._onLost).toHaveLength(0);
    });

    it("cancels one waiter without disposing the shared effect or cancelling another", async () => {
        const { mock, engine, effect } = setup();
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        const cancelled = waitForEffect(engine, effect, { signal: controller.signal });
        const continuing = waitForEffect(engine, effect);
        const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        await rejected;
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(effect._disposed).toBe(false);
        expect(effect._refCount).toBe(1);
        expect(frames.size).toBe(1);
        mock.setParallelComplete(true);
        advanceFrame();
        await expect(continuing).resolves.toBe(effect);
        expect(engine._onLost).toHaveLength(0);
        expect(effect._onCompiled).toHaveLength(0);
    });

    it.each(["dispose", "lose", "abort"] as const)("rejects when a ready callback triggers %s instead of resolving", async (action) => {
        const { mock, canvas, engine, effect } = setup();
        const controller = new AbortController();
        executeWhenCompiled(engine, effect, () => {
            if (action === "dispose") {
                disposeEffect(engine, effect);
            } else if (action === "lose") {
                fireLost(canvas);
            } else {
                controller.abort();
            }
        });
        const promise = waitForEffect(engine, effect, { signal: controller.signal });
        const rejected = action === "abort" ? expect(promise).rejects.toMatchObject({ name: "AbortError" }) : expect(promise).rejects.toThrow();
        mock.setParallelComplete(true);
        advanceFrame();
        await rejected;
        expect(frames.size).toBe(0);
        expect(engine._onLost).toHaveLength(0);
    });

    it("rejects polling exceptions and removes listeners", async () => {
        const { engine, effect } = setup();
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        vi.spyOn(engine.gl, "getProgramParameter").mockImplementation(() => {
            throw new Error("poll failed");
        });
        await expect(waitForEffect(engine, effect, { signal: controller.signal })).rejects.toThrow("poll failed");
        expect(frames.size).toBe(0);
        expect(engine._onLost).toHaveLength(0);
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("preserves a non-Error polling exception as the rejection cause", async () => {
        const { engine, effect } = setup();
        vi.spyOn(engine.gl, "getProgramParameter").mockImplementation(() => {
            throw "driver failure";
        });
        await expect(waitForEffect(engine, effect)).rejects.toMatchObject({ message: "lite-gl: wait-test compilation wait failed", cause: "driver failure" });
        expect(engine._onLost).toHaveLength(0);
    });

    it("rejects scheduler failures and removes listeners", async () => {
        const { engine, effect } = setup();
        vi.stubGlobal("requestAnimationFrame", () => {
            throw new Error("scheduler unavailable");
        });
        await expect(waitForEffect(engine, effect)).rejects.toThrow("scheduler unavailable");
        expect(engine._onLost).toHaveLength(0);
    });
});
