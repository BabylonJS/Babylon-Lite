/** MeshLoD scene registry unit tests (Task 4.3).
 *
 *  Exercise the scene-owned batching, idempotent add/remove, cross-scene sharing,
 *  one-way ownership, and the supported-material gate — all without a WebGPU
 *  device. The registry lives only on `SceneContext`; assets and instances never
 *  reference a scene. */

import { describe, expect, it } from "vitest";
import { addMeshLoDInstanceToScene, getMeshLoDSelectionCamera, removeMeshLoDInstanceFromScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { createMeshLoDInstance } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createSolidTexture2D } from "../../../../packages/babylon-lite/src/texture/solid-texture.js";
import { cloneTexture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d.js";
import { createMockEngine } from "./fixtures/gpu-mock.js";

function fakeScene(): SceneContext {
    return { _deferredBuilders: [] } as unknown as SceneContext;
}

function fakeAsset(): MeshLoDAsset {
    return { _runtime: { nextInstanceId: 0 } } as unknown as MeshLoDAsset;
}

const supported = (): PbrMaterialProps => ({}) as PbrMaterialProps;

describe("MeshLoD scene registry — batching", () => {
    it("groups two instances of one asset + material into a single batch", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        const a = createMeshLoDInstance(asset, material);
        const b = createMeshLoDInstance(asset, material);
        a.position.set(1, 0, 0);
        b.position.set(-1, 0, 0);
        addMeshLoDInstanceToScene(scene, a);
        addMeshLoDInstanceToScene(scene, b);

        const registry = scene._meshLoDRegistry!;
        expect(registry.batches).toHaveLength(1);
        expect(registry.batches[0]!.instances).toEqual([a, b]);
        expect(registry.batches[0]!.asset).toBe(asset);
        expect(registry.batches[0]!.material).toBe(material);
        // Independent transforms are preserved on the plain SceneNode instances.
        expect(a.position.x).toBe(1);
        expect(b.position.x).toBe(-1);
    });

    it("keys batches by exact material object identity", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const m1 = supported();
        const m2 = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, m1));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, m2));
        expect(scene._meshLoDRegistry!.batches).toHaveLength(2);
    });

    it("registers exactly one deferred builder per scene regardless of add count", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(), supported()));
        expect(scene._deferredBuilders).toHaveLength(1);
        expect(scene._meshLoDRegistry!.builderRegistered).toBe(true);
    });

    it("rejects new asset/material batches after registration while accepting existing batches", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        const registry = scene._meshLoDRegistry!;
        registry.batches[0]!.renderable = {} as NonNullable<(typeof registry.batches)[0]["renderable"]>;
        scene._built = true;
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        expect(registry.batches[0]!.instances).toHaveLength(2);
        for (const different of [createMeshLoDInstance(asset, supported()), createMeshLoDInstance(fakeAsset(), material)]) {
            expect(() => addMeshLoDInstanceToScene(scene, different)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        }
        expect(registry.batches).toHaveLength(1);
        expect(scene._deferredBuilders).toHaveLength(1);
    });

    it("rejects a pre-registered batch that had no renderable when its first instance arrives late", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        const first = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(scene, first);
        removeMeshLoDInstanceFromScene(scene, first);
        scene._built = true;
        expect(() => addMeshLoDInstanceToScene(scene, first)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
    });
});

describe("MeshLoD selection camera", () => {
    it("uses the effective orthographic vertical extent and viewport pixels", () => {
        const camera = {
            worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
            fov: 1,
            nearPlane: 0.1,
            viewport: { x: 0, y: 0, width: 0.5, height: 0.75 },
            ortho: { halfHeight: 20, top: 5, bottom: -15, left: null, right: null },
        } as unknown as Camera;
        const dimensions = { targetWidth: 800, targetHeight: 600 };
        expect(getMeshLoDSelectionCamera(camera, dimensions as never)).toMatchObject({ position: [4, 5, 6], targetWidth: 400, targetHeight: 450, orthographicHeight: 20 });
        camera.ortho!.top = null;
        camera.ortho!.bottom = null;
        expect(getMeshLoDSelectionCamera(camera, dimensions as never).orthographicHeight).toBe(40);
    });
});

