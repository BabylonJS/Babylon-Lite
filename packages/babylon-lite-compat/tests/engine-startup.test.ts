import { beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, disposeEngineMock, enableMirroredMeshesMock, enableRectAreaLightsMock, onEngineDeviceLostMock, registerSceneMock, startEngineMock, stopEngineMock } =
    vi.hoisted(() => ({
        createEngineMock: vi.fn(),
        disposeEngineMock: vi.fn(),
        enableMirroredMeshesMock: vi.fn<() => Promise<void>>(),
        enableRectAreaLightsMock: vi.fn<() => Promise<void>>(),
        onEngineDeviceLostMock: vi.fn(),
        registerSceneMock: vi.fn<() => Promise<void>>(),
        startEngineMock: vi.fn<() => Promise<void>>(),
        stopEngineMock: vi.fn(),
    }));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        createEngine: createEngineMock,
        disposeEngine: disposeEngineMock,
        enableMirroredMeshes: enableMirroredMeshesMock,
        enableRectAreaLights: enableRectAreaLightsMock,
        onEngineDeviceLost: onEngineDeviceLostMock,
        registerScene: registerSceneMock,
        startEngine: startEngineMock,
        stopEngine: stopEngineMock,
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
    _initialized: boolean;
    _disposed: boolean;
    _headless: boolean;
    _rafId: number | null;
    _sceneMutationPauseCount: number;
    _shouldResumeAfterSceneMutation: boolean;
    _renderLoopStopRevision: number;
    _sceneMutationPauseRevision: number;
    _start(): Promise<void>;
    _registerLateWork(work: () => Promise<void>): void;
    _pauseForSceneMutation(): void;
    _resumeAfterSceneMutation(): Promise<void>;
    stopRenderLoop(): void;
    dispose(): void;
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
    engine._initialized = false;
    engine._disposed = false;
    engine._headless = false;
    engine._rafId = null;
    engine._sceneMutationPauseCount = 0;
    engine._shouldResumeAfterSceneMutation = false;
    engine._renderLoopStopRevision = 0;
    engine._sceneMutationPauseRevision = 0;
    return engine;
}

describe("compat engine startup ordering", () => {
    beforeEach(() => {
        createEngineMock.mockReset();
        createEngineMock.mockResolvedValue({});
        disposeEngineMock.mockReset();
        enableMirroredMeshesMock.mockReset();
        enableMirroredMeshesMock.mockResolvedValue();
        enableRectAreaLightsMock.mockReset();
        enableRectAreaLightsMock.mockResolvedValue();
        onEngineDeviceLostMock.mockReset();
        onEngineDeviceLostMock.mockReturnValue(() => undefined);
        registerSceneMock.mockReset();
        registerSceneMock.mockResolvedValue();
        startEngineMock.mockReset();
        stopEngineMock.mockReset();
    });

    it("translates disabled antialiasing into a single-sample Lite surface", async () => {
        const canvas = {} as ConstructorParameters<typeof Engine>[0];

        const booleanEngine = new Engine(canvas, false);
        await booleanEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, { msaaSamples: 1 });

        const objectEngine = new Engine(canvas, { antialias: false, msaaSamples: 4 });
        await objectEngine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, { msaaSamples: 1 });

        const optionsEngine = new Engine(canvas, undefined, { antialias: false, msaaSamples: 4 });
        await optionsEngine.initAsync();
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

    it("accepts useReverseDepthBuffer in Babylon.js engine constructor options", async () => {
        const canvas = {} as ConstructorParameters<typeof Engine>[0];
        const engine = new Engine(canvas, true, { useReverseDepthBuffer: true });

        expect(engine.useReverseDepthBuffer).toBe(true);
        await engine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, {});
    });

    it("accepts useReverseDepthBuffer in WebGPU engine constructor options", async () => {
        const canvas = {} as ConstructorParameters<typeof WebGPUEngine>[0];
        const engine = new WebGPUEngine(canvas, { useReverseDepthBuffer: true });

        expect(engine.useReverseDepthBuffer).toBe(true);
        await engine.initAsync();
        expect(createEngineMock).toHaveBeenLastCalledWith(canvas, {});
    });

    it("forwards Lite device loss to the BJS context-loss observable", async () => {
        const engine = new WebGPUEngine({} as ConstructorParameters<typeof WebGPUEngine>[0]);
        const observer = vi.fn();
        engine.onContextLostObservable.add(observer);
        await engine.initAsync();

        const callback = onEngineDeviceLostMock.mock.calls[0]![1] as () => void;
        callback();

        expect(observer).toHaveBeenCalledWith(engine);
    });

    it("rejects BJS canvas presentation options that require Lite's hot surface path", () => {
        const canvas = {} as ConstructorParameters<typeof Engine>[0];

        expect(() => new WebGPUEngine(canvas, { canvasToneMapping: { mode: "extended" } })).toThrow(/surface configuration hot path/);
        expect(() => new WebGPUEngine(canvas, { canvasColorSpace: "display-p3" })).toThrow(/surface configuration hot path/);
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
            _lite: { lights: [] },
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
            _lite: { lights: [] },
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

    it("holds nested scene mutations under one render-loop pause", async () => {
        const engine = makeEngine();
        engine._initialized = true;
        engine._lite = { _animFrameId: 1 } as EngineContext;
        startEngineMock.mockResolvedValue();

        engine._pauseForSceneMutation();
        engine._pauseForSceneMutation();
        await engine._resumeAfterSceneMutation();

        expect(stopEngineMock).toHaveBeenCalledOnce();
        expect(startEngineMock).not.toHaveBeenCalled();

        await engine._resumeAfterSceneMutation();

        expect(startEngineMock).toHaveBeenCalledOnce();
        expect(startEngineMock).toHaveBeenCalledWith(engine._lite);
    });

    it("does not resume a scene mutation pause after an explicit stopRenderLoop", async () => {
        const engine = makeEngine();
        engine._initialized = true;
        engine._lite = { _animFrameId: 1 } as EngineContext;

        engine._pauseForSceneMutation();
        engine.stopRenderLoop();
        await engine._resumeAfterSceneMutation();

        expect(stopEngineMock).toHaveBeenCalledTimes(2);
        expect(startEngineMock).not.toHaveBeenCalled();
    });

    it("does not resume a pending scene mutation after engine disposal, including rejected work", async () => {
        const engine = makeEngine();
        engine._initialized = true;
        engine._lite = { _animFrameId: 1 } as EngineContext;
        let rejectPreparation!: (error: Error) => void;
        const preparation = new Promise<void>((_resolve, reject) => {
            rejectPreparation = reject;
        }).finally(() => engine._resumeAfterSceneMutation());

        engine._pauseForSceneMutation();
        engine.dispose();
        rejectPreparation(new Error("area-light preparation failed"));

        await expect(preparation).rejects.toThrow("area-light preparation failed");
        expect(disposeEngineMock).toHaveBeenCalledOnce();
        expect(disposeEngineMock).toHaveBeenCalledWith(engine._lite);
        expect(startEngineMock).not.toHaveBeenCalled();
    });
});
