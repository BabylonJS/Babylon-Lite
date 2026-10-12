import { describe, expect, it } from "vitest";

import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture";
import {
    getTextureCoordinateIndex,
    getTextureMetadata,
    getTextureTransform,
    hasTextureTransform,
    setTextureTransform,
    type TextureTransform,
} from "../../../packages/babylon-lite/src/texture/texture-metadata";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { Texture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";

function texture2d(overrides: Record<string, unknown> = {}): Texture2D {
    return {
        texture: {
            width: 32,
            height: 16,
            depthOrArrayLayers: 1,
            mipLevelCount: 6,
            format: "rgba8unorm-srgb",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
            label: "",
        } as unknown as GPUTexture,
        view: { rawView: true } as unknown as GPUTextureView,
        sampler: { rawSampler: true } as unknown as GPUSampler,
        width: 32,
        height: 16,
        ...overrides,
    } as Texture2D;
}

function transform(overrides: Partial<TextureTransform> = {}): TextureTransform {
    return { uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0, ...overrides };
}

describe("texture metadata", () => {
    it("returns observable facts without recovery-only provenance, backing handles, or UI state", () => {
        const texture = texture2d({
            name: "Albedo",
            _recoverySource: {
                kind: "url",
                url: "private://asset.png",
                opts: { addressModeU: "mirror-repeat", mipMaps: true, srgb: true },
            },
            invertY: true,
        });

        const metadata = getTextureMetadata(texture);

        expect(metadata).toEqual({
            kind: "2d",
            name: "Albedo",
            origin: undefined,
            width: 32,
            height: 16,
            layers: undefined,
            depth: undefined,
            format: "rgba8unorm-srgb",
            mipLevelCount: 6,
            sampleType: "float",
            colorSpace: "srgb",
            invertY: true,
            sampler: undefined,
            capabilities: {
                renderAttachment: true,
                dynamicUpdate: undefined,
                sampledDepth: false,
            },
        });
        expect(JSON.stringify(metadata)).not.toContain("private://");
        expect(metadata).not.toHaveProperty("texture");
        expect(metadata).not.toHaveProperty("view");
        expect(metadata).not.toHaveProperty("rawSampler");
        expect(metadata).not.toHaveProperty("state");
    });

    it("omits unknown facts and classifies arrays, volumes, cubes, and depth", () => {
        const array = { ...texture2d(), layers: 5 } as Texture2DArray;
        const volume = { ...texture2d(), depth: 9 };
        const cube = {
            _texture: {
                width: 64,
                height: 64,
                depthOrArrayLayers: 6,
                mipLevelCount: 7,
                format: "rgba16float",
                usage: GPUTextureUsage.TEXTURE_BINDING,
                secretHandle: true,
            },
            _view: { secretView: true },
            _sampler: { secretSampler: true },
        } as unknown as CubeTexture;
        const depth = texture2d({
            _sampleType: "depth",
            texture: { width: 32, height: 16, mipLevelCount: 1, format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING },
        });
        const unknown = texture2d({ texture: {} });

        expect(getTextureMetadata(array)).toMatchObject({ kind: "2d-array", layers: 5 });
        expect(getTextureMetadata(volume)).toMatchObject({ kind: "3d", depth: 9 });
        expect(getTextureMetadata(cube)).toMatchObject({
            kind: "cube",
            width: 64,
            height: 64,
            layers: 6,
            format: "rgba16float",
            sampler: { magFilter: "linear", minFilter: "linear" },
        });
        expect(getTextureMetadata(depth)).toMatchObject({
            origin: "sampled-depth",
            sampleType: "depth",
            colorSpace: undefined,
            capabilities: { sampledDepth: true },
        });
        expect(getTextureMetadata(unknown)).toMatchObject({
            format: undefined,
            mipLevelCount: undefined,
            sampleType: undefined,
            colorSpace: undefined,
            sampler: undefined,
        });
        expect(JSON.stringify(getTextureMetadata(cube))).not.toContain("secret");
    });

    it("safely rejects malformed and throwing values", () => {
        const throwing = new Proxy(
            {},
            {
                has() {
                    throw new Error("transient");
                },
            }
        );
        expect(getTextureMetadata(null)).toBeUndefined();
        expect(getTextureMetadata({ texture: {}, view: {}, sampler: {}, width: Number.NaN, height: 1 })).toBeUndefined();
        expect(getTextureMetadata(throwing)).toBeUndefined();
    });
});

describe("texture transforms", () => {
    it("reads effective defaults, detects transforms, and reports coordinate selection", () => {
        const identity = texture2d();
        const transformed = texture2d({ uOffset: 0.25, vScale: 2, uAng: Math.PI / 4, _texCoord: 1 });

        expect(getTextureTransform(identity)).toEqual(transform());
        expect(hasTextureTransform(identity)).toBe(false);
        expect(getTextureCoordinateIndex(identity)).toBe(0);
        expect(getTextureTransform(transformed)).toEqual(transform({ uOffset: 0.25, vScale: 2, uAng: Math.PI / 4 }));
        expect(hasTextureTransform(transformed)).toBe(true);
        expect(getTextureCoordinateIndex(transformed)).toBe(1);
    });

    it("writes only the exact wrapper and returns whether effective values changed", () => {
        const texture = texture2d();
        const sibling = { ...texture };

        expect(setTextureTransform(texture, transform())).toBe(false);
        expect(texture.uScale).toBeUndefined();
        expect(setTextureTransform(texture, transform({ uOffset: 0.5, uScale: 2 }))).toBe(true);
        expect(texture).toMatchObject({ uOffset: 0.5, uScale: 2, _hasTx: true });
        expect(sibling.uOffset).toBeUndefined();
        expect(setTextureTransform(texture, transform({ uOffset: 0.5, uScale: 2 }))).toBe(false);
        expect(setTextureTransform(texture, transform())).toBe(true);
        expect(texture).toMatchObject(transform());
        expect(texture).not.toHaveProperty("_hasTx");
    });

    it("validates complete finite values and rejects unsupported wrappers", () => {
        const texture = texture2d();
        const renderTarget = texture2d({ _uvTransformDisabled: true });
        const depth = texture2d({ _sampleType: "depth" });
        const array = { ...texture2d(), layers: 2 } as Texture2DArray;

        expect(() => setTextureTransform(texture, { ...transform(), uScale: Number.NaN })).toThrow("finite numbers");
        expect(() => setTextureTransform(texture, null as unknown as TextureTransform)).toThrow("must be an object");
        expect(getTextureTransform(renderTarget)).toBeUndefined();
        expect(getTextureTransform(depth)).toBeUndefined();
        expect(getTextureTransform(array)).toBeUndefined();
        expect(() => setTextureTransform(renderTarget, transform({ uScale: 2 }))).toThrow("does not support UV transforms");
    });
});
