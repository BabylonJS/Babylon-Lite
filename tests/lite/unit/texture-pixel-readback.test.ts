import { describe, expect, it, vi } from "vitest";
import { getTextureReadbackInfo, readTexturePixelsRGBA8 } from "../../../packages/babylon-lite/src/texture/texture-pixel-readback.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture.js";

function fixture(overrides: Partial<GPUTexture> = {}) {
    const source = {
        width: 2,
        height: 3,
        depthOrArrayLayers: 1,
        dimension: "2d",
        format: "rgba8unorm",
        sampleCount: 1,
        mipLevelCount: 2,
        usage: GPUTextureUsage.TEXTURE_BINDING,
        createView: vi.fn(() => ({})),
        destroy: vi.fn(),
        ...overrides,
    };
    const texture = { texture: source, width: 999, height: 999, invertY: true } as unknown as Texture2D;
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const encoder = { beginRenderPass: vi.fn(() => pass), copyTextureToBuffer: vi.fn(), finish: vi.fn(() => ({})) };
    const staging = {
        mapAsync: vi.fn(async () => {}),
        getMappedRange: vi.fn(() => {
            const bytes = new Uint8Array(768);
            for (let row = 0; row < 3; row++) {
                bytes.set(
                    Uint8Array.from({ length: 8 }, (_, i) => row * 8 + i + 1),
                    row * 256
                );
            }
            return bytes.buffer;
        }),
        unmap: vi.fn(),
        destroy: vi.fn(),
    };
    const output = { width: 2, height: 3, createView: vi.fn(() => ({})), destroy: vi.fn() };
    const device = {
        createTexture: vi.fn((desc: GPUTextureDescriptor) => {
            const size = desc.size as number[];
            output.width = size[0]!;
            output.height = size[1]!;
            return output;
        }),
        createBuffer: vi.fn(() => staging),
        createShaderModule: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        createPipelineLayout: vi.fn(() => ({})),
        createRenderPipeline: vi.fn(() => ({})),
        createBindGroup: vi.fn(() => ({})),
        createCommandEncoder: vi.fn(() => encoder),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async (): Promise<GPUError | null> => null),
        queue: { submit: vi.fn() },
    };
    return { engine: { _device: device } as unknown as EngineContext, texture, source, device, staging, output, encoder, pass };
}

