import { beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, enableMirroredMeshesMock, registerSceneMock, startEngineMock } = vi.hoisted(() => ({
    createEngineMock: vi.fn(),
    enableMirroredMeshesMock: vi.fn<() => Promise<void>>(),
    registerSceneMock: vi.fn<() => Promise<void>>(),
    startEngineMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        createEngine: createEngineMock,
        enableMirroredMeshes: enableMirroredMeshesMock,
        registerScene: registerSceneMock,
        startEngine: startEngineMock,
    };
});

import type { EngineContext } from "babylon-lite";
import { Engine, WebGPUEngine } from "../src/engine/engine";

interface TestEngine {
    _startupComplete: boolean;
    _startPromise: Promise<void> | null;
    _startupWork: Array<() => Promise<void>>;
    _lateWork: Array<() => Promise<void>>;
    _scenes: object[];
    _lite: EngineContext;
    _start(): Promise<void>;
    _registerLateWork(work: () => Promise<void>): void;
}

interface StartupScene {
    _hasPendingMaterialPluginReconciliations: boolean;
    _reconcilePendingMaterialPlugins(): Promise<void>;
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
        createEngineMock.mockReset();
        createEngineMock.mockResolvedValue({});
        enableMirroredMeshesMock.mockReset();
        enableMirroredMeshesMock.mockResolvedValue();
        registerSceneMock.mockReset();
        registerSceneMock.mockResolvedValue();
        startEngineMock.mockReset();
    });

    it("translates disabled antialiasing into a single-sample Lite surface", async () => {
        const canvas = {} as ConstructorParameters<typeof Engine>[0];

        const booleanEngine = new Engine(canvas, false);
        await booleanEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, { msaaSamples: 1 });

        const objectEngine = new Engine(canvas, { antialias: false, msaaSamples: 4 });
        await objectEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, { msaaSamples: 1 });
    });

    it("retains Lite's sample-count setting when antialiasing is not disabled", async () => {
        const canvas = {} as ConstructorParameters<typeof Engine>[0];

        const defaultEngine = new Engine(canvas, true);
        await defaultEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, undefined);

        const configuredEngine = new Engine(canvas, { antialias: true, msaaSamples: 1 });
        await configuredEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, { msaaSamples: 1 });
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

    it("drains first-frame material-plugin requests before startup is marked complete", async () => {
        const order: string[] = [];
        startEngineMock.mockImplementation(async () => {
            order.push("first-frame");
        });
        const engine = makeEngine();
        engine._scenes.push({
            _buildShadowGenerators: () => undefined,
            _parseNodeMaterials: () => Promise.resolve(),
            _awaitPendingTextures: () => Promise.resolve(),
            _bakeGroundUvs: () => undefined,
            _flushPendingAdds: () => undefined,
            _buildMorphTargets: () => undefined,
            _buildClusteredContainers: () => undefined,
            _enableMaterialPlugins: () => Promise.resolve(),
            _loadPendingEnvironment: () => Promise.resolve(),
            _hasShadows: () => false,
            _lite: {},
            _reconcilePendingMaterialPlugins: () => {
                order.push("plugins");
                return Promise.resolve();
            },
            _hasPendingMaterialPluginReconciliations: false,
        });

        await engine._start();

        expect(order).toEqual(["first-frame", "plugins"]);
        expect(engine._startupComplete).toBe(true);
    });

    it("keeps draining all scenes until startup plugin requests are globally quiescent", async () => {
        let finishSceneB!: () => void;
        const sceneBDrain = new Promise<void>((resolve) => {
            finishSceneB = resolve;
        });
        const startupSceneDefaults = {
            _buildShadowGenerators: () => undefined,
            _parseNodeMaterials: () => Promise.resolve(),
            _awaitPendingTextures: () => Promise.resolve(),
            _bakeGroundUvs: () => undefined,
            _flushPendingAdds: () => undefined,
            _buildMorphTargets: () => undefined,
            _buildClusteredContainers: () => undefined,
            _enableMaterialPlugins: () => Promise.resolve(),
            _loadPendingEnvironment: () => Promise.resolve(),
            _hasShadows: () => false,
            _lite: {},
        };
        let sceneADrains = 0;
        const sceneA: StartupScene & typeof startupSceneDefaults = {
            ...startupSceneDefaults,
            _hasPendingMaterialPluginReconciliations: false,
            async _reconcilePendingMaterialPlugins() {
                sceneADrains++;
                sceneA._hasPendingMaterialPluginReconciliations = false;
            },
        };
        const sceneB: StartupScene & typeof startupSceneDefaults = {
            ...startupSceneDefaults,
            _hasPendingMaterialPluginReconciliations: false,
            _reconcilePendingMaterialPlugins: () => sceneBDrain,
        };
        const engine = makeEngine();
        engine._scenes.push(sceneA, sceneB);

        const startup = engine._start();
        await vi.waitFor(() => expect(sceneADrains).toBe(1));
        sceneA._hasPendingMaterialPluginReconciliations = true;
        finishSceneB();
        await startup;

        expect(sceneADrains).toBe(2);
        expect(engine._startupComplete).toBe(true);
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
