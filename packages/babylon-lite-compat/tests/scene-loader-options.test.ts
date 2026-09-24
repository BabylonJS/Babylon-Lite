import { describe, expect, it, vi } from "vitest";

const { loadGltf, loadUsd } = vi.hoisted(() => ({
    loadGltf: vi.fn(async () => ({ animationGroups: [] })),
    loadUsd: vi.fn(async () => ({ entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] })),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    loadGltf,
    loadUsd,
}));

import { AppendSceneAsync, ImportMeshAsync, LoadAssetContainerAsync } from "../src/loading/scene-loader.js";
import type { Scene } from "../src/scene/scene.js";

const scene = Object.create(null) as Scene;
const options = {
    pluginOptions: {
        gltf: {
            preprocessUrlAsync: async (url: string): Promise<string> => url,
        },
    },
};

describe("function-style scene loader options", () => {
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
});