describe("texture pixel readback", () => {
    it("reports native allocation metadata, including opaque cubes and single-layer arrays", () => {
        const f = fixture();
        expect(getTextureReadbackInfo(f.texture)).toEqual({ kind: "2d", width: 2, height: 3, depthOrArrayLayers: 1, mipLevelCount: 2 });
        const array = { ...f.texture, layers: 1 };
        expect(getTextureReadbackInfo(array)).toMatchObject({ kind: "2d-array" });
        expect(getTextureReadbackInfo({ _texture: f.source } as unknown as CubeTexture)).toMatchObject({ kind: "cube" });
        expect(getTextureReadbackInfo(fixture({ dimension: "3d", depthOrArrayLayers: 8 }).texture)).toMatchObject({ kind: "3d", depthOrArrayLayers: 8 });
    });

    it("reads unpadded RGBA with unchanged alpha and storage orientation, ignoring wrapper UV state", async () => {
        const f = fixture();
        const result = await readTexturePixelsRGBA8(f.engine, f.texture);
        expect(result).toEqual({ width: 2, height: 3, pixels: Uint8Array.from({ length: 24 }, (_, i) => i + 1) });
        expect(f.source.createView).toHaveBeenCalledExactlyOnceWith({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
        expect(f.encoder.copyTextureToBuffer).toHaveBeenCalledWith({ texture: f.output }, { buffer: f.staging, bytesPerRow: 256, rowsPerImage: 3 }, [2, 3]);
        expect(f.device.createBindGroupLayout).toHaveBeenCalledWith({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "2d" } }],
        });
        expect(f.device.queue.submit).toHaveBeenCalledTimes(2);
        expect(f.pass.draw).toHaveBeenCalledExactlyOnceWith(3);
        expect(f.output.destroy).toHaveBeenCalledTimes(1);
        expect(f.staging.unmap).toHaveBeenCalledTimes(1);
        expect(f.staging.destroy).toHaveBeenCalledTimes(1);
        expect(f.source.destroy).not.toHaveBeenCalled();
    });

    it("reverses rows only when explicitly requested, retaining the middle row", async () => {
        const f = fixture();
        const { pixels } = await readTexturePixelsRGBA8(f.engine, f.texture, { flipY: true });
        expect(pixels).toEqual(Uint8Array.from([17, 18, 19, 20, 21, 22, 23, 24, 9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]));
    });

    it.each(["rgba8unorm-srgb", "bgra8unorm-srgb", "bc1-rgba-unorm-srgb"] as const)("preserves sRGB transfer encoding for %s", async (format) => {
        const f = fixture({ format });
        await readTexturePixelsRGBA8(f.engine, f.texture);
        expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba8unorm-srgb" }));
    });

    it.each(["rgba8unorm", "bgra8unorm", "rgba16float", "r32float", "bc6h-rgb-float"] as const)("converts %s without requiring source COPY_SRC", async (format) => {
        const f = fixture({ format });
        await readTexturePixelsRGBA8(f.engine, f.texture);
        expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba8unorm" }));
        expect(f.device.createShaderModule).toHaveBeenCalledWith(expect.objectContaining({ code: expect.stringContaining("textureLoad(source, vec2i(p.xy), 0)") }));
    });

    it.each([0, 1, 2, 3, 4, 5])("selects cube face %i as a single 2D layer without cube sampling", async (face) => {
        const f = fixture({ depthOrArrayLayers: 6 });
        await readTexturePixelsRGBA8(f.engine, { _texture: f.source } as unknown as CubeTexture, { face, mipLevel: 1 });
        expect(f.source.createView).toHaveBeenCalledWith({ dimension: "2d", baseMipLevel: 1, mipLevelCount: 1, baseArrayLayer: face, arrayLayerCount: 1 });
        expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: [1, 1] }));
    });

    it("selects array layers without shrinking their count at higher mips", async () => {
        const f = fixture({ depthOrArrayLayers: 8 });
        await readTexturePixelsRGBA8(f.engine, f.texture, { layer: 7, mipLevel: 1 });
        expect(f.source.createView).toHaveBeenCalledWith(expect.objectContaining({ baseArrayLayer: 7, baseMipLevel: 1, arrayLayerCount: 1 }));
    });

    it("selects 3D slices using mip-relative depth and a dedicated 3D view", async () => {
        const f = fixture({ dimension: "3d", depthOrArrayLayers: 8 });
        await readTexturePixelsRGBA8(f.engine, f.texture, { slice: 3, mipLevel: 1 });
        expect(f.source.createView).toHaveBeenCalledWith({ dimension: "3d", baseMipLevel: 1, mipLevelCount: 1 });
        expect(f.device.createShaderModule).toHaveBeenCalledWith(expect.objectContaining({ code: expect.stringContaining("textureLoad(source, vec3i(vec2i(p.xy), 3), 0)") }));
        await expect(readTexturePixelsRGBA8(f.engine, f.texture, { slice: 4, mipLevel: 1 })).rejects.toThrow("integer in [0, 4)");
    });

    it.each([{ mipLevel: -1 }, { mipLevel: 2 }, { mipLevel: NaN }, { mipLevel: Infinity }, { mipLevel: 0.5 }, { face: 0 }, { layer: 0 }, { slice: 0 }])(
        "rejects invalid selectors before allocating: %j",
        async (options) => {
            const f = fixture();
            await expect(readTexturePixelsRGBA8(f.engine, f.texture, options)).rejects.toThrow("readTexturePixelsRGBA8:");
            expect(f.device.createTexture).not.toHaveBeenCalled();
            expect(f.device.pushErrorScope).not.toHaveBeenCalled();
        }
    );

    it.each([
        { format: "depth32float" },
        { format: "stencil8" },
        { format: "rgba8uint" },
        { format: "r32sint" },
        { sampleCount: 4 },
        { dimension: "1d" },
        { usage: GPUTextureUsage.COPY_SRC },
    ] satisfies Partial<GPUTexture>[])("rejects unsupported texture states: %j", async (properties) => {
        const f = fixture(properties);
        await expect(readTexturePixelsRGBA8(f.engine, f.texture)).rejects.toThrow("unsupported texture");
        expect(f.device.createTexture).not.toHaveBeenCalled();
    });

    it("pops both scopes synchronously even while mapping is pending", async () => {
        const f = fixture();
        let finish!: () => void;
        f.staging.mapAsync.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        const pending = readTexturePixelsRGBA8(f.engine, f.texture);
        expect(f.device.pushErrorScope.mock.calls).toEqual([["validation"], ["out-of-memory"]]);
        expect(f.device.popErrorScope).toHaveBeenCalledTimes(2);
        expect(f.output.destroy).not.toHaveBeenCalled();
        finish();
        await pending;
    });

    it.each(["wrong device or destroyed source", "out of memory"])("rejects scoped GPU errors rather than returning blank pixels: %s", async (message) => {
        const f = fixture();
        f.device.popErrorScope.mockResolvedValueOnce({ message });
        await expect(readTexturePixelsRGBA8(f.engine, f.texture)).rejects.toThrow(message);
        expect(f.staging.destroy).toHaveBeenCalledTimes(1);
        expect(f.output.destroy).toHaveBeenCalledTimes(1);
    });

    it("cleans resources and scopes on synchronous and asynchronous failure", async () => {
        const f = fixture();
        f.device.createRenderPipeline.mockImplementationOnce(() => {
            throw new Error("pipeline failed");
        });
        await expect(readTexturePixelsRGBA8(f.engine, f.texture)).rejects.toThrow("pipeline failed");
        expect(f.device.popErrorScope).toHaveBeenCalledTimes(2);
        expect(f.output.destroy).toHaveBeenCalledTimes(1);
        f.staging.mapAsync.mockRejectedValueOnce(new Error("map failed"));
        await expect(readTexturePixelsRGBA8(f.engine, f.texture)).rejects.toThrow("map failed");
        expect(f.output.destroy).toHaveBeenCalledTimes(2);
        expect(f.staging.destroy).toHaveBeenCalledTimes(1);
    });
});