describe("MeshLoD scene registry — idempotent add/remove", () => {
    it("adds the same instance once and removes it idempotently", () => {
        const scene = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        const instance = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(scene, instance);
        addMeshLoDInstanceToScene(scene, instance);
        expect(scene._meshLoDRegistry!.batches[0]!.instances).toEqual([instance]);

        removeMeshLoDInstanceFromScene(scene, instance);
        expect(scene._meshLoDRegistry!.batches[0]!.instances).toEqual([]);
        // A second remove is a no-op.
        removeMeshLoDInstanceFromScene(scene, instance);
        expect(scene._meshLoDRegistry!.batches[0]!.instances).toEqual([]);
    });

    it("removes cleanly before any registry exists", () => {
        const scene = fakeScene();
        const instance = createMeshLoDInstance(fakeAsset(), supported());
        expect(() => removeMeshLoDInstanceFromScene(scene, instance)).not.toThrow();
    });
});

describe("MeshLoD scene registry — one-way ownership", () => {
    it("lets two scenes share one asset with independent registries and no back-references", () => {
        const sceneA = fakeScene();
        const sceneB = fakeScene();
        const asset = fakeAsset();
        const material = supported();
        const a = createMeshLoDInstance(asset, material);
        const b = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(sceneA, a);
        addMeshLoDInstanceToScene(sceneB, b);

        expect(sceneA._meshLoDRegistry).not.toBe(sceneB._meshLoDRegistry);
        expect(sceneA._meshLoDRegistry!.batches[0]!.instances).toEqual([a]);
        expect(sceneB._meshLoDRegistry!.batches[0]!.instances).toEqual([b]);
        // Neither the asset nor the instances carry a scene reference.
        expect((asset as unknown as Record<string, unknown>).scene).toBeUndefined();
        expect((a as unknown as Record<string, unknown>).scene).toBeUndefined();
    });
});

describe("MeshLoD scene registry — material gate", () => {
    it("rejects material-side V-flips instead of sampling an inverted texture", () => {
        const { engine } = createMockEngine();
        const texture = createSolidTexture2D(engine, 1, 1, 1);
        texture.invertY = true;
        const material = createPbrMaterial({ baseColorTexture: texture });
        expect(() => addMeshLoDInstanceToScene(fakeScene(), createMeshLoDInstance(fakeAsset(), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL" })
        );
    });

    it.each(["baseColorTexture", "normalTexture", "ormTexture", "emissiveTexture"] as const)("rejects transforms on %s without relying on the material flag", (channel) => {
        const { engine } = createMockEngine();
        const texture = createSolidTexture2D(engine, 1, 1, 1);
        for (const transform of [{ uScale: 2 }, { uOffset: 0.25 }, { uAng: 0.5 }]) {
            const material = createPbrMaterial({ [channel]: cloneTexture2D(texture, transform) });
            const instance = createMeshLoDInstance(fakeAsset(), material);
            expect(() => addMeshLoDInstanceToScene(fakeScene(), instance)).toThrowError(expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL" }));
        }
        const material = createPbrMaterial({ [channel]: texture });
        expect(() => addMeshLoDInstanceToScene(fakeScene(), createMeshLoDInstance(fakeAsset(), material))).not.toThrow();
    });

    it.each([
        ["clearcoat", { _clearCoat: { isEnabled: true } }],
        ["alpha blending", { alphaBlend: true }],
        ["alpha masking", { _alphaCutOff: 0.5 }],
        ["transmission", { _transmissive: true }],
        ["a second UV set", { occlusionTexCoord: 1 }],
        ["UV-transform opt-in", { _hasUvTx: true }],
    ])("rejects %s with MLOD_UNSUPPORTED_MATERIAL", (_name, material) => {
        const scene = fakeScene();
        const asset = fakeAsset();
        try {
            // Rejection may come from createMeshLoDInstance (alphaBlend) or the scene gate.
            const instance = createMeshLoDInstance(asset, material as unknown as PbrMaterialProps);
            addMeshLoDInstanceToScene(scene, instance);
            throw new Error("expected rejection");
        } catch (error) {
            expect(isMeshLoDError(error) && error.code).toBe("MLOD_UNSUPPORTED_MATERIAL");
        }
    });
});
