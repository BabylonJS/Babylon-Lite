import { describe, expect, it, vi } from "vitest";

const { loadGltf } = vi.hoisted(() => ({
    loadGltf: vi.fn(async () => ({ animationGroups: [] })),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    loadGltf,
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
});
