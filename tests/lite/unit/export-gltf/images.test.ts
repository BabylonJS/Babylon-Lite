import { describe, expect, it, vi } from "vitest";
import { createExportContext } from "../../../../packages/babylon-lite/src/export-gltf/export-context";
import { exportSceneAsGlb } from "../../../../packages/babylon-lite/src/export-gltf/export-gltf";
import * as imageModule from "../../../../packages/babylon-lite/src/export-gltf/export-images";
import * as pngModule from "../../../../packages/babylon-lite/src/export-gltf/export-png";
import { resolveTextureSlots } from "../../../../packages/babylon-lite/src/export-gltf/export-textures";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import { linearToSrgbByte } from "../../../../packages/babylon-lite/src/math/color";
import type { Texture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, exportAndParse, parseGlb, readBufferView } from "./export-test-utils";
import type { FakeDeviceStats, ParsedGlb } from "./export-test-utils";

const COPY_SRC = GPUTextureUsage.COPY_SRC;
const TEXTURE_BINDING = GPUTextureUsage.TEXTURE_BINDING;

/** 2×2 RGBA test pattern; 1×1 textures would be folded into factors instead of exported as images. */
const PATTERN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function sceneWithTextures(device: GPUDevice | undefined, ...textures: Texture2D[]): ReturnType<typeof createScene> {
    const meshes = textures.map((t, i) => createMesh(`m${i}`, { material: createPbrMaterial({ name: `mat${i}`, ormTexture: t, metallicFactor: i / 10 }) }));
    return createScene({ meshes, ...(device ? { device } : {}) });
}

async function imagePixels(glb: ParsedGlb, index = 0): Promise<{ width: number; height: number; rgba: number[] }> {
    const png = await decodePng(readBufferView(glb, glb.json.images[index].bufferView));
    return { width: png.width, height: png.height, rgba: Array.from(png.rgba) };
}

function expectBuffersReleased(stats: FakeDeviceStats): void {
    expect(stats.buffersCreated).toBeGreaterThan(0);
    expect(stats.buffersDestroyed).toBe(stats.buffersCreated);
}

