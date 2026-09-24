import { describe, expect, it, vi } from "vitest";

const { addToScene, disposeUsd, loadUsd, removeFromScene } = vi.hoisted(() => ({
    addToScene: vi.fn(),
    disposeUsd: vi.fn(),
    loadUsd: vi.fn(),
    removeFromScene: vi.fn(),
}));

vi.mock("babylon-lite", async (importOriginal) => ({
    ...(await importOriginal<typeof import("babylon-lite")>()),
    addToScene,
    disposeUsd,
    loadUsd,
    removeFromScene,
}));

import { RegisterUSDFileLoader, USDFileLoader } from "../src/loading/usd-file-loader.js";
import type { Scene } from "../src/scene/scene.js";

function fakeScene(): Scene {
    return {
        _lite: { id: "scene" },
        getEngine: () => ({ _lite: { id: "engine" } }),
        _surfaceLoadedCamera: vi.fn(),
    } as unknown as Scene;
}

describe("USDFileLoader", () => {
    it("forwards binary imports and BJS defaults to Lite", async () => {
        const diagnostics = {
            timings: { totalMs: 1, stageOpenMs: 2, stageReadMs: 3, preparationMs: 4, packingMs: 5, heapCopyMs: 6, materializeMs: 7 },
            statistics: { nodes: 1, meshes: 2, analyticPrimitives: 3, instances: 4, materials: 5, vertices: 6, triangles: 7, commandBytes: 8, dataBytes: 9 },
            missingAssets: [],
        };
        const lite = { entities: [], diagnostics, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const onComplete = vi.fn();
        const loader = new USDFileLoader({ onComplete });
        const scene = fakeScene();
        const data = new ArrayBuffer(8);

        const container = await loader.loadAssetContainerAsync(scene, data, "", undefined, "model.usdz");

        expect(loadUsd).toHaveBeenCalledWith(
            { id: "engine" },
            data,
            expect.objectContaining({
                rootFileName: "model.usdz",
                resolveByFileName: true,
                runtimeBaseUrl: undefined,
                signal: expect.any(AbortSignal),
            })
        );
        expect(onComplete).toHaveBeenCalledWith(diagnostics);
        container.dispose();
        expect(disposeUsd).toHaveBeenCalledWith(lite);
    });

    it("adds loadAsync results to the compat scene", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const scene = fakeScene();

        await new USDFileLoader().loadAsync(scene, new Uint8Array([1]), "");

        expect(addToScene).toHaveBeenCalledWith(scene._lite, lite);
    });

    it("maps four co-located standard runtime URLs to Lite's directory option", async () => {
        loadUsd.mockResolvedValueOnce({ entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] });

        await new USDFileLoader({
            workerUrl: "https://example.test/usd/babylon-usd-importer.worker.js",
            glueUrl: "https://example.test/usd/babylon-usd-importer.js",
            wasmUrl: "https://example.test/usd/babylon-usd-importer.wasm",
            dataUrl: "https://example.test/usd/babylon-usd-importer.data",
        }).loadAssetContainerAsync(fakeScene(), new ArrayBuffer(1), "");

        expect(loadUsd).toHaveBeenLastCalledWith({ id: "engine" }, expect.any(ArrayBuffer), expect.objectContaining({ runtimeBaseUrl: "https://example.test/usd/" }));
    });

    it("rejects partial runtime overrides rather than silently relocating defaults", async () => {
        await expect(
            new USDFileLoader({ workerUrl: "https://example.test/usd/babylon-usd-importer.worker.js" }).loadAssetContainerAsync(fakeScene(), new ArrayBuffer(1), "")
        ).rejects.toThrow(/all four standard files/);
    });

    it("removes an adopted container before releasing its USD resources", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const scene = fakeScene();
        const container = await new USDFileLoader().loadAssetContainerAsync(scene, new ArrayBuffer(1), "");

        container.addAllToScene(scene);
        container.dispose();

        expect(removeFromScene).toHaveBeenCalledWith(scene._lite, lite);
        expect(disposeUsd).toHaveBeenCalledWith(lite);
        expect(removeFromScene.mock.invocationCallOrder[0]).toBeLessThan(disposeUsd.mock.invocationCallOrder.at(-1)!);
    });

    it("keeps registration idempotent because compat dispatches directly", () => {
        expect(RegisterUSDFileLoader()).toBeUndefined();
        expect(RegisterUSDFileLoader()).toBeUndefined();
    });
});
