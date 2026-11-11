import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type * as ReadbackApi from "../../../packages/babylon-lite/src/texture/texture-pixel-readback.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import type { CubeTexture } from "../../../packages/babylon-lite/src/texture/cube-texture.js";

let script: string;

test.beforeAll(async () => {
    const bundle = await build({
        stdin: {
            contents: 'export * from "./packages/babylon-lite/src/texture/texture-pixel-readback.js";',
            resolveDir: process.cwd(),
        },
        bundle: true,
        format: "iife",
        globalName: "textureReadbackApi",
        write: false,
    });
    script = bundle.outputFiles[0]!.text;
});

test("reads exact subresource bytes on WebGPU without modifying source textures (non-visual)", async ({ page }) => {
    const url = "http://localhost/__texture_readback_test__";
    await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Texture readback byte checks</title>" }));
    await page.goto(url);
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
        const { readTexturePixelsRGBA8: read, getTextureReadbackInfo: info } = (globalThis as typeof globalThis & { textureReadbackApi: typeof ReadbackApi }).textureReadbackApi;
        const adapter = (await navigator.gpu.requestAdapter()) ?? (await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
        if (!adapter) {
            throw new Error("Non-visual texture readback integration requires a WebGPU adapter");
        }
        const bc = adapter.features.has("texture-compression-bc");
        const device = await adapter.requestDevice({ requiredFeatures: bc ? ["texture-compression-bc"] : [] });
        const engine = { _device: device } as EngineContext;
        const textures: GPUTexture[] = [];
        const errors: string[] = [];
        device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
        function make(width: number, height: number, depth = 1, format: GPUTextureFormat = "rgba8unorm", dimension: GPUTextureDimension = "2d", mipLevelCount = 1): Texture2D {
            const texture = device.createTexture({
                size: [width, height, depth],
                dimension,
                format,
                mipLevelCount,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            textures.push(texture);
            return { texture, view: texture.createView(), sampler: device.createSampler(), width, height };
        }
        async function rejection(action: Promise<unknown>): Promise<boolean> {
            try {
                await action;
                return false;
            } catch (error) {
                return error instanceof Error && error.message.length > 0;
            }
        }
        try {
            const input = new Uint8Array([0, 17, 128, 31, 255, 64, 32, 127, 100, 200, 80, 255, 77, 99, 123, 0, 11, 12, 13, 14, 88, 89, 90, 91]);
            const ordinary = make(2, 3);
            device.queue.writeTexture({ texture: ordinary.texture }, input, { bytesPerRow: 8 }, [2, 3]);
            const first = await read(engine, ordinary);
            const flipped = await read(engine, ordinary, { flipY: true });
            const concurrent = await Promise.all([read(engine, ordinary), read(engine, ordinary)]);

            const srgb = make(2, 3, 1, "rgba8unorm-srgb");
            device.queue.writeTexture({ texture: srgb.texture }, input, { bytesPerRow: 8 }, [2, 3]);
            const srgbPixels = await read(engine, srgb);
            const bgra = make(1, 1, 1, "bgra8unorm");
            device.queue.writeTexture({ texture: bgra.texture }, new Uint8Array([10, 20, 30, 40]), {}, [1, 1]);
            const bgraPixels = await read(engine, bgra);
            const float = make(1, 1, 1, "rgba16float");
            device.queue.writeTexture({ texture: float.texture }, new Uint16Array([0x3800, 0x4000, 0xbc00, 0x3400]), {}, [1, 1]);
            const floatPixels = await read(engine, float);
            const unfilterable = make(1, 1, 1, "r32float");
            device.queue.writeTexture({ texture: unfilterable.texture }, new Float32Array([0.5]), {}, [1, 1]);
            const unfilterablePixels = await read(engine, unfilterable);

            const array = make(4, 4, 6, "rgba8unorm", "2d", 3);
            for (let mip = 0; mip < 3; mip++) {
                const size = 4 / 2 ** mip;
                for (let face = 0; face < 6; face++) {
                    const bytes = new Uint8Array(size * size * 4);
                    for (let i = 0; i < bytes.length; i += 4) {
                        bytes.set([face * 30, mip * 60, i / 4, 120 + face], i);
                    }
                    device.queue.writeTexture({ texture: array.texture, mipLevel: mip, origin: [0, 0, face] }, bytes, { bytesPerRow: size * 4 }, [size, size, 1]);
                }
            }
            const cube = { _texture: array.texture } as unknown as CubeTexture;
            const faces = await Promise.all(Array.from({ length: 6 }, (_, face) => read(engine, cube, { face, mipLevel: 1 })));
            const layer = await read(engine, array, { layer: 5, mipLevel: 2 });
            const volume = make(4, 4, 4, "rgba8unorm", "3d", 3);
            for (let mip = 0; mip < 3; mip++) {
                const size = 4 / 2 ** mip;
                for (let slice = 0; slice < size; slice++) {
                    const bytes = new Uint8Array(size * size * 4);
                    for (let i = 0; i < bytes.length; i += 4) {
                        bytes.set([slice * 50, mip * 70, i / 4, 200], i);
                    }
                    device.queue.writeTexture({ texture: volume.texture, mipLevel: mip, origin: [0, 0, slice] }, bytes, { bytesPerRow: size * 4 }, [size, size, 1]);
                }
            }
            const slices = await Promise.all(Array.from({ length: 4 }, (_, slice) => read(engine, volume, { slice })));
            const volumeMip = await read(engine, volume, { mipLevel: 1, slice: 1 });
            let compressed: number[] | null = null;
            if (bc) {
                const texture = make(4, 4, 1, "bc1-rgba-unorm-srgb");
                device.queue.writeTexture({ texture: texture.texture }, new Uint8Array([0, 248, 0, 248, 0, 0, 0, 0]), { bytesPerRow: 8 }, [4, 4]);
                compressed = Array.from((await read(engine, texture)).pixels);
            }
            const otherAdapter = await navigator.gpu.requestAdapter();
            if (!otherAdapter) {
                throw new Error("Second WebGPU adapter unavailable for cross-device validation");
            }
            const other = await otherAdapter.requestDevice();
            let wrongDevice: boolean;
            try {
                wrongDevice = await rejection(read({ _device: other } as EngineContext, ordinary));
            } finally {
                other.destroy();
            }
            const destroyed = make(1, 1);
            destroyed.texture.destroy();
            const destroyedRejected = await rejection(read(engine, destroyed));
            const preserved = await read(engine, ordinary);
            await device.queue.onSubmittedWorkDone();
            return {
                input: Array.from(input),
                first: Array.from(first.pixels),
                flipped: Array.from(flipped.pixels),
                concurrent: concurrent.map((r) => Array.from(r.pixels)),
                srgb: Array.from(srgbPixels.pixels),
                bgra: Array.from(bgraPixels.pixels),
                float: Array.from(floatPixels.pixels),
                unfilterable: Array.from(unfilterablePixels.pixels),
                faces: faces.map((r) => ({ width: r.width, height: r.height, pixels: Array.from(r.pixels) })),
                layer: { width: layer.width, height: layer.height, pixels: Array.from(layer.pixels) },
                slices: slices.map((r) => Array.from(r.pixels.slice(0, 4))),
                volumeMip: { width: volumeMip.width, height: volumeMip.height, pixels: Array.from(volumeMip.pixels) },
                cubeInfo: info(cube),
                compressed,
                wrongDevice,
                destroyedRejected,
                preserved: Array.from(preserved.pixels),
                errors,
            };
        } finally {
            for (const texture of textures) {
                texture.destroy();
            }
            device.destroy();
        }
    });
    expect(result.first).toEqual(result.input);
    expect(result.flipped).toEqual([...result.input.slice(16), ...result.input.slice(8, 16), ...result.input.slice(0, 8)]);
    expect(result.concurrent).toEqual([result.input, result.input]);
    expect(result.srgb).toEqual(result.input);
    expect(result.bgra).toEqual([30, 20, 10, 40]);
    expect(result.float).toEqual([128, 255, 0, 64]);
    expect(result.unfilterable).toEqual([128, 0, 0, 255]);
    expect(result.faces).toEqual(
        Array.from({ length: 6 }, (_, face) => ({
            width: 2,
            height: 2,
            pixels: Array.from({ length: 4 }, (_, pixel) => [face * 30, 60, pixel, 120 + face]).flat(),
        }))
    );
    expect(result.layer).toEqual({ width: 1, height: 1, pixels: [150, 120, 0, 125] });
    expect(result.slices).toEqual(Array.from({ length: 4 }, (_, slice) => [slice * 50, 0, 0, 200]));
    expect(result.volumeMip).toEqual({ width: 2, height: 2, pixels: Array.from({ length: 4 }, (_, pixel) => [50, 70, pixel, 200]).flat() });
    expect(result.cubeInfo).toEqual({ kind: "cube", width: 4, height: 4, depthOrArrayLayers: 6, mipLevelCount: 3 });
    if (result.compressed) {
        expect(result.compressed).toEqual(Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat());
    }
    expect(result.wrongDevice).toBe(true);
    expect(result.destroyedRejected).toBe(true);
    expect(result.preserved).toEqual(result.input);
    expect(result.errors).toEqual([]);
});
