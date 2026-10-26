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
import type { FakeTextureOptions } from "./export-test-utils";

const COPY_SRC = GPUTextureUsage.COPY_SRC;
const TEXTURE_BINDING = GPUTextureUsage.TEXTURE_BINDING;
const PATTERN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function sceneWithTextures(device: GPUDevice | undefined, ...textures: Texture2D[]): ReturnType<typeof createScene> {
    const meshes = textures.map((texture, i) => {
        const slot = texture.texture?.format.endsWith("-srgb") ? { baseColorTexture: texture } : { ormTexture: texture };
        return createMesh(`m${i}`, { material: createPbrMaterial({ name: `mat${i}`, ...slot, metallicFactor: i / 10 }) });
    });
    return createScene({ meshes, ...(device ? { device } : {}) });
}

describe("image readback", () => {
    it.each([
        ["rgba8unorm", COPY_SRC, 0],
        ["rgba8unorm-srgb", COPY_SRC, 0],
        ["bgra8unorm", COPY_SRC, 0],
        ["bgra8unorm-srgb", COPY_SRC, 0],
        ["rgba8unorm", TEXTURE_BINDING, 1],
        ["bc7-rgba-unorm", TEXTURE_BINDING, 1],
        ["rgba16float", TEXTURE_BINDING, 1],
    ] as const)("exports %s with usage %s as PNG and releases its readback resources", async (format, usage, blits) => {
        const { device, stats } = createFakeDevice({ maxBufferSize: 5 * 256 });
        const pixels = Array.from({ length: 3 * 5 * 4 }, (_, i) => (i * 7) % 256);
        const glb = await exportAndParse(sceneWithTextures(device, createTexture(3, 5, pixels, { format, usage })));
        const expected = format.startsWith("bgra") ? pixels.map((v, i) => (i % 4 === 0 ? pixels[i + 2]! : i % 4 === 2 ? pixels[i - 2]! : v)) : pixels;
        expect(await decodePng(readBufferView(glb, glb.json.images[0].bufferView))).toEqual({ width: 3, height: 5, rgba: new Uint8Array(expected) });
        expect(stats).toMatchObject({ blits, texturesCreated: blits, texturesDestroyed: blits, buffersCreated: 1, buffersDestroyed: 1 });
        expect(glb.json.images[0]).toMatchObject({ mimeType: "image/png", bufferView: expect.any(Number) });
        expect(glb.json.images[0].uri).toBeUndefined();
        expect(glb.json.textures[0].extensions).toBeUndefined();
        expect(glb.warnings).toEqual(format === "rgba16float" ? ['Texture for material "mat0" has a floating-point format; exporting it clamped to 8 bits.'] : []);
    });

    it.each([
        { name: "null engine", noDevice: true, warning: "not readable" },
        { name: "unreadable usage", texture: { usage: GPUTextureUsage.RENDER_ATTACHMENT }, warning: "not readable" },
        { name: "depth", texture: { format: "depth24plus" }, warning: "not readable" },
        { name: "3D", texture: { dimension: "3d" }, warning: "not a single-sampled 2D image" },
        { name: "array", texture: { layers: 2 }, warning: "not a single-sampled 2D image" },
        { name: "multisampled", texture: { sampleCount: 4 }, warning: "not a single-sampled 2D image" },
        { name: "oversized staging buffer", maxBufferSize: 511, warning: "too large to read back" },
    ] satisfies { name: string; noDevice?: boolean; texture?: FakeTextureOptions; maxBufferSize?: number; warning: string }[])(
        "omits $name textures with a diagnostic",
        async (test) => {
            const { device, stats } = createFakeDevice({ maxBufferSize: "maxBufferSize" in test ? test.maxBufferSize : undefined });
            const glb = await exportAndParse(sceneWithTextures("noDevice" in test ? undefined : device, createTexture(2, 2, PATTERN, "texture" in test ? test.texture : {})));
            expect(glb.warnings).toHaveLength(1);
            expect(glb.warnings[0]).toContain(test.warning);
            expect(glb.json.images).toBeUndefined();
            expect(glb.json.textures).toBeUndefined();
            expect(glb.json.materials[0].pbrMetallicRoughness?.metallicRoughnessTexture).toBeUndefined();
            expect(stats).toMatchObject({ copies: 0, buffersCreated: 0 });
        }
    );

    it("settles failed concurrent readbacks and destroys all staging buffers", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const { device, stats } = createFakeDevice({ failMap: true });
            await expect(exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN), createTexture(3, 3, PATTERN)))).rejects.toThrow("device lost");
            expect(stats).toMatchObject({ buffersCreated: 2, buffersDestroyed: 2 });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", unhandled);
        }
    });

    it.each([COPY_SRC, TEXTURE_BINDING])("cleans up after synchronous buffer allocation failure (usage %s)", async (usage) => {
        const { device, stats } = createFakeDevice({ failCreateBuffer: true });
        await expect(exportAndParse(sceneWithTextures(device, createTexture(2, 2, PATTERN, { usage })))).rejects.toThrow("createBuffer failed");
        expect(stats.texturesCreated).toBe(usage === TEXTURE_BINDING ? 1 : 0);
        expect(stats.texturesDestroyed).toBe(stats.texturesCreated);
    });
});

