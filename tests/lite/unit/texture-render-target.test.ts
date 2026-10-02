import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { buildRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createTexture2DArray, createTexture2DArrayFromPixels, updateTexture2DArrayFromPixels } from "../../../packages/babylon-lite/src/texture/texture-array";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-release";
import { createTextureRenderTarget } from "../../../packages/babylon-lite/src/texture/texture-render-target";
import { updateTextureRegion } from "../../../packages/babylon-lite/src/texture/texture-region";
import type { TextureRegion } from "../../../packages/babylon-lite/src/texture/texture-region";

function makeGpuTexture(descriptor: GPUTextureDescriptor) {
    const size = descriptor.size as GPUExtent3DDict;
    const views: GPUTextureViewDescriptor[] = [];
    const texture = {
        label: descriptor.label ?? "",
        width: size.width,
        height: size.height ?? 1,
        depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        sampleCount: descriptor.sampleCount ?? 1,
        dimension: descriptor.dimension ?? "2d",
        format: descriptor.format,
        usage: descriptor.usage,
        views,
        createView: vi.fn((view?: GPUTextureViewDescriptor) => {
            views.push(view ?? {});
            return { view } as unknown as GPUTextureView;
        }),
        destroy: vi.fn(),
    };
    return texture as unknown as GPUTexture & { views: GPUTextureViewDescriptor[]; destroy: ReturnType<typeof vi.fn> };
}

function makeEngine() {
    const writes: { destination: GPUTexelCopyTextureInfo; data: unknown; layout: GPUTexelCopyBufferLayout; size: GPUExtent3DDict; snapshot: unknown }[] = [];
    const device = {
        createTexture: vi.fn(makeGpuTexture),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        queue: {
            writeTexture: vi.fn((destination: GPUTexelCopyTextureInfo, data: unknown, layout: GPUTexelCopyBufferLayout, size: GPUExtent3DDict) => {
                writes.push({ destination, data, layout, size, snapshot: structuredClone({ origin: destination.origin, mipLevel: destination.mipLevel, layout, size }) });
            }),
        },
    } as unknown as GPUDevice;
    const engine = { _device: device } as unknown as EngineContext;
    return { engine, device, writes };
}

describe("any-format texture arrays", () => {
    it("allocates the requested format and keeps the RGBA8 default", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 256, 256, 4, { format: "rgba16float", mipMaps: false });
        const atlas = createTexture2DArray(engine, 16, 16, 2, { srgb: true });

        expect(tiles.texture.format).toBe("rgba16float");
        expect(tiles.texture.mipLevelCount).toBe(1);
        expect(atlas.texture.format).toBe("rgba8unorm-srgb");
    });

    it("rejects non-RGBA8 pixel creation before allocation and non-RGBA8 updates before upload", () => {
        const { engine, device } = makeEngine();
        const pixels = new Uint8Array(16);
        expect(() => createTexture2DArrayFromPixels(engine, pixels, 2, 2, 1, { format: "rgba16float", mipMaps: false })).toThrow(/rgba8unorm or rgba8unorm-srgb/);
        expect(device.createTexture).not.toHaveBeenCalled();

        const tiles = createTexture2DArray(engine, 2, 2, 1, { format: "rgba16float", mipMaps: false });
        expect(() => updateTexture2DArrayFromPixels(engine, tiles, pixels)).toThrow(/rgba8unorm or rgba8unorm-srgb/);
        expect(device.queue.writeTexture).not.toHaveBeenCalled();
    });

    it.each(["rgba8unorm", "rgba8unorm-srgb"] as const)("preserves %s pixel uploads", (format) => {
        const { engine, writes } = makeEngine();
        const pixels = new Uint8Array(16);
        const tiles = createTexture2DArrayFromPixels(engine, pixels, 2, 2, 1, { format, mipMaps: false });
        updateTexture2DArrayFromPixels(engine, tiles, pixels);
        expect(tiles.texture.format).toBe(format);
        expect(writes).toHaveLength(2);
    });
});

