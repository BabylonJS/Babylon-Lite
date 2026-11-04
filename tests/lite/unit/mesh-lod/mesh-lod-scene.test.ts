/** MeshLoD scene registry unit tests (Task 4.3).
 *
 *  Exercise the scene-owned batching, idempotent add/remove, cross-scene sharing,
 *  one-way ownership, and the supported-material gate — all without a WebGPU
 *  device. The registry lives only on `SceneContext`; assets and instances never
 *  reference a scene. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMeshLoDInstanceToScene, getMeshLoDSelectionCamera, removeMeshLoDInstanceFromScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { addMeshLoDToScene, createMeshLoDInstance, loadMeshLoD } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { isMeshLoDError } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-errors.js";
import type { MeshLoDAsset } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { PbrMaterialProps } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import type { StencilState } from "../../../../packages/babylon-lite/src/material/material.js";
import type { Camera } from "../../../../packages/babylon-lite/src/camera/camera.js";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { setPbrGammaAlbedo } from "../../../../packages/babylon-lite/src/material/pbr/set-gamma-albedo.js";
import { setPbrLightmap } from "../../../../packages/babylon-lite/src/material/pbr/enable-pbr-lightmap.js";
import { setPbrMetallicReflectance } from "../../../../packages/babylon-lite/src/material/pbr/set-metallic-reflectance.js";
import type { MetallicReflectanceOptions } from "../../../../packages/babylon-lite/src/material/pbr/set-metallic-reflectance.js";
import { createSolidTexture2D } from "../../../../packages/babylon-lite/src/texture/solid-texture.js";
import { cloneTexture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d.js";
import { createFillDecoder, createMockEngine } from "./fixtures/gpu-mock.js";
import { buildMinimalContainer } from "./fixtures/mlod-fixture.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { createXrCamera, updateXrCameraForView } from "../../../../packages/babylon-lite/src/xr/xr-camera.js";

function fakeScene(engine: EngineContext = createMockEngine().engine): SceneContext {
    return { _deferredBuilders: [], _renderables: [], _disposables: [], surface: { engine } } as unknown as SceneContext;
}

function fakeAsset(scene: SceneContext): MeshLoDAsset {
    return { _runtime: { nextInstanceId: 0, engine: scene.surface.engine } } as unknown as MeshLoDAsset;
}

const supported = (): PbrMaterialProps => ({}) as PbrMaterialProps;

describe("MeshLoD scene registry — batching", () => {
    it("groups two instances of one asset + material into a single batch", () => {
        const scene = fakeScene();
        const asset = fakeAsset(scene);
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
        const asset = fakeAsset(scene);
        const m1 = supported();
        const m2 = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, m1));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, m2));
        expect(scene._meshLoDRegistry!.batches).toHaveLength(2);
    });

    it("registers exactly one deferred builder per scene regardless of add count", () => {
        const scene = fakeScene();
        const asset = fakeAsset(scene);
        const material = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), supported()));
        expect(scene._deferredBuilders).toHaveLength(1);
        expect(scene._meshLoDRegistry!.builderRegistered).toBe(true);
    });

    it("rejects new asset/material batches after registration while accepting existing batches", () => {
        const scene = fakeScene();
        const asset = fakeAsset(scene);
        const material = supported();
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        const registry = scene._meshLoDRegistry!;
        registry.batches[0]!.renderable = {} as NonNullable<(typeof registry.batches)[0]["renderable"]>;
        scene._built = true;
        addMeshLoDInstanceToScene(scene, createMeshLoDInstance(asset, material));
        expect(registry.batches[0]!.instances).toHaveLength(2);
        for (const different of [createMeshLoDInstance(asset, supported()), createMeshLoDInstance(fakeAsset(scene), material)]) {
            expect(() => addMeshLoDInstanceToScene(scene, different)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        }
        expect(registry.batches).toHaveLength(1);
        expect(scene._deferredBuilders).toHaveLength(1);
    });

    it("rejects a pre-registered batch that had no renderable when its first instance arrives late", () => {
        const scene = fakeScene();
        const asset = fakeAsset(scene);
        const material = supported();
        const first = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(scene, first);
        removeMeshLoDInstanceFromScene(scene, first);
        scene._built = true;
        expect(() => addMeshLoDInstanceToScene(scene, first)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
    });
});

describe("MeshLoD selection camera", () => {
    it.each([0.75, 3])("uses injected XR projection scale %s instead of the advisory FOV", (verticalScale) => {
        const camera = createXrCamera("left");
        const projection = new Float32Array([1, 0, 0, 0, 0, verticalScale, 0, 0, 0.2, -0.1, -1, -1, 0, 0, -0.1, 0]);
        const pose = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, -6, 1]);
        const viewport = { x: 0.25, y: 0.125, width: 0.5, height: 0.75 };
        updateXrCameraForView(camera, { transform: { matrix: pose }, projectionMatrix: projection } as unknown as XRView, 800, 600, viewport);
        expect(camera.fov).toBe(1);
        const selected = getMeshLoDSelectionCamera(camera, { targetWidth: 800, targetHeight: 600, _camera: camera });
        expect(selected).toMatchObject({ position: [4, 5, 6], targetWidth: 400, targetHeight: 450, perspectivePixelScale: Math.fround((450 * verticalScale) / 2) });
        expect(camera._projCache[5]).toBe(verticalScale);
    });

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
        const asset = fakeAsset(scene);
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
        const instance = createMeshLoDInstance(fakeAsset(scene), supported());
        expect(() => removeMeshLoDInstanceFromScene(scene, instance)).not.toThrow();
    });
});

describe("MeshLoD scene registry — one-way ownership", () => {
    it("lets two scenes share one asset with independent registries and no back-references", () => {
        const sceneA = fakeScene();
        const sceneB = fakeScene(sceneA.surface.engine);
        const asset = fakeAsset(sceneA);
        const material = supported();
        const a = createMeshLoDInstance(asset, material);
        const b = createMeshLoDInstance(asset, material);
        addMeshLoDInstanceToScene(sceneA, a);
        addMeshLoDInstanceToScene(sceneB, b);

        expect(sceneA._meshLoDRegistry).not.toBe(sceneB._meshLoDRegistry);
        expect(sceneA.surface).not.toBe(sceneB.surface);
        expect(sceneA._meshLoDRegistry!.batches[0]!.instances).toEqual([a]);
        expect(sceneB._meshLoDRegistry!.batches[0]!.instances).toEqual([b]);
        // Neither the asset nor the instances carry a scene reference.
        expect((asset as unknown as Record<string, unknown>).scene).toBeUndefined();
        expect((a as unknown as Record<string, unknown>).scene).toBeUndefined();
    });
});

describe.each(["cpu", "gpu"] as const)("MeshLoD scene registry — engine ownership (%s)", (selectionMode) => {
    beforeEach(() => {
        _setMeshLoDPageDecoder(createFillDecoder().decoder);
    });
    afterEach(() => {
        _setMeshLoDPageDecoder(null);
    });

    it.each([false, true])("rejects another engine without changing either scene or the asset (destination populated: %s)", async (populated) => {
        const original = createMockEngine();
        const other = createMockEngine();
        const asset = await loadMeshLoD(original.engine, buildMinimalContainer().bytes.slice().buffer as ArrayBuffer, { selectionMode });
        const material = createPbrMaterial();
        const instance = createMeshLoDInstance(asset, material);
        const sceneA = fakeScene(original.engine);
        const sceneB = fakeScene(other.engine);
        addMeshLoDToScene(sceneA, instance);
        if (populated) {
            addMeshLoDInstanceToScene(sceneB, createMeshLoDInstance(fakeAsset(sceneB), material));
        }
        const sceneABefore = { ...sceneA, _deferredBuilders: [...sceneA._deferredBuilders] };
        const sceneBBefore = { ...sceneB, _deferredBuilders: [...sceneB._deferredBuilders] };
        const batchesBefore = sceneB._meshLoDRegistry?.batches.slice();
        const assetBefore = { ...asset };
        const runtimeBefore = { ...asset._runtime };
        const diagnosticsBefore = { ...asset.diagnostics };
        const gpuBefore = { ...asset._runtime.gpu };
        const originalBuffers = [...original.device.buffers];
        const originalWrites = [...original.device.writes];

        expect(() => addMeshLoDToScene(sceneB, instance)).toThrowError(expect.objectContaining({ name: "MeshLoDError", code: "MLOD_INVALID_OPTION" }));
        expect(sceneA).toEqual(sceneABefore);
        expect(sceneB).toEqual(sceneBBefore);
        expect(sceneA._meshLoDRegistry!.batches[0]!.instances).toEqual([instance]);
        expect(sceneB._meshLoDRegistry?.batches).toEqual(batchesBefore);
        expect(sceneB._meshLoDRegistry?.byAsset.has(asset)).not.toBe(true);
        expect(asset).toEqual(assetBefore);
        expect(asset._runtime).toEqual(runtimeBefore);
        expect(asset.diagnostics).toEqual(diagnosticsBefore);
        expect(asset._runtime.gpu).toEqual(gpuBefore);
        expect(asset._runtime.engine).toBe(original.engine);
        expect(original.device.buffers).toEqual(originalBuffers);
        expect(original.device.writes).toEqual(originalWrites);
        expect(other.device.buffers).toEqual([]);
        expect(other.device.writes).toEqual([]);
        expect(original.engine._retirements).toBeNull();
        expect(other.engine._retirements).toBeNull();

        const sameDeviceScene = fakeScene(createMockEngine(original.device).engine);
        expect(() => addMeshLoDToScene(sameDeviceScene, instance)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION" }));
        expect(sameDeviceScene._meshLoDRegistry).toBeUndefined();
        expect(sameDeviceScene._deferredBuilders).toEqual([]);

        const sharedScene = fakeScene(original.engine);
        expect(sharedScene.surface).not.toBe(sceneA.surface);
        addMeshLoDToScene(sharedScene, instance);
        expect(sharedScene._meshLoDRegistry!.batches[0]!.instances).toEqual([instance]);
        for (const scene of [sceneA, sharedScene]) {
            for (const builder of scene._deferredBuilders) {
                await builder();
            }
            expect(scene._renderables).toHaveLength(1);
        }
        expect(asset.state).toBe("ready");
    });
});

describe("MeshLoD scene registry — material gate", () => {
    it.each<StencilState>([{ compare: "equal" }, { compare: "always", passOp: "increment-clamp" }, {}])(
        "rejects any assigned stencil state before installing a scene batch (%j)",
        (stencil) => {
            const scene = fakeScene();
            const material = createPbrMaterial({ stencil });
            expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
                expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "material stencil state" })
            );
            expect(scene._meshLoDRegistry).toBeUndefined();
            expect(scene._deferredBuilders).toHaveLength(0);
        }
    );

    it("rejects floating-origin engines before installing a scene batch", () => {
        const scene = fakeScene();
        scene.surface.engine.useFloatingOrigin = true;
        const instance = createMeshLoDInstance(fakeAsset(scene), createPbrMaterial());
        instance.position.set(1e7 + 2, 0, 0);
        expect(() => addMeshLoDInstanceToScene(scene, instance)).toThrowError(expect.objectContaining({ code: "MLOD_INVALID_OPTION", actual: "useFloatingOrigin: true" }));
        expect(scene._meshLoDRegistry).toBeUndefined();
        expect(scene._deferredBuilders).toHaveLength(0);
    });

    it("rejects a UV0 lightmap configured through the public setter", () => {
        const material = createPbrMaterial();
        const { engine } = createMockEngine();
        const scene = fakeScene(engine);
        setPbrLightmap(material, createSolidTexture2D(engine, 1, 1, 1), { coordIndex: 0 });
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "lightmaps" })
        );
    });

    it.each<MetallicReflectanceOptions>([{ f0Factor: 0 }, { specularWeight: 0 }, { color: [0.2, 0.4, 0.6] }, { useOnlyMetallicFromTexture: false }])(
        "rejects explicit dielectric-reflectance state including zero/false (%j)",
        (options) => {
            const material = createPbrMaterial();
            const scene = fakeScene();
            setPbrMetallicReflectance(material, options);
            expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
                expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "dielectric-reflectance extensions" })
            );
        }
    );

    it.each(["texture", "reflectanceTexture"] as const)("rejects the dielectric-reflectance %s channel", (channel) => {
        const material = createPbrMaterial();
        const { engine } = createMockEngine();
        const scene = fakeScene(engine);
        setPbrMetallicReflectance(material, { [channel]: createSolidTexture2D(engine, 1, 1, 1) });
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "dielectric-reflectance extensions" })
        );
    });

    it("rejects the public gamma-albedo opt-in with an explicit unsupported-material error", () => {
        const material = createPbrMaterial();
        const scene = fakeScene();
        setPbrGammaAlbedo(material);
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "gamma-albedo decoding" })
        );
    });
    it("rejects material-side V-flips instead of sampling an inverted texture", () => {
        const { engine } = createMockEngine();
        const scene = fakeScene(engine);
        const texture = createSolidTexture2D(engine, 1, 1, 1);
        texture.invertY = true;
        const material = createPbrMaterial({ baseColorTexture: texture });
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL" })
        );
    });

    it.each(["baseColorTexture", "normalTexture", "ormTexture", "emissiveTexture"] as const)("rejects transforms on %s without relying on the material flag", (channel) => {
        const { engine } = createMockEngine();
        const scene = fakeScene(engine);
        const texture = createSolidTexture2D(engine, 1, 1, 1);
        for (const transform of [{ uScale: 2 }, { uOffset: 0.25 }, { uAng: 0.5 }]) {
            const material = createPbrMaterial({ [channel]: cloneTexture2D(texture, transform) });
            const instance = createMeshLoDInstance(fakeAsset(scene), material);
            expect(() => addMeshLoDInstanceToScene(scene, instance)).toThrowError(expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL" }));
        }
        const material = createPbrMaterial({ [channel]: texture });
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).not.toThrow();
    });

    it.each([undefined, false])("rejects alpha-only transparency even when alphaBlend is %s", (alphaBlend) => {
        const material = createPbrMaterial({ alpha: 0.5, alphaBlend });
        const scene = fakeScene();
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), material))).toThrowError(
            expect.objectContaining({ code: "MLOD_UNSUPPORTED_MATERIAL", actual: "alpha blending" })
        );
        expect(scene._meshLoDRegistry).toBeUndefined();
        expect(() => addMeshLoDInstanceToScene(scene, createMeshLoDInstance(fakeAsset(scene), createPbrMaterial({ alpha: 1, alphaBlend })))).not.toThrow();
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
        const asset = fakeAsset(scene);
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
