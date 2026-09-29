/** MeshLoD public facade — API shape, option validation, and error model.
 *
 *  These are pure-state / standalone-function checks that need no WebGPU device:
 *  option defaults and validation, instance creation + material rejection, the
 *  simple setters, and the stable error model. Loading/streaming behavior is
 *  covered by the integration suites. */

import { describe, expect, it } from "vitest";
import {
    _resolveMeshLoDLoadOptions,
    createMeshLoDInstance,
    disposeMeshLoDAsset,
    getMeshLoDDiagnostics,
    isMeshLoDError,
    loadMeshLoD,
    setMeshLoDCacheBudget,
    setMeshLoDDebugView,
    setMeshLoDScreenSpaceError,
    setMeshLoDSelectionMode,
    setMeshLoDStreamingPaused,
    type MeshLoDAsset,
    type MeshLoDDiagnostics,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";

const MIB = 1024 * 1024;

function makeFakeAsset(): MeshLoDAsset {
    const settings = _resolveMeshLoDLoadOptions();
    const diagnostics = { streamingPaused: false } as unknown as MeshLoDDiagnostics;
    return {
        metadata: {} as MeshLoDAsset["metadata"],
        diagnostics,
        state: "ready",
        _runtime: {
            engine: {} as EngineContext,
            settings,
            abortController: new AbortController(),
            generation: 0,
            frameIndex: 0,
            streamingPaused: false,
            debugView: "none",
            selectionMode: "gpu",
            nextInstanceId: 0,
            disposed: false,
        } as unknown as MeshLoDAsset["_runtime"],
    };
}

describe("_resolveMeshLoDLoadOptions", () => {
    it("applies documented defaults", () => {
        const s = _resolveMeshLoDLoadOptions();
        expect(s.screenSpaceError).toBe(2.0);
        expect(s.lodHysteresis).toBe(0.15);
        expect(s.residencyHoldFrames).toBe(120);
        expect(s.obsoleteRequestGraceFrames).toBe(2);
        expect(s.cacheBudgetBytes).toBe(128 * MIB);
        expect(s.cacheCapacityBytes).toBe(128 * MIB);
        expect(s.cpuPageCacheBytes).toBe(64 * MIB);
        expect(s.maxConcurrentRequests).toBe(4);
        expect(s.retryCount).toBe(2);
        expect(s.retryDelaysMs).toEqual([250, 1000]);
    });

    it("preserves valid overrides", () => {
        const s = _resolveMeshLoDLoadOptions({ screenSpaceError: 4, lodHysteresis: 0, maxConcurrentRequests: 1, retryDelaysMs: [10] });
        expect(s.screenSpaceError).toBe(4);
        expect(s.lodHysteresis).toBe(0);
        expect(s.maxConcurrentRequests).toBe(1);
        expect(s.retryDelaysMs).toEqual([10]);
    });

    it("defaults the budget to the capacity when the capacity is shrunk", () => {
        const s = _resolveMeshLoDLoadOptions({ cacheCapacityBytes: 32 * MIB });
        expect(s.cacheCapacityBytes).toBe(32 * MIB);
        expect(s.cacheBudgetBytes).toBe(32 * MIB);
    });

    it.each([
        ["screenSpaceError", { screenSpaceError: 0 }],
        ["screenSpaceError", { screenSpaceError: Number.NaN }],
        ["lodHysteresis", { lodHysteresis: 1 }],
        ["lodHysteresis", { lodHysteresis: -0.1 }],
        ["residencyHoldFrames", { residencyHoldFrames: -1 }],
        ["residencyHoldFrames", { residencyHoldFrames: 1.5 }],
        ["cacheCapacityBytes", { cacheCapacityBytes: 0 }],
        ["cacheBudgetBytes", { cacheBudgetBytes: 64 * MIB, cacheCapacityBytes: 32 * MIB }],
        ["cpuPageCacheBytes", { cpuPageCacheBytes: -5 }],
        ["maxConcurrentRequests", { maxConcurrentRequests: 0 }],
        ["retryCount", { retryCount: -1 }],
        ["retryDelaysMs", { retryDelaysMs: [-1] }],
    ])("rejects invalid %s with MLOD_INVALID_OPTION", (_name, options) => {
        try {
            _resolveMeshLoDLoadOptions(options);
            throw new Error("expected validation to throw");
        } catch (error) {
            expect(isMeshLoDError(error)).toBe(true);
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_INVALID_OPTION");
        }
    });
});

describe("loadMeshLoD option validation", () => {
    it("rejects invalid options before any network work", async () => {
        await expect(loadMeshLoD({} as EngineContext, "asset.mlod", { screenSpaceError: -1 })).rejects.toMatchObject({ code: "MLOD_INVALID_OPTION" });
    });

    it("rejects an invalid selectionMode before any network work", async () => {
        await expect(loadMeshLoD({} as EngineContext, "asset.mlod", { selectionMode: "auto" as unknown as "cpu" })).rejects.toMatchObject({ code: "MLOD_INVALID_OPTION" });
    });
});

describe("createMeshLoDInstance", () => {
    it("builds a plain SceneNode instance and increments ids", () => {
        const asset = makeFakeAsset();
        const material = {} as PbrMaterialProps;
        const a = createMeshLoDInstance(asset, material, { name: "statue" });
        const b = createMeshLoDInstance(asset, material);
        expect(a.name).toBe("statue");
        expect(a.asset).toBe(asset);
        expect(a.material).toBe(material);
        expect(a.visible).toBe(true);
        expect(a._instanceId).toBe(0);
        expect(b._instanceId).toBe(1);
        // No scene reference is stored on the instance.
        expect((a as unknown as Record<string, unknown>).scene).toBeUndefined();
    });

    it("rejects alpha-blended materials with MLOD_UNSUPPORTED_MATERIAL", () => {
        const asset = makeFakeAsset();
        const material = { alphaBlend: true } as PbrMaterialProps;
        try {
            createMeshLoDInstance(asset, material);
            throw new Error("expected rejection");
        } catch (error) {
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_UNSUPPORTED_MATERIAL");
        }
    });
});

describe("asset setters and lifecycle", () => {
    it("mutates runtime settings/flags", () => {
        const asset = makeFakeAsset();
        setMeshLoDScreenSpaceError(asset, 8);
        setMeshLoDCacheBudget(asset, 16 * MIB);
        setMeshLoDStreamingPaused(asset, true);
        setMeshLoDDebugView(asset, "lod-depth");
        setMeshLoDSelectionMode(asset, "cpu");
        expect(asset._runtime.settings.screenSpaceError).toBe(8);
        expect(asset._runtime.settings.cacheBudgetBytes).toBe(16 * MIB);
        expect(asset._runtime.streamingPaused).toBe(true);
        expect(asset._runtime.debugView).toBe("lod-depth");
        expect(asset._runtime.selectionMode).toBe("cpu");
    });

    it("validates setter inputs", () => {
        const asset = makeFakeAsset();
        expect(() => setMeshLoDScreenSpaceError(asset, 0)).toThrowError();
        expect(() => setMeshLoDCacheBudget(asset, 999 * MIB)).toThrowError();
        expect(() => setMeshLoDSelectionMode(asset, "auto" as unknown as "cpu")).toThrowError();
    });

    it("returns the live diagnostics object", () => {
        const asset = makeFakeAsset();
        expect(getMeshLoDDiagnostics(asset)).toBe(asset.diagnostics);
    });

    it("disposes idempotently and aborts outstanding work", () => {
        const asset = makeFakeAsset();
        const signal = asset._runtime.abortController.signal;
        disposeMeshLoDAsset(asset);
        expect(asset.state).toBe("disposed");
        expect(asset._runtime.disposed).toBe(true);
        expect(signal.aborted).toBe(true);
        const generationAfterFirst = asset._runtime.generation;
        disposeMeshLoDAsset(asset);
        expect(asset._runtime.generation).toBe(generationAfterFirst);
    });
});