describe("createTextureRenderTarget", () => {
    it("renders into one layer and mip through a single-subresource 2D view", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 256, 128, 8, { format: "rgba16float" });
        const target = createTextureRenderTarget(engine, tiles, { layer: 5, mipLevel: 1 });

        expect(target._descriptor.format).toBe("rgba16float");
        expect(target._descriptor.samples).toBe(1);
        expect([target._width, target._height]).toEqual([128, 64]);
        expect((tiles.texture as unknown as { views: GPUTextureViewDescriptor[] }).views.at(-1)).toEqual({
            dimension: "2d",
            baseArrayLayer: 5,
            arrayLayerCount: 1,
            baseMipLevel: 1,
            mipLevelCount: 1,
        });
    });

    it("is never rebuilt by a frame-graph build and releases only its own reference", () => {
        const { engine, device } = makeEngine();
        const tiles = createTexture2DArray(engine, 64, 64, 2, { format: "rgba16float", mipMaps: false });
        const target = createTextureRenderTarget(engine, tiles, { layer: 1 });
        const view = target._colorView;

        buildRenderTarget(target, engine);
        expect(target._colorView).toBe(view);
        expect(device.createTexture).toHaveBeenCalledTimes(1);

        disposeRenderTarget(target);
        disposeRenderTarget(target);
        expect((tiles.texture as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
        expect(() => buildRenderTarget(target, engine)).toThrow(/disposed/);
        expect(releaseTexture(tiles)).toBe(true);
        expect((tiles.texture as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledTimes(1);
    });

    it.each(["depth32float", "depth24plus-stencil8", "depth32float-stencil8", "stencil8"] as const)("borrows %s as a depth/stencil attachment", (format) => {
        const { engine, device } = makeEngine();
        const tiles = createTexture2DArray(engine, 8, 8, 2, { format, mipMaps: false });
        const target = createTextureRenderTarget(engine, tiles, { layer: 1 });
        const view = target._depthView;

        expect(target._descriptor.format).toBeUndefined();
        expect(target._descriptor.dFormat).toBe(format);
        expect(target._depthTexture).toBe(tiles.texture);
        expect(target._colorTexture).toBeNull();
        expect(target._colorView).toBeNull();
        expect(view).not.toBeNull();
        buildRenderTarget(target, engine);
        expect(target._depthView).toBe(view);
        expect(device.createTexture).toHaveBeenCalledTimes(1);

        const replacement = makeGpuTexture({ size: { width: 8, height: 8, depthOrArrayLayers: 2 }, format, usage: tiles.texture.usage });
        tiles.texture = replacement;
        buildRenderTarget(target, engine);
        expect(target._depthTexture).toBe(replacement);
        expect(replacement.views.at(-1)).toMatchObject({ baseArrayLayer: 1, arrayLayerCount: 1 });
    });

    it("follows a facade whose GPU texture was replaced in place", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 64, 64, 2, { format: "rgba16float", mipMaps: false });
        const target = createTextureRenderTarget(engine, tiles, { layer: 1 });
        const replacement = makeGpuTexture({ size: { width: 64, height: 64, depthOrArrayLayers: 2 }, format: "rgba16float", usage: tiles.texture.usage });
        tiles.texture = replacement;

        buildRenderTarget(target, engine);

        expect(target._colorTexture).toBe(replacement);
        expect(replacement.views.at(-1)).toMatchObject({ baseArrayLayer: 1, arrayLayerCount: 1 });
    });

    it("preserves the allocation's multisample count", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 8, 8, 1, { mipMaps: false });
        tiles.texture = makeGpuTexture({ size: { width: 8, height: 8 }, format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT, sampleCount: 4 });
        expect(createTextureRenderTarget(engine, tiles)._descriptor.samples).toBe(4);
    });

    it("rejects textures that cannot be render attachments and out-of-range subresources", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 64, 64, 2, { format: "rgba16float", mipMaps: false });
        const sampledOnly = { ...tiles, texture: makeGpuTexture({ size: { width: 4, height: 4 }, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }) };
        const volume = {
            ...tiles,
            texture: makeGpuTexture({ size: { width: 4, height: 4, depthOrArrayLayers: 4 }, dimension: "3d", format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT }),
        };

        expect(() => createTextureRenderTarget(engine, sampledOnly)).toThrow(/render-attachment usage/);
        expect(() => createTextureRenderTarget(engine, volume)).toThrow(/3d textures cannot be render targets/);
        expect(() => createTextureRenderTarget(engine, tiles, { layer: 2 })).toThrow(/layer must be an integer in \[0, 2\)/);
        expect(() => createTextureRenderTarget(engine, tiles, { mipLevel: 1 })).toThrow(/mipLevel/);
    });
});

