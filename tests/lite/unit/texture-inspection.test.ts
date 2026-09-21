import { beforeEach, describe, expect, it, vi } from "vitest";

import { acquireTexture, inspectTexture, releaseTexture, setTextureInspectionTransform } from "../../../packages/babylon-lite/src";
import { createPbrMaterial } from "../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { createStandardMaterial } from "../../../packages/babylon-lite/src/material/standard/create-standard-material";
import { createMaterialView } from "../../../packages/babylon-lite/src/material/material-view";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { Texture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";

const mutationApis = vi.hoisted(() => ({
    enableUvTransform: vi.fn((material: { _hasUvTx?: boolean; _renderFeatures?: unknown }) => {
        const firstBuild = material._renderFeatures === undefined;
        material._hasUvTx = true;
        return firstBuild;
    }),
    markDirty: vi.fn(),
    rebuild: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("../../../packages/babylon-lite/src/material/enable-material-uv-transform", () => ({
    enableMaterialUvTransform: mutationApis.enableUvTransform,
}));
vi.mock("../../../packages/babylon-lite/src/material/material-dirty", () => ({
    markMaterialUboDirty: mutationApis.markDirty,
}));
vi.mock("../../../packages/babylon-lite/src/material/material-rebuild", () => ({
    rebuildMaterial: mutationApis.rebuild,
}));

const textureUsage = {
    sampled: 4,
    renderAttachment: 16,
};

function texture2D(overrides: Record<string, unknown> = {}): Texture2D {
    const texture = {
        width: 32,
        height: 16,
        mipLevelCount: 6,
        format: "rgba8unorm-srgb",
        usage: textureUsage.sampled | textureUsage.renderAttachment,
        label: "",
    };
    return {
        texture: texture as unknown as GPUTexture,
        view: { rawView: true } as unknown as GPUTextureView,
        sampler: { rawSampler: true } as unknown as GPUSampler,
        width: 32,
        height: 16,
        ...overrides,
    } as unknown as Texture2D;
}

function scene(...materials: Material[]): SceneContext {
    return { meshes: materials.map((material) => ({ material })) } as unknown as SceneContext;
}

function transform(overrides: Partial<{ uOffset: number; vOffset: number; uScale: number; vScale: number; uAng: number }> = {}) {
    return { uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0, ...overrides };
}

beforeEach(() => {
    mutationApis.enableUvTransform.mockClear();
    mutationApis.markDirty.mockClear();
    mutationApis.rebuild.mockClear();
});

describe("inspectTexture", () => {
    it("normalizes safe 2D metadata without exposing backing handles", () => {
        const texture = texture2D({
            name: "Albedo",
            _recoverySource: {
                kind: "url",
                url: "private://asset.png",
                opts: { addressModeU: "mirror-repeat", mipMaps: true, srgb: true },
            },
            uOffset: 0.25,
            vScale: 2,
            uAng: Math.PI / 4,
        });

        const inspection = inspectTexture(texture);

        expect(inspection).toMatchObject({
            kind: "2d",
            displayName: { state: "known", value: "Albedo" },
            origin: { state: "known", value: "url-raster" },
            width: 32,
            height: 16,
            depthOrLayers: { state: "known", value: 1 },
            sampleCategory: "float",
            format: { state: "known", value: "rgba8unorm-srgb" },
            mipLevelCount: { state: "known", value: 6 },
            colorSpace: "srgb",
            invertY: { state: "present", value: false },
            sampler: {
                addressModeU: { state: "known", value: "mirror-repeat" },
                addressModeV: { state: "known", value: "repeat" },
                addressModeW: { state: "known", value: "clamp-to-edge" },
                magFilter: { state: "known", value: "linear" },
                minFilter: { state: "known", value: "linear" },
                mipmapFilter: { state: "known", value: "linear" },
                maxAnisotropy: { state: "known", value: 4 },
            },
            transform: {
                state: "present",
                value: { uOffset: 0.25, vOffset: 0, uScale: 1, vScale: 2, uAng: Math.PI / 4 },
            },
            capabilities: {
                dynamicUpdate: { state: "known", value: false },
                renderAttachment: { state: "known", value: true },
                sampledDepth: false,
            },
        });
        expect(JSON.stringify(inspection)).not.toContain("private://");
        expect(inspection).not.toHaveProperty("texture");
        expect(inspection).not.toHaveProperty("view");
        expect(inspection?.sampler).not.toHaveProperty("rawSampler");
    });

    it("reports conservative unknowns when provenance and sampler descriptors are not retained", () => {
        const texture = texture2D({
            texture: {
                width: 0,
                height: 0,
                mipLevelCount: 1,
                format: "rgba32float",
            },
            width: 0,
            height: 0,
        });

        expect(inspectTexture(texture)).toMatchObject({
            kind: "2d",
            origin: { state: "known", value: "unknown" },
            width: 0,
            height: 0,
            sampleCategory: "unfilterable-float",
            colorSpace: "linear",
            sampler: {
                addressModeU: { state: "unknown" },
                minFilter: { state: "unknown" },
            },
            capabilities: {
                renderAttachment: { state: "unknown" },
                dynamicUpdate: { state: "unknown" },
                released: { state: "unknown" },
            },
        });
    });

    it("covers dynamic, HTML, render-target, and sampled-depth facades", () => {
        const dynamic = texture2D({
            _recoverySource: {
                kind: "dynamic",
                width: 32,
                height: 16,
                format: "rgba8unorm",
                levels: 1,
                samplerDesc: { addressModeU: "repeat", minFilter: "linear" },
                source: null,
                flipY: false,
                premultipliedAlpha: false,
            },
        });
        const html = texture2D({
            _element: { privateDom: true },
            _readyState: "ready",
            _disposed: false,
            _recoverySource: dynamic._recoverySource,
        });
        const renderTarget = texture2D({
            invertY: true,
            _recoverySource: {
                kind: "render",
                width: 32,
                height: 16,
                format: "rgba8unorm",
                samplerDesc: { magFilter: "linear", minFilter: "linear" },
            },
        });
        const depth = texture2D({
            _sampleType: "depth",
            texture: { width: 32, height: 16, mipLevelCount: 1, format: "depth32float", usage: textureUsage.sampled },
        });

        expect(inspectTexture(dynamic)).toMatchObject({
            origin: { state: "known", value: "dynamic" },
            capabilities: { dynamicUpdate: { state: "known", value: true } },
        });
        expect(inspectTexture(html)).toMatchObject({
            origin: { state: "known", value: "html" },
            capabilities: {
                dynamicUpdate: { state: "known", value: true },
                htmlReadiness: { state: "known", value: "ready" },
                released: { state: "known", value: false },
            },
        });
        expect(JSON.stringify(inspectTexture(html))).not.toContain("privateDom");
        expect(inspectTexture(renderTarget)).toMatchObject({
            origin: { state: "known", value: "render-target" },
            invertY: { state: "present", value: true },
            transform: { state: "unsupported" },
        });
        expect(inspectTexture(depth)).toMatchObject({
            origin: { state: "known", value: "sampled-depth" },
            sampleCategory: "depth",
            colorSpace: "unknown",
            transform: { state: "unsupported" },
            capabilities: { sampledDepth: true },
        });
    });

    it("reports arrays, 3D textures, and cubes without exposing unsupported transforms", () => {
        const array = { ...texture2D(), layers: 5 } as Texture2DArray;
        const volume = { ...texture2D(), depth: 9 } as Texture2D & { depth: number };
        const cube = {
            _texture: {
                width: 64,
                height: 64,
                depthOrArrayLayers: 6,
                mipLevelCount: 7,
                format: "rgba16float",
                usage: textureUsage.sampled | textureUsage.renderAttachment,
                secretHandle: true,
            },
            _view: { secretView: true },
            _sampler: { secretSampler: true },
        } as unknown as CubeTexture;

        expect(inspectTexture(array)).toMatchObject({
            kind: "2d-array",
            depthOrLayers: { state: "known", value: 5 },
            transform: { state: "unsupported" },
            invertY: { state: "unsupported" },
        });
        expect(inspectTexture(volume)).toMatchObject({
            kind: "3d",
            depthOrLayers: { state: "known", value: 9 },
            transform: { state: "unsupported" },
        });
        expect(inspectTexture(cube)).toMatchObject({
            kind: "cube",
            width: 64,
            height: 64,
            depthOrLayers: { state: "known", value: 6 },
            format: { state: "known", value: "rgba16float" },
            transform: { state: "unsupported" },
            sampler: {
                addressModeU: { state: "known", value: "clamp-to-edge" },
                mipmapFilter: { state: "known", value: "linear" },
            },
        });
        expect(JSON.stringify(inspectTexture(cube))).not.toContain("secret");
    });

    it("uses exact wrapper state for clones and safely rejects malformed values", () => {
        const base = texture2D({ uOffset: 0.1 });
        const clone = { ...base, uOffset: 0.8 };
        const throwing = new Proxy(
            {},
            {
                has() {
                    throw new Error("transient");
                },
            }
        );

        expect(inspectTexture(base)?.transform).toEqual({ state: "present", value: transform({ uOffset: 0.1 }) });
        expect(inspectTexture(clone)?.transform).toEqual({ state: "present", value: transform({ uOffset: 0.8 }) });
        expect(inspectTexture(null)).toBeUndefined();
        expect(inspectTexture({ texture: {}, view: {}, sampler: {}, width: Number.NaN, height: 1 })).toBeUndefined();
        expect(inspectTexture(texture2D({ uScale: Number.NaN }))?.transform).toMatchObject({ state: "unsupported" });
        expect(inspectTexture(throwing)).toBeUndefined();
    });

    it("reports retained release state without exposing the reference store", () => {
        const destroy = vi.fn();
        const texture = texture2D({
            texture: {
                width: 4,
                height: 4,
                mipLevelCount: 1,
                format: "rgba8unorm",
                usage: textureUsage.sampled,
                destroy,
            },
            width: 4,
            height: 4,
        });

        acquireTexture(texture);
        expect(inspectTexture(texture)?.capabilities.released).toEqual({ state: "known", value: false });
        expect(releaseTexture(texture)).toBe(true);
        expect(inspectTexture(texture)?.capabilities.released).toEqual({ state: "known", value: true });
        expect(destroy).toHaveBeenCalledOnce();
    });
});

describe("setTextureInspectionTransform", () => {
    it("mutates the exact wrapper once and deduplicates sources, views, and owning scenes", async () => {
        const texture = texture2D();
        const siblingClone = { ...texture };
        const standard = createStandardMaterial();
        standard.diffuseTexture = texture;
        standard._emissiveTexture = siblingClone;
        const standardView = createMaterialView(standard, { features: 0 });
        const pbr = createPbrMaterial({ baseColorTexture: texture, _hasUvTx: true });
        const pbrView = createMaterialView(pbr, { features: 0 });
        const first = scene(standard, standardView, pbrView);
        const second = scene(standardView, pbr);
        const foreign = scene(standard);

        const pending = setTextureInspectionTransform({ scenes: [first, first, second] }, texture, transform({ uOffset: 0.5, uAng: Math.PI * 3 }));
        await pending;

        expect(texture).toMatchObject({ uOffset: 0.5, uAng: Math.PI * 3 });
        expect(siblingClone.uOffset).toBeUndefined();
        expect(mutationApis.enableUvTransform).toHaveBeenCalledTimes(2);
        expect(mutationApis.markDirty).toHaveBeenCalledTimes(1);
        expect(mutationApis.rebuild.mock.calls.map((call) => call[0])).toEqual([first, second]);
        expect(mutationApis.rebuild).not.toHaveBeenCalledWith(foreign, expect.anything(), expect.anything());
        expect(await pending).toEqual({ changed: true, mutation: "R", postMutation: "rebuild-material" });
    });

    it("uses U before first PBR build and escalates to R when transform support must be compiled", async () => {
        const texture = texture2D();
        const firstBuild = createPbrMaterial({ baseColorTexture: texture });

        await expect(setTextureInspectionTransform({ scenes: [scene(firstBuild)] }, texture, transform({ uScale: 2 }))).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(mutationApis.rebuild).not.toHaveBeenCalled();
        expect(mutationApis.markDirty).toHaveBeenCalledWith(firstBuild);

        const lateTexture = texture2D();
        const late = createPbrMaterial({ baseColorTexture: lateTexture, _renderFeatures: { features: 0 } });
        await expect(setTextureInspectionTransform({ scenes: [scene(late)] }, lateTexture, transform({ vScale: 3 }))).resolves.toEqual({
            changed: true,
            mutation: "R",
            postMutation: "rebuild-material",
        });
        expect(mutationApis.rebuild).toHaveBeenCalledTimes(1);

        mutationApis.rebuild.mockClear();
        const enabledTexture = texture2D();
        const enabled = createPbrMaterial({ baseColorTexture: enabledTexture, _hasUvTx: true, _renderFeatures: { features: 0 } });
        await expect(setTextureInspectionTransform({ scenes: [scene(enabled)] }, enabledTexture, transform({ vOffset: 0.25 }))).resolves.toEqual({
            changed: true,
            mutation: "U",
            postMutation: "none",
        });
        expect(mutationApis.rebuild).not.toHaveBeenCalled();
        expect(mutationApis.markDirty).toHaveBeenCalledWith(enabled);
    });

    it("no-ops repeated normalized commits without invalidation", async () => {
        const texture = texture2D();
        const material = createStandardMaterial();
        material.diffuseTexture = texture;
        const scope = { scenes: [scene(material)] };

        await setTextureInspectionTransform(scope, texture, transform({ uAng: Math.PI * 2, uOffset: -0 }));
        mutationApis.enableUvTransform.mockClear();
        mutationApis.markDirty.mockClear();
        mutationApis.rebuild.mockClear();

        await expect(setTextureInspectionTransform(scope, texture, transform({ uAng: Math.PI * 2 }))).resolves.toEqual({
            changed: false,
            mutation: "R",
            postMutation: "none",
        });
        expect(mutationApis.enableUvTransform).not.toHaveBeenCalled();
        expect(mutationApis.markDirty).not.toHaveBeenCalled();
        expect(mutationApis.rebuild).not.toHaveBeenCalled();
    });

    it("validates before writes and rejects unsupported or stale consumers", async () => {
        const texture = texture2D();
        const material = createStandardMaterial();
        material.diffuseTexture = texture;
        const owningScene = scene(material);

        await expect(setTextureInspectionTransform({ scenes: [owningScene] }, texture, transform({ uScale: Number.NaN }))).rejects.toThrow(/finite/);
        expect(texture.uScale).toBeUndefined();
        expect(mutationApis.enableUvTransform).not.toHaveBeenCalled();

        material.diffuseTexture = null;
        await expect(setTextureInspectionTransform({ scenes: [owningScene] }, texture, transform({ uOffset: 1 }))).rejects.toThrow(/no transform-capable/);

        const reflectionOnly = createStandardMaterial();
        reflectionOnly._reflectionTexture = texture;
        await expect(setTextureInspectionTransform({ scenes: [scene(reflectionOnly)] }, texture, transform({ uOffset: 1 }))).rejects.toThrow(/no transform-capable/);

        const array = { ...texture2D(), layers: 2 } as Texture2DArray;
        await expect(setTextureInspectionTransform({ scenes: [owningScene] }, array, transform({ uOffset: 1 }))).rejects.toThrow(/does not support/);
        await expect(setTextureInspectionTransform({ scenes: [{} as SceneContext] }, texture, transform({ uOffset: 1 }))).rejects.toThrow(/invalid scene/);
    });

    it("ignores foreign-scene consumers and rejects a scope with no local consumer", async () => {
        const texture = texture2D();
        const foreignMaterial = createStandardMaterial();
        foreignMaterial.diffuseTexture = texture;
        const unrelated = createPbrMaterial();

        await expect(setTextureInspectionTransform({ scenes: [scene(unrelated)] }, texture, transform({ vOffset: 0.5 }))).rejects.toThrow(/no transform-capable/);
        expect(mutationApis.rebuild).not.toHaveBeenCalled();
        expect(foreignMaterial.diffuseTexture).toBe(texture);
    });
});