describe("image readback paths", () => {
    it.each(["rgba8unorm", "rgba8unorm-srgb"] as const)("copies %s directly and byte-exactly", async (format) => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { format })));
        expect(await imagePixels(glb)).toEqual({ width: 2, height: 2, rgba: PATTERN });
        expect(stats.blits).toBe(0);
        expect(stats.texturesCreated).toBe(0);
        expect(glb.warnings).toEqual([]);
        expectBuffersReleased(stats);
    });

    it("keeps row order and handles row padding for a width that is not 64 texels", async () => {
        const { device } = createFakeDevice();
        const pixels = Array.from({ length: 3 * 5 * 4 }, (_, i) => (i * 7) % 256);
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(3, 5, pixels)));
        expect(await imagePixels(glb)).toEqual({ width: 3, height: 5, rgba: pixels });
    });

    it.each(["bgra8unorm", "bgra8unorm-srgb"] as const)("swaps B and R when copying %s directly", async (format) => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { format })));
        const swapped = PATTERN.slice();
        for (let i = 0; i < swapped.length; i += 4) {
            swapped[i] = PATTERN[i + 2]!;
            swapped[i + 2] = PATTERN[i]!;
        }
        expect((await imagePixels(glb)).rgba).toEqual(swapped);
        expect(stats.blits).toBe(0);
    });

    it("goes through the blit for a texture without COPY_SRC and destroys the transient texture", async () => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { usage: TEXTURE_BINDING })));
        expect(stats.blits).toBe(1);
        expect(stats.texturesCreated).toBe(1);
        expect(stats.texturesDestroyed).toBe(1);
        expect(await imagePixels(glb)).toEqual({ width: 2, height: 2, rgba: PATTERN });
        expect(glb.warnings).toEqual([]);
        expectBuffersReleased(stats);
    });

    it("omits a texture with neither COPY_SRC nor TEXTURE_BINDING and warns that it is not readable", async () => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { usage: GPUTextureUsage.RENDER_ATTACHMENT })));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(glb.json.materials[0].pbrMetallicRoughness?.metallicRoughnessTexture).toBeUndefined();
        expect(stats.copies).toBe(0);
        expect(stats.buffersCreated).toBe(0);
    });

    it("omits a depth-format texture with the not-readable warning", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { format: "depth24plus", usage: COPY_SRC | TEXTURE_BINDING })));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
    });

    it.each([
        ["a 3d texture", { dimension: "3d" as const }],
        ["a two-layer texture", { layers: 2 }],
        ["a multisampled texture", { sampleCount: 4 }],
    ])("omits %s with the not-a-single-2D-image warning", async (_name, options) => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, options)));
        expect(glb.warnings).toEqual(['Texture for material "mat0" is not a single-sampled 2D image; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(stats.copies).toBe(0);
    });

    it("omits a texture whose staging buffer exceeds device.limits.maxBufferSize and warns", async () => {
        // A 2x2 texture needs a 2 * 256 byte staging buffer.
        const { device, stats } = createFakeDevice({ maxBufferSize: 511 });
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN)));
        expect(glb.warnings).toEqual(['Texture for material "mat0" is too large to read back on this device; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(stats.buffersCreated).toBe(0);
        const fits = createFakeDevice({ maxBufferSize: 512 });
        const ok = await exportAndParse(sceneWithTextures(fits.device, createTexture(2, 2, PATTERN)));
        expect(ok.warnings).toEqual([]);
        expect(ok.json.images).toHaveLength(1);
    });

    it("warns that rgba16float is clamped to 8 bits and still exports it", async () => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { format: "rgba16float", usage: TEXTURE_BINDING })));
        expect(glb.warnings).toEqual(['Texture for material "mat0" has a floating-point format; exporting it clamped to 8 bits.']);
        expect(glb.json.images).toHaveLength(1);
        expect(stats.blits).toBe(1);
        expect(stats.texturesDestroyed).toBe(stats.texturesCreated);
    });
});

describe("null engine", () => {
    it("omits textured slots with the warning and still succeeds", async () => {
        const glb = await exportAndParse(sceneWithTextures(undefined, createTexture(2, 2, PATTERN)));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.asset.version).toBe("2.0");
        expect(glb.json.meshes).toHaveLength(1);
        expect(glb.json.materials).toHaveLength(1);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
    });
});

