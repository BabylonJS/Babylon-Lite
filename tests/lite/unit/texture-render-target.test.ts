import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import { buildRenderTarget, disposeRenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { createTexture2DArray } from "../../../packages/babylon-lite/src/texture/texture-array";
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
        expect((tiles.texture as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
        expect(() => buildRenderTarget(target, engine)).toThrow(/disposed/);
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

    it("rejects textures that cannot be render attachments and out-of-range subresources", () => {
        const { engine } = makeEngine();
        const tiles = createTexture2DArray(engine, 64, 64, 2, { format: "rgba16float", mipMaps: false });
        const sampledOnly = { ...tiles, texture: makeGpuTexture({ size: { width: 4, height: 4 }, format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING }) };

        expect(() => createTextureRenderTarget(engine, sampledOnly)).toThrow(/render-attachment usage/);
        expect(() => createTextureRenderTarget(engine, tiles, { layer: 2 })).toThrow(/layer must be an integer in \[0, 2\)/);
        expect(() => createTextureRenderTarget(engine, tiles, { mipLevel: 1 })).toThrow(/mipLevel/);
    });
});

describe("updateTextureRegion", () => {
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