describe("updateTextureRegion", () => {
    it("includes every final-row byte and bounds the source view instead of its larger backing buffer", () => {
        const { engine, writes } = makeEngine();
        const table = createTexture2DArray(engine, 2, 2, 1, { format: "r32uint", mipMaps: false });
        const buffer = new ArrayBuffer(64);
        const exact = new Uint8Array(buffer, 1, 17);
        const region: TextureRegion = { width: 2, height: 2, bytesPerRow: 9 };

        updateTextureRegion(engine, table, exact, region);
        expect(writes[0]!.snapshot).toMatchObject({ layout: { offset: 1, bytesPerRow: 9, rowsPerImage: 2 } });
        expect(() => updateTextureRegion(engine, table, new Uint8Array(buffer, 1, 16), region)).toThrow(/cannot hold/);
        expect(() => updateTextureRegion(engine, table, new Uint8Array(7), { width: 2, height: 1, bytesPerRow: 8 })).toThrow(/cannot hold/);
        expect(() => updateTextureRegion(engine, table, exact, { ...region, bytesPerRow: 7 })).toThrow(/bytesPerRow/);
        expect(writes).toHaveLength(1);
    });

    it("accounts for padded rows between layers without requiring trailing row padding", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 2, 2, 2, { format: "rgba8unorm", mipMaps: false });
        const region: TextureRegion = { width: 2, height: 2, layerCount: 2, bytesPerRow: 9, rowsPerImage: 3, dataOffset: 1 };
        updateTextureRegion(engine, tiles, new Uint8Array(45), region);
        expect(writes[0]!.snapshot).toMatchObject({ layout: { offset: 1, bytesPerRow: 9, rowsPerImage: 3 }, size: { depthOrArrayLayers: 2 } });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(44), region)).toThrow(/cannot hold/);
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(45), { ...region, rowsPerImage: 1 })).toThrow(/rowsPerImage/);
        expect(writes).toHaveLength(1);
    });

    it.each([
        ["r8uint", 1],
        ["rg8unorm", 2],
        ["rgba8unorm-srgb", 4],
        ["rgb10a2unorm", 4],
        ["rgba16float", 8],
        ["rgba32uint", 16],
    ] as const)("validates %s using its %i-byte texels", (format, bytes) => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 3, 1, 1, { format, mipMaps: false });
        const region: TextureRegion = { width: 3, height: 1, bytesPerRow: 3 * bytes };
        updateTextureRegion(engine, tiles, new Uint8Array(3 * bytes), region);
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(3 * bytes - 1), region)).toThrow(/cannot hold/);
        expect(writes).toHaveLength(1);
    });

    it("uses compressed block rows, layer padding and complete physical edge mips", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 8, 8, 2, { mipMaps: false });
        tiles.texture = makeGpuTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 2 },
            format: "bc1-rgba-unorm-srgb",
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
            mipLevelCount: 4,
        });
        const region: TextureRegion = { width: 8, height: 8, layerCount: 2, bytesPerRow: 17, rowsPerImage: 3 };
        updateTextureRegion(engine, tiles, new Uint8Array(84), region);
        expect(writes[0]!.snapshot).toMatchObject({ layout: { bytesPerRow: 17, rowsPerImage: 3 } });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(83), region)).toThrow(/cannot hold/);

        updateTextureRegion(engine, tiles, new Uint8Array(8), { mipLevel: 3, width: 4, height: 4, bytesPerRow: 8 });
        expect(writes[1]!.snapshot).toMatchObject({ mipLevel: 3, layout: { rowsPerImage: 1 }, size: { width: 4, height: 4 } });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(8), { mipLevel: 3, width: 1, height: 1, bytesPerRow: 8 })).toThrow(/texel block/);
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(16), { x: 1, width: 4, height: 4, bytesPerRow: 8 })).toThrow(/texel block/);
    });

    it("handles non-square ASTC blocks without assuming 4x4 compression", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 10, 8, 1, { mipMaps: false });
        tiles.texture = makeGpuTexture({ size: { width: 10, height: 8 }, format: "astc-5x4-unorm-srgb", usage: GPUTextureUsage.COPY_DST });
        updateTextureRegion(engine, tiles, new Uint8Array(65), { width: 10, height: 8, bytesPerRow: 33 });
        expect(writes[0]!.snapshot).toMatchObject({ layout: { bytesPerRow: 33, rowsPerImage: 2 } });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(64), { width: 10, height: 8, bytesPerRow: 33 })).toThrow(/cannot hold/);
    });

    it.each(["depth24plus", "depth32float", "depth24plus-stencil8", "depth32float-stencil8"] as const)("rejects unsupported CPU copy aspects for %s", (format) => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 2, 2, 1, { format, mipMaps: false });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(64), { width: 2, height: 2, bytesPerRow: 16 })).toThrow(/default copy aspect/);
        expect(writes).toHaveLength(0);
    });

    it.each([
        ["depth16unorm", 2],
        ["stencil8", 1],
    ] as const)("uploads selected %s subresources using their exact copy footprint", (format, bytes) => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 2, 2, 3, { format, mipMaps: false });
        const bytesPerRow = 2 * bytes + 1;
        const data = new Uint8Array(bytesPerRow * 3 + 2 * bytes);
        const region: TextureRegion = { width: 2, height: 2, layerCount: 2, bytesPerRow };
        updateTextureRegion(engine, tiles, data, region);
        expect(writes).toHaveLength(1);
        updateTextureRegion(engine, tiles, data.subarray(1, 1 + bytesPerRow + 2 * bytes), { ...region, layer: 1, layerCount: 1 });
        expect(writes[1]!.snapshot).toMatchObject({ origin: { z: 1 }, layout: { offset: 1 }, size: { depthOrArrayLayers: 1 } });
        expect(() => updateTextureRegion(engine, tiles, data.subarray(1, bytesPerRow + 2 * bytes), { ...region, layer: 1, layerCount: 1 })).toThrow(/cannot hold/);
        updateTextureRegion(engine, tiles, data, { ...region, layer: 1 });
        expect(writes[2]!.snapshot).toMatchObject({ origin: { z: 1 }, size: { depthOrArrayLayers: 2 } });
        expect(() => updateTextureRegion(engine, tiles, data.subarray(0, data.length - 1), { ...region, layer: 1 })).toThrow(/cannot hold/);
        expect(() => updateTextureRegion(engine, tiles, data, { ...region, width: 1 })).toThrow(/full physical mip/);
        expect(() => updateTextureRegion(engine, tiles, data, { ...region, height: 1 })).toThrow(/full physical mip/);
        expect(writes).toHaveLength(3);
    });

    it("shrinks 3D slice bounds at higher mips without shrinking array layers", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 8, 8, 8);
        const region: TextureRegion = { mipLevel: 2, width: 2, height: 2, layer: 7, bytesPerRow: 8 };
        updateTextureRegion(engine, tiles, new Uint8Array(16), region);
        tiles.texture = makeGpuTexture({
            size: { width: 8, height: 8, depthOrArrayLayers: 8 },
            dimension: "3d",
            format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST,
            mipLevelCount: 4,
        });
        expect(() => updateTextureRegion(engine, tiles, new Uint8Array(16), region)).toThrow(/layer must be an integer/);
        updateTextureRegion(engine, tiles, new Uint8Array(16), { ...region, layer: 1 });
        expect(writes).toHaveLength(2);
    });

    it("rejects invalid row-layout numbers, usage and multisampling before queueing", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 2, 2, 1, { mipMaps: false });
        const region: TextureRegion = { width: 2, height: 2, bytesPerRow: 8 };
        for (const bytesPerRow of [NaN, Infinity, 8.5, 0x100000000]) {
            expect(() => updateTextureRegion(engine, tiles, new Uint8Array(16), { ...region, bytesPerRow })).toThrow(/bytesPerRow/);
        }
        for (const invalid of [{ x: NaN }, { y: 0.5 }, { mipLevel: 1 }, { layerCount: 0 }, { dataOffset: -1 }, { rowsPerImage: 0x100000000 }]) {
            expect(() => updateTextureRegion(engine, tiles, new Uint8Array(16), { ...region, ...invalid })).toThrow(/must be an integer/);
        }
        const sampledOnly = { ...tiles, texture: makeGpuTexture({ size: { width: 2, height: 2 }, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }) };
        const multisampled = {
            ...tiles,
            texture: makeGpuTexture({ size: { width: 2, height: 2 }, format: "rgba8unorm", usage: GPUTextureUsage.COPY_DST, sampleCount: 4 }),
        };
        expect(() => updateTextureRegion(engine, sampledOnly, new Uint8Array(16), region)).toThrow(/copy-destination usage/);
        expect(() => updateTextureRegion(engine, multisampled, new Uint8Array(16), region)).toThrow(/sampleCount 1/);
        expect(writes).toHaveLength(0);
    });

    it("writes a box of texels in the texture's own format through the source buffer, without creating views", () => {
        const { engine, writes } = makeEngine();
        const tiles = createTexture2DArray(engine, 256, 256, 4, { format: "rgba16float", mipMaps: false });
        const patterns = new Uint16Array(2 * 256 * 256 * 4);
        const second = patterns.subarray(256 * 256 * 4);
        const region: TextureRegion = { width: 256, height: 256, bytesPerRow: 256 * 8, layer: 0 };

        updateTextureRegion(engine, tiles, second, region);
        region.layer = 3;
        region.x = 0;
        updateTextureRegion(engine, tiles, patterns, region);

        expect(writes).toHaveLength(2);
        expect(writes[0]!.data).toBe(patterns.buffer);
        expect(writes[0]!.snapshot).toEqual({
            origin: { x: 0, y: 0, z: 0 },
            mipLevel: 0,
            layout: { offset: second.byteOffset, bytesPerRow: 2048, rowsPerImage: 256 },
            size: { width: 256, height: 256, depthOrArrayLayers: 1 },
        });
        expect((writes[1]!.snapshot as { origin: GPUOrigin3DDict }).origin).toEqual({ x: 0, y: 0, z: 3 });
        // The same descriptor objects are reused: nothing is allocated per upload.
        expect(writes[1]!.destination).toBe(writes[0]!.destination);
        expect(writes[1]!.layout).toBe(writes[0]!.layout);
        expect(writes[1]!.size).toBe(writes[0]!.size);
    });

    it("updates a sub-rectangle of one mip and rejects boxes outside the texture or the data", () => {
        const { engine, writes } = makeEngine();
        const table = createTexture2DArray(engine, 79, 79, 1, { format: "r32uint", mipMaps: false });
        const entries = new Uint32Array(79 * 79);

        updateTextureRegion(engine, table, entries, { x: 10, y: 20, width: 5, height: 3, bytesPerRow: 79 * 4, dataOffset: (20 * 79 + 10) * 4 });

        expect(writes[0]!.snapshot).toMatchObject({ origin: { x: 10, y: 20, z: 0 }, layout: { offset: (20 * 79 + 10) * 4, bytesPerRow: 316, rowsPerImage: 3 } });
        expect(() => updateTextureRegion(engine, table, entries, { x: 78, width: 2, height: 1, bytesPerRow: 8 })).toThrow(/x must be an integer/);
        expect(() => updateTextureRegion(engine, table, entries, { layer: 1, width: 1, height: 1, bytesPerRow: 4 })).toThrow(/layer must be an integer/);
        expect(() => updateTextureRegion(engine, table, new Uint32Array(4), { width: 79, height: 79, bytesPerRow: 316 })).toThrow(/cannot hold/);
    });
});
