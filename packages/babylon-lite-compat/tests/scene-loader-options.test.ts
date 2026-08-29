import { describe, expect, it } from "vitest";

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
        await expect(load("model.glb", scene, options)).rejects.toThrow(
            "'ISceneLoaderOptions.pluginOptions.gltf.preprocessUrlAsync' is not supported"
        );
    });
});
