import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { USD_RUNTIME_BASE_URL } from "../src/loading/usd-options.js";
import { Observable } from "../src/misc/observable.js";
import type { Scene } from "../src/scene/scene.js";

function fakeScene(): Scene {
    return {
        _lite: { id: "scene" },
        getEngine: () => ({ _lite: { id: "engine" } }),
        onDisposeObservable: new Observable<Scene>(),
        _surfaceLoadedCamera: vi.fn(),
    } as unknown as Scene;
}

describe("USDFileLoader", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
                runtimeBaseUrl: USD_RUNTIME_BASE_URL,
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

    it("applies mutable default configuration while preserving explicit options", async () => {
        const original = { ...USDFileLoader.DefaultConfiguration };
        USDFileLoader.DefaultConfiguration = {
            workerUrl: "https://defaults.test/usd/babylon-usd-importer.worker.js",
            glueUrl: "https://defaults.test/usd/babylon-usd-importer.js",
            wasmUrl: "https://defaults.test/usd/babylon-usd-importer.wasm",
            dataUrl: "https://defaults.test/usd/babylon-usd-importer.data",
        };
        loadUsd.mockResolvedValueOnce({ entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] });

        try {
            await new USDFileLoader({ resolveByFileName: false }).loadAssetContainerAsync(fakeScene(), new ArrayBuffer(1), "");
            expect(loadUsd).toHaveBeenCalledWith(
                { id: "engine" },
                expect.any(ArrayBuffer),
                expect.objectContaining({ runtimeBaseUrl: "https://defaults.test/usd/", resolveByFileName: false })
            );
        } finally {
            USDFileLoader.DefaultConfiguration = original;
        }
    });

    it("rejects signed runtime URLs rather than dropping their authorization data", async () => {
        const runtime = "https://example.test/usd/";
        await expect(
            new USDFileLoader({
                workerUrl: `${runtime}babylon-usd-importer.worker.js?token=secret`,
                glueUrl: `${runtime}babylon-usd-importer.js`,
                wasmUrl: `${runtime}babylon-usd-importer.wasm`,
                dataUrl: `${runtime}babylon-usd-importer.data`,
            }).loadAssetContainerAsync(fakeScene(), new ArrayBuffer(1), "")
        ).rejects.toThrow(/cannot preserve per-file query strings or hash fragments/);
    });

    it("rolls back scene adoption and USD resources when onComplete throws", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        const scene = fakeScene();
        loadUsd.mockResolvedValueOnce(lite);
        await expect(
            new USDFileLoader({
                onComplete: () => {
                    throw new Error("callback failed");
                },
            }).loadAsync(scene, new ArrayBuffer(1), "")
        ).rejects.toThrow("callback failed");
        expect(removeFromScene).toHaveBeenLastCalledWith(scene._lite, lite);
        expect(disposeUsd).toHaveBeenLastCalledWith(lite);
    });

    it("rolls back and rejects when onComplete disposes the active loader", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const scene = fakeScene();
        let loader: USDFileLoader;
        loader = new USDFileLoader({ onComplete: () => loader.dispose() });

        await expect(loader.loadAsync(scene, new ArrayBuffer(1), "")).rejects.toThrow("USDFileLoader was disposed.");
        expect(removeFromScene).toHaveBeenCalledWith(scene._lite, lite);
        expect(disposeUsd).toHaveBeenCalledWith(lite);
    });

    it("removes an adopted container before releasing its USD resources", async () => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const scene = fakeScene();
        const container = await new USDFileLoader().loadAssetContainerAsync(scene, new ArrayBuffer(1), "");

        container.addAllToScene(scene);
        container.dispose();
        container.dispose();

        expect(removeFromScene).toHaveBeenCalledWith(scene._lite, lite);
        expect(removeFromScene).toHaveBeenCalledTimes(1);
        expect(disposeUsd).toHaveBeenCalledWith(lite);
        expect(disposeUsd).toHaveBeenCalledTimes(1);
        expect(removeFromScene.mock.invocationCallOrder[0]).toBeLessThan(disposeUsd.mock.invocationCallOrder.at(-1)!);
    });

    it.each([
        ["importMeshAsync", (loader: USDFileLoader, scene: Scene) => loader.importMeshAsync(null, scene, new ArrayBuffer(1), "")],
        ["loadAsync", (loader: USDFileLoader, scene: Scene) => loader.loadAsync(scene, new ArrayBuffer(1), "")],
    ])("releases adopted USD resources with the scene for %s", async (_name, run) => {
        const lite = { entities: [], diagnostics: { timings: {}, statistics: {}, missingAssets: [] }, _usdMeshes: [], _usdTextures: [] };
        loadUsd.mockResolvedValueOnce(lite);
        const scene = fakeScene();

        await run(new USDFileLoader(), scene);
        scene.onDisposeObservable.notifyObservers(scene);
        scene.onDisposeObservable.notifyObservers(scene);

        expect(disposeUsd).toHaveBeenCalledTimes(1);
        expect(disposeUsd).toHaveBeenCalledWith(lite);
    });

    it("keeps registration idempotent because compat dispatches directly", () => {
        expect(RegisterUSDFileLoader()).toBeUndefined();
        expect(RegisterUSDFileLoader()).toBeUndefined();
    });
});
