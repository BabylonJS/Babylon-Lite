import { describe, expect, it, vi } from "vitest";
import { exportSceneAsGlb } from "../../../../packages/babylon-lite/src/export-gltf/export-gltf";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material";
import type { Texture2D } from "../../../../packages/babylon-lite/src/texture/texture-2d";
import { createFakeDevice, createMesh, createScene, createTexture, decodePng, exportAndParse, parseGlb, readBufferView } from "./export-test-utils";
import type { FakeDeviceStats, ParsedGlb } from "./export-test-utils";

const COPY_SRC = GPUTextureUsage.COPY_SRC;
const TEXTURE_BINDING = GPUTextureUsage.TEXTURE_BINDING;

/** 2×2 RGBA test pattern; 1×1 textures would be folded into factors instead of exported as images. */
const PATTERN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function sceneWithBaseColor(device: GPUDevice | undefined, ...textures: Texture2D[]): ReturnType<typeof createScene> {
    const meshes = textures.map((t, i) => createMesh(`m${i}`, { material: createPbrMaterial({ name: `mat${i}`, baseColorTexture: t, metallicFactor: i / 10 }) }));
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
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { format })));
        expect(await imagePixels(glb)).toEqual({ width: 2, height: 2, rgba: PATTERN });
        expect(stats.blits).toBe(0);
        expect(stats.texturesCreated).toBe(0);
        expect(glb.warnings).toEqual([]);
        expectBuffersReleased(stats);
    });

    it("keeps row order and handles row padding for a width that is not 64 texels", async () => {
        const { device } = createFakeDevice();
        const pixels = Array.from({ length: 3 * 5 * 4 }, (_, i) => (i * 7) % 256);
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(3, 5, pixels)));
        expect(await imagePixels(glb)).toEqual({ width: 3, height: 5, rgba: pixels });
    });

    it.each(["bgra8unorm", "bgra8unorm-srgb"] as const)("swaps B and R when copying %s directly", async (format) => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { format })));
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
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { usage: TEXTURE_BINDING })));
        expect(stats.blits).toBe(1);
        expect(stats.texturesCreated).toBe(1);
        expect(stats.texturesDestroyed).toBe(1);
        expect(await imagePixels(glb)).toEqual({ width: 2, height: 2, rgba: PATTERN });
        expect(glb.warnings).toEqual([]);
        expectBuffersReleased(stats);
    });

    it("omits a texture with neither COPY_SRC nor TEXTURE_BINDING and warns that it is not readable", async () => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { usage: GPUTextureUsage.RENDER_ATTACHMENT })));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(glb.json.materials[0].pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
        expect(stats.copies).toBe(0);
        expect(stats.buffersCreated).toBe(0);
    });

    it("omits a depth-format texture with the not-readable warning", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { format: "depth24plus", usage: COPY_SRC | TEXTURE_BINDING })));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
    });

    it.each([
        ["a 3d texture", { dimension: "3d" as const }],
        ["a two-layer texture", { layers: 2 }],
        ["a multisampled texture", { sampleCount: 4 }],
    ])("omits %s with the not-a-single-2D-image warning", async (_name, options) => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, options)));
        expect(glb.warnings).toEqual(['Texture for material "mat0" is not a single-sampled 2D image; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(stats.copies).toBe(0);
    });

    it("omits a texture whose staging buffer exceeds device.limits.maxBufferSize and warns", async () => {
        // A 2x2 texture needs a 2 * 256 byte staging buffer.
        const { device, stats } = createFakeDevice({ maxBufferSize: 511 });
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN)));
        expect(glb.warnings).toEqual(['Texture for material "mat0" is too large to read back on this device; exporting the material without that texture.']);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
        expect(stats.buffersCreated).toBe(0);
        const fits = createFakeDevice({ maxBufferSize: 512 });
        const ok = await exportAndParse(sceneWithBaseColor(fits.device, createTexture(2, 2, PATTERN)));
        expect(ok.warnings).toEqual([]);
        expect(ok.json.images).toHaveLength(1);
    });

    it("warns that rgba16float is clamped to 8 bits and still exports it", async () => {
        const { device, stats } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { format: "rgba16float", usage: TEXTURE_BINDING })));
        expect(glb.warnings).toEqual(['Texture for material "mat0" has a floating-point format; exporting it clamped to 8 bits.']);
        expect(glb.json.images).toHaveLength(1);
        expect(stats.blits).toBe(1);
        expect(stats.texturesDestroyed).toBe(stats.texturesCreated);
    });
});

