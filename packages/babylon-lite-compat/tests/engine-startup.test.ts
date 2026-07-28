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
    _running: boolean;
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
    engine._running = false;
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
});
