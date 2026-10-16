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
    type MeshLoDInstance,
} from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { cloneTransformNode, createTransformNode } from "../../../../packages/babylon-lite/src/scene/transform-node.js";
import { createTranslationMat4 } from "../../../../packages/babylon-lite/src/math/create-translation-mat4.js";

const MIB = 1024 * 1024;

function makeFakeAsset(): MeshLoDAsset {
    const settings = _resolveMeshLoDLoadOptions({ cacheCapacityBytes: 4 * MIB });
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
            _selectionEpoch: 0,
            _frameSnapshots: new Map(),
            streamingPaused: false,
            debugView: "none",
            selectionMode: "gpu",
            nextInstanceId: 0,
            disposed: false,
            gpu: { arena: { pinnedCount: 2, capacityBytes: 4 * MIB, blockCount: 64 } },
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

    it.each([false, true])("clones a hierarchy without losing MeshLoD state (raw matrix=%s)", (rawMatrix) => {
        const asset = makeFakeAsset();
        const material = {} as PbrMaterialProps;
        const root = createTransformNode("root", 10, 20, 30);
        const source = createMeshLoDInstance(asset, material, { name: "statue", visible: false, screenSpaceError: 0.5 });
        source.position.set(1, 2, 3);
        source.rotationQuaternion.set(0.2, 0.3, 0.4, Math.sqrt(0.71));
        source.scaling.set(-2, 3, 4);
        if (rawMatrix) {
            source._localMatrix = createTranslationMat4(4, 5, 6);
            source._localMatrixLocked = true;
        }
        source._selectionVersion = 5;
        source.parent = root;
        root.children.push(source);
        source.children.push(createTransformNode("child", 7, 8, 9));

        const clonedRoot = cloneTransformNode(root);
        const clone = clonedRoot.children[0]! as MeshLoDInstance;
        expect(clone.asset).toBe(asset);
        expect(clone._asset).toBe(asset);
        expect(clone.material).toBe(material);
        expect(clone._material).toBe(material);
        expect(clone.name).toBe("statue_clone");
        expect(clone.visible).toBe(false);
        expect(clone.screenSpaceError).toBe(0.5);
        expect(clone._instanceId).toBe(1);
        expect(clone._selectionVersion).toBeUndefined();
        expect(clone.parent).toBe(clonedRoot);
        expect(Array.from(clone.worldMatrix)).toEqual(Array.from(source.worldMatrix));
        expect(clone.position).not.toBe(source.position);
        expect(clone.rotationQuaternion).not.toBe(source.rotationQuaternion);
        expect(clone.scaling).not.toBe(source.scaling);
        if (rawMatrix) {
            expect(clone._localMatrix).not.toBe(source._localMatrix);
            expect(Array.from(clone._localMatrix!)).toEqual(Array.from(source._localMatrix!));
            expect(clone._localMatrixLocked).toBe(true);
        }
        expect(clone.children).toHaveLength(1);
        expect(clone.children[0]).not.toBe(source.children[0]);
        expect(clone.children[0]!.parent).toBe(clone);
        const second = cloneTransformNode(clone) as MeshLoDInstance;
        expect(second._instanceId).toBe(2);
        expect(second.asset).toBe(asset);
        clone.position.x = 99;
        expect(source.position.x).toBe(1);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid instance SSE %s before incrementing ids", (screenSpaceError) => {
        const asset = makeFakeAsset();
        expect(() => createMeshLoDInstance(asset, {} as PbrMaterialProps, { screenSpaceError })).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        expect(asset._runtime.nextInstanceId).toBe(0);
    });
});

describe("asset setters and lifecycle", () => {
    it("mutates runtime settings/flags", () => {
        const asset = makeFakeAsset();
        setMeshLoDScreenSpaceError(asset, 8);
        setMeshLoDCacheBudget(asset, 2 * MIB);
        setMeshLoDStreamingPaused(asset, true);
        setMeshLoDDebugView(asset, "lod-depth");
        setMeshLoDSelectionMode(asset, "cpu");
        expect(asset._runtime.settings.screenSpaceError).toBe(8);
        expect(asset._runtime.settings.cacheBudgetBytes).toBe(2 * MIB);
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

    it("bounds the budget by the actual arena even when capacity settings are stale", () => {
        const asset = makeFakeAsset();
        asset._runtime.settings.cacheCapacityBytes = 128 * MIB;
        expect(() => setMeshLoDCacheBudget(asset, 4 * MIB + 1)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        expect(asset._runtime.settings.cacheBudgetBytes).toBe(4 * MIB);
    });

    it("rejects budgets below pinned residency without mutating the effective budget", () => {
        const asset = makeFakeAsset();
        const before = asset._runtime.settings.cacheBudgetBytes;
        expect(() => setMeshLoDCacheBudget(asset, 2 * 65536 - 1)).toThrowError(expect.objectContaining({ code: "MLOD_BUDGET_TOO_SMALL" }));
        expect(asset._runtime.settings.cacheBudgetBytes).toBe(before);
        setMeshLoDCacheBudget(asset, 2 * 65536);
        expect(asset._runtime.settings.cacheBudgetBytes).toBe(2 * 65536);
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