describe("null engine", () => {
    it("omits textured slots with the warning and still succeeds", async () => {
        const glb = await exportAndParse(sceneWithBaseColor(undefined, createTexture(2, 2, PATTERN)));
        expect(glb.warnings).toEqual(['Texture pixels for material "mat0" are not readable on this engine; exporting the material without that texture.']);
        expect(glb.json.asset.version).toBe("2.0");
        expect(glb.json.meshes).toHaveLength(1);
        expect(glb.json.materials).toHaveLength(1);
        expect(glb.json.images).toBeUndefined();
        expect(glb.json.textures).toBeUndefined();
    });
});

describe("image identity", () => {
    it("exports one image and one texture for two GPU textures with identical pixels", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN), createTexture(2, 2, PATTERN)));
        expect(glb.json.images).toHaveLength(1);
        expect(glb.json.textures).toHaveLength(1);
        expect(glb.json.materials).toHaveLength(2);
        for (const material of glb.json.materials) {
            expect(material.pbrMetallicRoughness.baseColorTexture.index).toBe(0);
        }
    });

    it("exports separate images for different pixels", async () => {
        const { device } = createFakeDevice();
        const other = PATTERN.map((v) => v + 100);
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN), createTexture(2, 2, other)));
        expect(glb.json.images).toHaveLength(2);
        expect(glb.json.textures).toHaveLength(2);
        expect((await imagePixels(glb, 1)).rgba).toEqual(other);
    });

    it("reads a texture shared by two materials back once", async () => {
        const { device, stats } = createFakeDevice();
        const shared = createTexture(2, 2, PATTERN);
        const glb = await exportAndParse(sceneWithBaseColor(device, shared, shared));
        expect(stats.copies).toBe(1);
        expect(glb.json.images).toHaveLength(1);
        expect(glb.json.textures).toHaveLength(1);
    });

    it("names the image after the slot and labels it image/png", async () => {
        const { device } = createFakeDevice();
        const glb = await exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN)));
        expect(glb.json.images[0].name).toBe("baseColorTexture");
        expect(glb.json.images[0].mimeType).toBe("image/png");
        expect(typeof glb.json.images[0].bufferView).toBe("number");
        expect(glb.json.images[0].uri).toBeUndefined();
    });
});

describe("readback failure", () => {
    it("rejects, destroys every staging buffer and leaves no unhandled rejection", async () => {
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        try {
            const { device, stats } = createFakeDevice({ failMap: true });
            const scene = sceneWithBaseColor(device, createTexture(2, 2, PATTERN), createTexture(3, 3, PATTERN));
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
        await expect(exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN)))).rejects.toThrow("createBuffer failed");
    });

    it("destroys the transient blit texture when createBuffer throws after the blit was encoded", async () => {
        const { device, stats } = createFakeDevice({ failCreateBuffer: true });
        await expect(exportAndParse(sceneWithBaseColor(device, createTexture(2, 2, PATTERN, { usage: TEXTURE_BINDING })))).rejects.toThrow("createBuffer failed");
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
        const scene = sceneWithBaseColor(device, createTexture(3, 2, PATTERN), createTexture(2, 2, PATTERN));
        const first = await exportAndParse(scene);
        const second = await exportAndParse(scene);
        expect(first.bytes.byteLength).toBeGreaterThan(0);
        expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    });
});
