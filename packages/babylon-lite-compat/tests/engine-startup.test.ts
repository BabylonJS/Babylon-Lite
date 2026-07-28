import { beforeEach, describe, expect, it, vi } from "vitest";

const { startEngineMock } = vi.hoisted(() => ({
    startEngineMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        startEngine: startEngineMock,
    };
});

import type { EngineContext } from "babylon-lite";
import { WebGPUEngine } from "../src/engine/engine";

interface TestEngine {
    _startupComplete: boolean;
    _startPromise: Promise<void> | null;
    _startupWork: Array<() => Promise<void>>;
    _lateWork: Array<() => Promise<void>>;
    _scenes: [];
    _lite: EngineContext;
    _start(): Promise<void>;
    _registerLateWork(work: () => Promise<void>): void;
}

function makeEngine(): TestEngine {
    const engine = Object.create(WebGPUEngine.prototype) as TestEngine;
    engine._startupComplete = false;
    engine._startPromise = null;
    engine._startupWork = [];
    engine._lateWork = [];
    engine._scenes = [];
    engine._lite = {} as EngineContext;
    return engine;
}

describe("compat engine startup ordering", () => {
    beforeEach(() => {
        startEngineMock.mockReset();
    });

    it("starts the main engine before awaiting utility-layer work", async () => {
        const order: string[] = [];
        startEngineMock.mockImplementation(async () => {
            order.push("engine");
        });
        const engine = makeEngine();
        engine._registerLateWork(async () => {
            order.push("utility");
        });

        await engine._start();

        expect(order).toEqual(["engine", "utility"]);
    });

    it("runs utility-layer work registered after engine startup", async () => {
        startEngineMock.mockResolvedValue();
        const engine = makeEngine();
        await engine._start();
        const registered = vi.fn();

        engine._registerLateWork(async () => {
            registered();
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(registered).toHaveBeenCalledOnce();
    });

    // Late work is best-effort: a rejection must not poison `_startPromise`, which
    // `runRenderLoop` only ever consumes with `void this._start()`.
    it("does not fail startup when late work rejects", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        startEngineMock.mockResolvedValue();
        const engine = makeEngine();
        engine._registerLateWork(async () => {
            throw new Error("utility layer blew up");
        });

        await expect(engine._start()).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("utility layer blew up"));
        error.mockRestore();
    });

    // A thunk that throws before returning a promise is not caught by a trailing `.catch`, so both
    // late-work paths have to invoke it inside the guard.
    it("does not fail startup when late work throws synchronously", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        startEngineMock.mockResolvedValue();
        const engine = makeEngine();
        engine._registerLateWork((() => {
            throw new Error("sync utility layer blew up");
        }) as () => Promise<void>);

        await expect(engine._start()).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("sync utility layer blew up"));
        error.mockRestore();
    });

    it("reports a synchronous throw from late work registered after startup", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        startEngineMock.mockResolvedValue();
        const engine = makeEngine();
        await engine._start();

        expect(() =>
            engine._registerLateWork((() => {
                throw new Error("post-startup sync blew up");
            }) as () => Promise<void>)
        ).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(error).toHaveBeenCalledWith(expect.stringContaining("post-startup sync blew up"));
        error.mockRestore();
    });
});
