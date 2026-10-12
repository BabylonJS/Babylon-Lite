import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadUsdOptions } from "babylon-lite";

const { addToScene, disposeUsd, loadGltf, loadSplat, loadUsd, removeFromScene } = vi.hoisted(() => ({
    addToScene: vi.fn(),
    disposeUsd: vi.fn(),
    loadGltf: vi.fn(async () => ({ animationGroups: [] })),
    loadSplat: vi.fn(async () => ({
        name: "loaded",
        position: { x: 0, y: 0, z: 0, set: vi.fn() },
        rotation: { x: 0, y: 0, z: 0, set: vi.fn() },
        scaling: { x: 1, y: 1, z: 1, set: vi.fn() },
        _orderPool: [],
    })),
    loadUsd: vi.fn(async () => ({ entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] })),
    removeFromScene: vi.fn(),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    addToScene,
    disposeUsd,
    loadGltf,
    loadSplat,
    loadUsd,
    removeFromScene,
}));

import { AppendSceneAsync, ImportMeshAsync, LoadAssetContainerAsync, SceneLoader } from "../src/loading/scene-loader.js";
import { USDFileLoader } from "../src/loading/usd-file-loader.js";
import { Observable } from "../src/misc/observable.js";
import type { Scene } from "../src/scene/scene.js";

const scene = Object.create(null) as Scene;
const options = {
    pluginOptions: {
        gltf: {
            preprocessUrlAsync: async (url: string): Promise<string> => url,
        },
    },
};

function fakeScene(): Scene {
    return {
        _lite: { id: "scene" },
        getEngine: () => ({ _lite: { id: "engine" } }),
        onDisposeObservable: new Observable<Scene>(),
        _surfaceLoadedCamera: vi.fn(),
        _registerMesh: vi.fn(),
    } as unknown as Scene;
}

describe("function-style scene loader options", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([ImportMeshAsync, AppendSceneAsync, LoadAssetContainerAsync])("rejects unsupported glTF URL preprocessing", async (load) => {
        await expect(load("model.glb", scene, options)).rejects.toThrow("'ISceneLoaderOptions.pluginOptions.gltf.preprocessUrlAsync' is not supported");
    });

    it("resolves the source against rootUrl before loading", async () => {
        const loaderScene = { getEngine: () => ({ _lite: {} }) } as Scene;

        await LoadAssetContainerAsync("model.glb", loaderScene, { rootUrl: "https://cdn.example/assets/" });

        expect(loadGltf).toHaveBeenCalledWith({}, "https://cdn.example/assets/model.glb");
    });

    it("dispatches USD URLs and forwards plugin runtime options", async () => {
        const loaderScene = { getEngine: () => ({ _lite: {} }) } as Scene;
        const runtime = "https://cdn.example/usd/";

        await LoadAssetContainerAsync("model.usdz", loaderScene, {
            pluginOptions: {
                usd: {
                    workerUrl: `${runtime}babylon-usd-importer.worker.js`,
                    glueUrl: `${runtime}babylon-usd-importer.js`,
                    wasmUrl: `${runtime}babylon-usd-importer.wasm`,
                    dataUrl: `${runtime}babylon-usd-importer.data`,
                },
            },
        });

        expect(loadUsd).toHaveBeenCalledWith({}, "model.usdz", expect.objectContaining({ resolveByFileName: true, runtimeBaseUrl: runtime }));
    });

    it("dispatches splat URLs through plugin options", async () => {
        const target = { _adopt: vi.fn() };
        const loaderScene = fakeScene();

        const result = await ImportMeshAsync("cloud.splat", loaderScene, {
            pluginOptions: { splat: { gaussianSplattingMesh: target as never } },
        });

        expect(loadSplat).toHaveBeenCalledWith(loaderScene._lite, "cloud.splat");
        expect(target._adopt).toHaveBeenCalledOnce();
        expect(result.meshes).toEqual([target]);
    });

    it("rejects detached splat containers instead of falling through to glTF", async () => {
        await expect(LoadAssetContainerAsync("cloud.splat", fakeScene())).rejects.toThrow(/asset-container lifecycle/);
        expect(loadGltf).not.toHaveBeenCalled();
    });

    it("forwards both SceneLoader and USD plugin progress callbacks", async () => {
        const onProgress = vi.fn();
        const onUsdProgress = vi.fn();

        await LoadAssetContainerAsync("model.usdz", fakeScene(), {
            onProgress,
            pluginOptions: { usd: { onProgress: onUsdProgress } },
        });
        const liteOptions = (loadUsd.mock.calls as unknown as Array<[unknown, unknown, LoadUsdOptions]>)[0]![2];

        liteOptions.onProgress?.({ phase: "fetching", message: "Reading USD files..." });
        liteOptions.onProgress?.({ phase: "staging", message: "Opening stage..." });

        expect(onProgress).toHaveBeenNthCalledWith(1, { lengthComputable: false, loaded: 0, total: 4 });
        expect(onProgress).toHaveBeenNthCalledWith(2, { lengthComputable: false, loaded: 2, total: 4 });
        expect(onUsdProgress).toHaveBeenCalledOnce();
        expect(onUsdProgress).toHaveBeenCalledWith({ phase: "staging", message: "Opening stage..." });
    });

    it("applies mutable USD defaults to classic and function-style entry points", async () => {
        const original = { ...USDFileLoader.DefaultConfiguration };
        Object.assign(USDFileLoader.DefaultConfiguration, {
            workerUrl: "https://defaults.test/usd/babylon-usd-importer.worker.js",
            glueUrl: "https://defaults.test/usd/babylon-usd-importer.js",
            wasmUrl: "https://defaults.test/usd/babylon-usd-importer.wasm",
            dataUrl: "https://defaults.test/usd/babylon-usd-importer.data",
        });
        const loaderScene = fakeScene();

        try {
            await SceneLoader.LoadAssetContainerAsync("", "classic.usdz", loaderScene);
            await LoadAssetContainerAsync("function.usdz", loaderScene);
            expect(loadUsd).toHaveBeenNthCalledWith(1, { id: "engine" }, "classic.usdz", expect.objectContaining({ runtimeBaseUrl: "https://defaults.test/usd/" }));
            expect(loadUsd).toHaveBeenNthCalledWith(2, { id: "engine" }, "function.usdz", expect.objectContaining({ runtimeBaseUrl: "https://defaults.test/usd/" }));
        } finally {
            Object.assign(USDFileLoader.DefaultConfiguration, original);
        }
    });

    it("releases USD resources when a function-style completion callback throws", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);

        await expect(
            LoadAssetContainerAsync("model.usdz", fakeScene(), {
                pluginOptions: {
                    usd: {
                        onComplete: () => {
                            throw new Error("callback failed");
                        },
                    },
                },
            })
        ).rejects.toThrow("callback failed");
        expect(disposeUsd).toHaveBeenCalledWith(lite);
    });

    it.each([
        ["classic append", (scene: Scene) => SceneLoader.AppendAsync("", "model.usdz", scene)],
        ["function append", (scene: Scene) => AppendSceneAsync("model.usdz", scene)],
    ])("releases adopted USD resources on scene disposal for %s", async (_name, append) => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const loaderScene = fakeScene();

        await append(loaderScene);
        loaderScene.onDisposeObservable.notifyObservers(loaderScene);
        loaderScene.onDisposeObservable.notifyObservers(loaderScene);

        expect(disposeUsd).toHaveBeenCalledTimes(1);
        expect(disposeUsd).toHaveBeenCalledWith(lite);
    });
});
