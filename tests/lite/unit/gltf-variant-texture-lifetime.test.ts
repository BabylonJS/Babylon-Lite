import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetContainer } from "../../../packages/babylon-lite/src/asset-container";
import type { PbrMaterialProps } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import { addToScene } from "../../../packages/babylon-lite/src/scene/scene-core";
import { removeFromScene } from "../../../packages/babylon-lite/src/scene/scene-remove";
import type { MaterialVariantData } from "../../../packages/babylon-lite/src/loader-gltf/material-variants";

const loadVariantMaterials = vi.hoisted(() => vi.fn());

vi.mock("../../../packages/babylon-lite/src/loader-gltf/gltf-variants.js", () => ({
    loadVariantMaterials,
}));

import feature from "../../../packages/babylon-lite/src/loader-gltf/gltf-feature-variants";

function fakeTexture(): Texture2D {
    return {
        texture: { destroy: vi.fn() } as unknown as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 1,
        height: 1,
    };
}

function fakeScene(): SceneContext {
    return {
        surface: { engine: { _retirements: null } },
        camera: null,
        lights: [],
        meshes: [],
        animationGroups: [],
        shadowGenerators: [],
        _beforeRender: [],
        _renderables: [],
        _materialSwapQueue: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _meshAuxDisposables: new Map(),
        _renderableVersion: 0,
        _disposables: [],
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
}

describe("KHR_materials_variants texture lifetime", () => {
    beforeEach(() => {
        loadVariantMaterials.mockReset();
    });

    it("keeps every variant texture alive across repeated switches until the container is removed", async () => {
        const original = fakeTexture();
        const midnight = fakeTexture();
        const beach = fakeTexture();
        const street = fakeTexture();
        const mesh = {} as never;
        const material = (texture: Texture2D): PbrMaterialProps => ({ baseColorTexture: texture }) as PbrMaterialProps;
        const materialVariants: MaterialVariantData = {
            names: ["midnight", "beach", "street"],
            originals: [{ mesh, material: material(original) }],
            variants: {
                midnight: [{ mesh, material: material(midnight) }],
                beach: [{ mesh, material: material(beach) }],
                street: [{ mesh, material: material(street) }],
            },
        };
        loadVariantMaterials.mockResolvedValue(materialVariants);

        const fragment = await feature.applyAsset!(
            [],
            null as never,
            {
                _json: { extensions: { KHR_materials_variants: { variants: materialVariants.names.map((name) => ({ name })) } } },
            } as never
        );
        const container = { entities: [], ...fragment } as AssetContainer;
        const scene = fakeScene();
        addToScene(scene, container);

        for (const texture of [midnight, beach, street, midnight]) {
            acquireTexture(texture);
            expect(releaseTexture(texture)).toBe(false);
            expect(texture.texture.destroy).not.toHaveBeenCalled();
        }

        removeFromScene(scene, container);
        for (const texture of [original, midnight, beach, street]) {
            expect(texture.texture.destroy).toHaveBeenCalledTimes(1);
        }
    });
});