describe("image identity", () => {
    it.each(["linear", "gamma"] as const)("converts every %s byte exactly with bounded transfer-curve work", (colorDecode) => {
        const ctx = createExportContext(createScene().surface.engine, "test");
        const rgba = Uint8Array.from({ length: 256 * 4 }, (_, i) => (i % 4 === 3 ? 255 - Math.floor(i / 4) : Math.floor(i / 4)));
        const pow = vi.spyOn(Math, "pow");
        let calls: number;
        try {
            imageModule.insertImage(ctx, { width: 256, height: 1, rgba }, { texCoord: 0, rowOrder: "storage", colorDecode }, "baseColorTexture");
            calls = pow.mock.calls.length;
        } finally {
            pow.mockRestore();
        }
        const out = ctx.imagePixels[0]!.rgba;
        for (let value = 0; value < 256; value++) {
            const expected = linearToSrgbByte(colorDecode === "gamma" ? Math.pow(value / 255, 2.2) : value / 255);
            expect(Array.from(out.subarray(value * 4, value * 4 + 4))).toEqual([expected, expected, expected, 255 - value]);
        }
        expect(calls).toBeLessThanOrEqual(512);
        expect(rgba[128 * 4]).toBe(128);
    });

    it("resolves shared pixels once per row-order and channel variant without sharing texture mappings", async () => {
        const ctx = createExportContext(createScene().surface.engine, "test");
        const gpu = createTexture(2, 2, PATTERN).texture;
        ctx.resolvedPixels.set(gpu, { width: 2, height: 2, rgba: new Uint8Array(PATTERN) });
        const mappings = [
            { rowOrder: "storage" as const, texCoord: 0 as const },
            { rowOrder: "storage" as const, texCoord: 1 as const, transform: { offset: [0.25, 0] as const, scale: [1, 1] as const, rotation: 0 } },
            { rowOrder: "reversed" as const, texCoord: 0 as const },
            { rowOrder: "storage" as const, texCoord: 0 as const, invert: "r" as const },
            { rowOrder: "storage" as const, texCoord: 0 as const, invert: "rg" as const },
            { rowOrder: "storage" as const, texCoord: 0 as const, invert: "r" as const },
        ];
        for (const mapping of mappings) {
            ctx.slots.push({ owner: {}, key: "texture", slot: "metallicRoughnessTexture", gpu, mapping, materialName: "test" });
        }
        const insert = vi.spyOn(imageModule, "insertImage");
        try {
            resolveTextureSlots(ctx);
            expect(insert).toHaveBeenCalledTimes(4);
            expect(ctx.doc.images).toHaveLength(4);
            expect(ctx.slots.map((slot) => slot.owner.texture)).toEqual([
                { index: 0 },
                { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { offset: [0.25, 0], texCoord: 1 } } },
                { index: 1 },
                { index: 2 },
                { index: 3 },
                { index: 2 },
            ]);
            await imageModule.encodeImages(ctx);
            const bin = ctx.buffers.finalize();
            const decoded = [];
            for (const image of ctx.doc.images) {
                const view = ctx.buffers.bufferViews[image.bufferView!]!;
                const offset = view.byteOffset ?? 0;
                decoded.push(Array.from((await decodePng(bin.subarray(offset, offset + view.byteLength))).rgba));
            }
            expect(decoded).toEqual([
                PATTERN,
                [...PATTERN.slice(8), ...PATTERN.slice(0, 8)],
                PATTERN.map((v, i) => (i % 4 === 0 ? 255 - v : v)),
                PATTERN.map((v, i) => (i % 4 < 2 ? 255 - v : v)),
            ]);
        } finally {
            insert.mockRestore();
        }
    });

    it("exports one image and one texture for two GPU textures with identical pixels", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN), createTexture(2, 2, PATTERN)));
        expect(glb.json.images).toHaveLength(1);
        expect(glb.json.textures).toHaveLength(1);
        expect(glb.json.materials).toHaveLength(2);
        for (const material of glb.json.materials) {
            expect(material.pbrMetallicRoughness.metallicRoughnessTexture.index).toBe(0);
        }
    });

    it("exports separate images for different pixels", async () => {
        const { device } = createFakeDevice();
        const other = PATTERN.map((v) => v + 100);
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN), createTexture(2, 2, other)));
        expect(glb.json.images).toHaveLength(2);
        expect(glb.json.textures).toHaveLength(2);
        expect((await imagePixels(glb, 1)).rgba).toEqual(other);
    });

    it("reads a texture shared by two materials back once", async () => {
        const { device, stats } = createFakeDevice();
        const shared = createTexture(2, 2, PATTERN);
        const glb = await exportAndParse(sceneWithTextures(device, shared, shared));
        expect(stats.copies).toBe(1);
        expect(glb.json.images).toHaveLength(1);
        expect(glb.json.textures).toHaveLength(1);
    });

    it("names the image after the slot and labels it image/png", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN)));
        expect(glb.json.images[0].name).toBe("metallicRoughnessTexture");
        expect(glb.json.images[0].mimeType).toBe("image/png");
        expect(typeof glb.json.images[0].bufferView).toBe("number");
        expect(glb.json.images[0].uri).toBeUndefined();
    });
});

