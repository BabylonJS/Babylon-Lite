import { describe, expect, it, vi } from "vitest";

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return { ...actual, addToScene: vi.fn() };
});

import { addToScene } from "babylon-lite";
import type { AssetContainer as LiteAssetContainer } from "babylon-lite";

import { AssetContainer } from "../src/loading/scene-loader";
import type { Scene } from "../src/scene/scene";

describe("AssetContainer.addAllToScene", () => {
    it("registers the canonical loaded wrappers in scene.meshes", () => {
        const mesh = { name: "Cube", children: [], _gpu: {} };
        const root = { name: "__root__", children: [mesh] };
        const lite = { entities: [root] } as unknown as LiteAssetContainer;
        const container = new AssetContainer(lite);
        const register = vi.fn();
        const scene = {
            _lite: {},
            _registerMesh: register,
            _surfaceLoadedCamera: vi.fn(),
        } as unknown as Scene;

        const wrappers = container.meshes;
        container.addAllToScene(scene);

        expect(addToScene).toHaveBeenCalledWith(scene._lite, lite);
        expect(register.mock.calls).toEqual([
            [wrappers[0], root],
            [wrappers[1], mesh],
        ]);
        expect(container.meshes).toEqual(wrappers);
    });
});