describe("image variants and lifetime", () => {
    it.each(["linear", "gamma"] as const)("converts %s RGB, preserves alpha and bounds transfer-curve work", (colorDecode) => {
        const ctx = createExportContext(createScene().surface.engine, "test");
        const rgba = Uint8Array.from({ length: 256 * 4 }, (_, i) => (i % 4 === 3 ? 255 - Math.floor(i / 4) : Math.floor(i / 4)));
        const pow = vi.spyOn(Math, "pow");
        try {
            imageModule.insertImage(ctx, { width: 256, height: 1, rgba }, { texCoord: 0, rowOrder: "storage", colorDecode }, "baseColorTexture");
            expect(pow.mock.calls.length).toBeLessThanOrEqual(512);
        } finally {
            pow.mockRestore();
        }
        expect(ctx.imagePixels[0]!.rgba).toEqual(
            rgba.map((value, i) => (i % 4 === 3 ? value : linearToSrgbByte(colorDecode === "gamma" ? Math.pow(value / 255, 2.2) : value / 255)))
        );
        expect(rgba[128 * 4]).toBe(128);
    });

    it("resolves each pixel variant once while keeping UV mappings distinct", () => {
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
            ctx.slots.push({ owner: {}, key: "texture", gpu, mapping, materialName: "test" });
        }
        const insert = vi.spyOn(imageModule, "insertImage");
        try {
            resolveTextureSlots(ctx);
            expect(insert).toHaveBeenCalledTimes(4);
            expect(ctx.slots.map((slot) => slot.owner.texture)).toEqual([
                { index: 0 },
                { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { offset: [0.25, 0], texCoord: 1 } } },
                { index: 1 },
                { index: 2 },
                { index: 3 },
                { index: 2 },
            ]);
            expect(ctx.imagePixels.map((image) => Array.from(image.rgba))).toEqual([
                PATTERN,
                [...PATTERN.slice(8), ...PATTERN.slice(0, 8)],
                PATTERN.map((v, i) => (i % 4 === 0 ? 255 - v : v)),
                PATTERN.map((v, i) => (i % 4 < 2 ? 255 - v : v)),
            ]);
        } finally {
            insert.mockRestore();
        }
    });

    it("deduplicates shared readbacks and equal content, but not distinct images; repeated exports are deterministic", async () => {
        const { device, stats } = createFakeDevice();
        const shared = createTexture(2, 2, PATTERN);
        const other = PATTERN.map((v) => v + 100);
        const scene = sceneWithTextures(device, shared, shared, createTexture(2, 2, PATTERN), createTexture(2, 2, other));
        const glb = await exportAndParse(scene);
        expect(stats.copies).toBe(3);
        expect(glb.json.images).toHaveLength(2);
        expect(glb.json.textures).toHaveLength(2);
        expect(
            glb.json.materials.map(
                (material: { pbrMetallicRoughness: { metallicRoughnessTexture: { index: number } } }) => material.pbrMetallicRoughness.metallicRoughnessTexture.index
            )
        ).toEqual([0, 0, 0, 1]);
        expect(Array.from((await decodePng(readBufferView(glb, glb.json.images[1].bufferView))).rgba)).toEqual(other);
        expect((await exportAndParse(scene)).bytes).toEqual(glb.bytes);
    });

    it("releases context pixels before serial PNG encoding and preserves image order", async () => {
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
            const retainedPixels = ctx.imagePixels.length;
            finishFirst(encoded[0]!);
            await pending;
            expect(started).toBe(1);
            expect(retainedPixels).toBe(0);
            expect(encode).toHaveBeenCalledTimes(2);
            expect(ctx.doc.images.map((image) => image.bufferView)).toEqual([0, 1]);
            const glb = { json: { bufferViews: ctx.buffers.bufferViews }, bin: ctx.buffers.finalize() };
            expect([readBufferView(glb, 0), readBufferView(glb, 1)]).toEqual(encoded);
        } finally {
            encode.mockRestore();
        }
    });
});

describe("public export contract", () => {
    it.each([false, true])("returns a binary glTF Blob (geometry: %s)", async (geometry) => {
        const blob = await exportSceneAsGlb(createScene({ meshes: geometry ? [createMesh("mesh")] : [] }));
        expect(blob.type).toBe("model/gltf-binary");
        const glb = parseGlb(new Uint8Array(await blob.arrayBuffer()));
        expect(glb.json.asset).toEqual({ version: "2.0", generator: expect.stringMatching(/^Babylon Lite v/) });
        if (geometry) {
            expect(glb.bin.length).toBeGreaterThan(0);
        } else {
            expect(Object.keys(glb.json)).toEqual(["asset"]);
            expect(glb.bin.length).toBe(0);
        }
    });
});