describe("image encoding", () => {
    it("finishes each PNG before starting the next and preserves image-index order", async () => {
        const ctx = createExportContext(createScene().surface.engine, "test");
        ctx.doc.images.push({ mimeType: "image/png" }, { mimeType: "image/png" });
        ctx.imagePixels.push({ width: 2, height: 2, rgba: new Uint8Array(PATTERN) }, { width: 2, height: 2, rgba: new Uint8Array(PATTERN) });
        const encoded = [new Uint8Array([1]), new Uint8Array([2, 3])];
        let finishFirst!: (bytes: Uint8Array) => void;
        const encode = vi
            .spyOn(pngModule, "encodePng")
            .mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => (finishFirst = resolve)))
            .mockResolvedValueOnce(encoded[1]!);
        try {
            const pending = imageModule.encodeImages(ctx);
            const started = encode.mock.calls.length;
            finishFirst(encoded[0]!);
            await pending;
            expect(started).toBe(1);
            expect(encode).toHaveBeenCalledTimes(2);
            expect(ctx.doc.images.map((image) => image.bufferView)).toEqual([0, 1]);
            const bin = ctx.buffers.finalize();
            for (let i = 0; i < encoded.length; i++) {
                const view = ctx.buffers.bufferViews[i]!;
                const offset = view.byteOffset ?? 0;
                expect(bin.subarray(offset, offset + view.byteLength)).toEqual(encoded[i]);
            }
        } finally {
            encode.mockRestore();
        }
    });
});

describe("readback failure", () => {
    it("rejects, destroys every staging buffer and leaves no unhandled rejection", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const { device, stats } = createFakeDevice({ failMap: true });
            const scene = sceneWithTextures(device, createTexture(2, 2, PATTERN), createTexture(3, 3, PATTERN));
            await expect(exportAndParse(scene)).rejects.toThrow("device lost");
            expectBuffersReleased(stats);
            expect(stats.buffersCreated).toBe(2);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });
});

describe("synchronous submission failure", () => {
    it("rejects the export when createBuffer throws", async () => {
        const { device } = createFakeDevice({ failCreateBuffer: true });
        await expect(exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN)))).rejects.toThrow("createBuffer failed");
    });

    it("destroys the transient blit texture when createBuffer throws after the blit was encoded", async () => {
        const { device, stats } = createFakeDevice({ failCreateBuffer: true });
        await expect(exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { usage: TEXTURE_BINDING })))).rejects.toThrow("createBuffer failed");
        expect(stats.texturesCreated).toBe(1);
        expect(stats.texturesDestroyed).toBe(1);
    });
});

describe("document and container", () => {
    it("exports an empty scene as an asset-only document with a zero-length BIN chunk", async () => {
        const glb = await exportAndParse(createScene());
        expect(Object.keys(glb.json)).toEqual(["asset"]);
        expect(glb.json.asset.version).toBe("2.0");
        expect(glb.json.asset.generator).toMatch(/^Babylon Lite v/);
        for (const key of ["scenes", "scene", "buffers", "accessors", "bufferViews", "nodes", "meshes"]) {
            expect(glb.json).not.toHaveProperty(key);
        }
        expect(glb.bin.byteLength).toBe(0);
        // The BIN chunk header is still present: 12 header + 8 + JSON + 8.
        const view = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
        expect(glb.bytes.byteLength).toBe(12 + 8 + view.getUint32(12, true) + 8);
        expect(glb.warnings).toEqual([]);
    });

    it("returns a Blob of type model/gltf-binary that parses as a GLB", async () => {
        const blob = await exportSceneAsGlb(createScene({ meshes: [createMesh("m")] }));
        expect(blob.type).toBe("model/gltf-binary");
        const parsed = parseGlb(new Uint8Array(await blob.arrayBuffer()));
        expect(parsed.json.asset.version).toBe("2.0");
        expect(parsed.bin.byteLength).toBeGreaterThan(0);
    });

    it("exports the same scene twice to byte-identical files", async () => {
        const { device } = createFakeDevice();
        const scene = sceneWithTextures(device, createTexture(3, 2, PATTERN), createTexture(2, 2, PATTERN));
        const first = await exportAndParse(scene);
        const second = await exportAndParse(scene);
        expect(first.bytes.byteLength).toBeGreaterThan(0);
        expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    });
});
