import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { acquireTexture } from "../../../packages/babylon-lite/src/resource/texture-acquire.js";
import { releaseTexture } from "../../../packages/babylon-lite/src/resource/texture-release.js";
import { _textureOwners } from "../../../packages/babylon-lite/src/resource/texture-owner-state.js";
import { processAreaLightTexture } from "../../../packages/babylon-lite/src/light/process-area-light-texture.js";
import { readTexturePixels } from "../../../packages/babylon-lite/src/texture/read-texture-pixels.js";
import { blurAreaLightPixels } from "../../../packages/babylon-lite/src/light/area-light-blur.js";
import { getOrCreateSampler, getTextureSamplerDescriptor } from "../../../packages/babylon-lite/src/resource/texture-sampler-pool.js";
import { rebuildTexture2D, settleRebuiltTextureOwnership } from "../../../packages/babylon-lite/src/texture/texture-recovery.js";
import type { DeviceLostRecoveryState } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";

vi.mock("../../../packages/babylon-lite/src/texture/read-texture-pixels.js", () => ({ readTexturePixels: vi.fn(async () => new Uint8Array(1024 * 1024 * 4)) }));
vi.mock("../../../packages/babylon-lite/src/light/area-light-blur.js", () => ({ blurAreaLightPixels: vi.fn((pixels: Uint8Array) => pixels) }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() };
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const dimensions = descriptor.size as number[] | GPUExtent3DDict;
            const width = Array.isArray(dimensions) ? dimensions[0] : dimensions.width;
            const height = Array.isArray(dimensions) ? dimensions[1] : (dimensions.height ?? 1);
            const layers = Array.isArray(dimensions) ? (dimensions[2] ?? 1) : (dimensions.depthOrArrayLayers ?? 1);
            return {
                width,
                height,
                depthOrArrayLayers: layers,
                dimension: "2d",
                format: descriptor.format,
                mipLevelCount: descriptor.mipLevelCount ?? 1,
                sampleCount: 1,
                usage: descriptor.usage,
                createView: vi.fn((options?: GPUTextureViewDescriptor) => ({ options })),
                destroy: vi.fn(),
            };
        }),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
        createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => descriptor),
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => descriptor),
        createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor),
        createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => descriptor),
        createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => descriptor),
        createCommandEncoder: vi.fn(() => ({ beginRenderPass: vi.fn(() => pass), finish: vi.fn() })),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async (): Promise<GPUError | null> => null),
        queue: { writeTexture: vi.fn(), submit: vi.fn() },
    };
    const engine = { _device: device } as unknown as EngineContext;
    const texture = device.createTexture({ size: [64, 32], format: "rgba8unorm", usage: 6 });
    const source = { texture, view: texture.createView(), sampler: { caller: true }, width: 64, height: 32 } as unknown as Texture2D;
    acquireTexture(source);
    return { engine, device, source, pass, texture };
}

beforeEach(() => {
    vi.mocked(readTexturePixels)
        .mockReset()
        .mockResolvedValue(new Uint8Array(1024 * 1024 * 4));
    vi.mocked(blurAreaLightPixels).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("public area texture processing ownership and failures", () => {
    it("preserves a pooled source's nearest/mipmap/aniso settings while changing only address modes on its private sampler", async () => {
        const f = fixture();
        f.source.sampler = getOrCreateSampler(f.engine, {
            minFilter: "nearest",
            magFilter: "nearest",
            mipmapFilter: "nearest",
            addressModeU: "repeat",
            addressModeV: "clamp-to-edge",
        });
        const original = f.source.sampler;
        const result = await processAreaLightTexture(f.engine, f.source);
        expect(f.source.sampler).toBe(original);
        expect(getTextureSamplerDescriptor(f.engine, original)).toMatchObject({ minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest", addressModeU: "repeat" });
        expect(f.device.createSampler.mock.calls).toContainEqual([
            expect.objectContaining({ minFilter: "nearest", magFilter: "nearest", mipmapFilter: "nearest", addressModeU: "mirror-repeat", addressModeV: "mirror-repeat" }),
        ]);
        releaseTexture(result);
        releaseTexture(f.source);
    });
    it("scales with its own mirror sampler, builds every mip, preserves source state and returns one caller-owned resource", async () => {
        const f = fixture();
        const state = { ...f.source };
        const result = await processAreaLightTexture(f.engine, f.source);
        expect(f.source).toEqual(state);
        expect(_textureOwners(f.source)).toBe(1);
        expect(_textureOwners(result)).toBe(1);
        expect(result._areaLightImage).toEqual({ texture: result.texture, device: f.engine._device });
        expect(result.texture).not.toBe(f.source.texture);
        expect(result.texture.mipLevelCount).toBe(11);
        expect(result.texture.usage).toBe(23);
        expect(f.device.createSampler.mock.calls.some(([descriptor]) => descriptor.addressModeU === "mirror-repeat" && descriptor.addressModeV === "mirror-repeat")).toBe(true);
        expect(f.device.createSampler.mock.calls.some(([descriptor]) => descriptor.addressModeU === "clamp-to-edge" && descriptor.mipmapFilter === "linear")).toBe(true);
        expect(f.pass.draw).toHaveBeenCalledTimes(11);
        const shader = f.device.createShaderModule.mock.calls[0]![0].code;
        expect(shader).toContain("p*vec2<f32>(0.5,-0.5)");
        expect(shader).toContain("(sourceUV - vec2<f32>(0.125))/0.75");
        expect(shader).toContain("textureSample(image,imageSampler");
        expect(vi.mocked(readTexturePixels)).toHaveBeenCalledExactlyOnceWith(f.engine._device, result.texture);
        expect(vi.mocked(blurAreaLightPixels)).toHaveBeenCalledTimes(1);
        releaseTexture(result);
        expect(f.device.createTexture.mock.results[1]!.value.destroy).toHaveBeenCalledTimes(1);
        releaseTexture(f.source);
    });

    it("corrects a top-origin wrapper without mutating its invertY flag or sampler", async () => {
        const f = fixture();
        f.source.invertY = true;
        const result = await processAreaLightTexture(f.engine, f.source);
        expect(f.device.createShaderModule.mock.calls[0]![0].code).toContain("1.0 - uv.y");
        expect(f.source.invertY).toBe(true);
        expect(f.source.sampler).toEqual({ caller: true });
        releaseTexture(result);
        releaseTexture(f.source);
    });

    it.each(["scale", "map", "upload", "sync"] as const)("rejects %s failure, releases its source claim and partial output, and permits a new attempt", async (failure) => {
        const f = fixture();
        if (failure === "scale") {
            f.device.popErrorScope.mockResolvedValueOnce({ message: "wrong source device" } as GPUError);
        } else if (failure === "map") {
            vi.mocked(readTexturePixels).mockRejectedValueOnce(new Error("map failed"));
        } else if (failure === "upload") {
            f.device.popErrorScope.mockResolvedValueOnce(null).mockResolvedValueOnce({ message: "upload failed" } as GPUError);
        } else {
            f.device.queue.writeTexture.mockImplementationOnce(() => {
                throw new Error("sync write failed");
            });
        }
        await expect(processAreaLightTexture(f.engine, f.source)).rejects.toThrow(/failed|wrong source device/);
        expect(_textureOwners(f.source)).toBe(1);
        expect(f.texture.destroy).not.toHaveBeenCalled();
        expect(f.device.createTexture.mock.results[1]!.value.destroy).toHaveBeenCalledTimes(1);
        const retry = await processAreaLightTexture(f.engine, f.source);
        releaseTexture(retry);
        releaseTexture(f.source);
    });

    it.each(["release", "device"] as const)("rejects source %s during an awaited scale and never publishes a result", async (failure) => {
        const f = fixture();
        const wait = deferred<GPUError | null>();
        f.device.popErrorScope.mockReturnValueOnce(wait.promise);
        const work = processAreaLightTexture(f.engine, f.source);
        const rejected = expect(work).rejects.toThrow(failure === "release" ? /source was released/ : /device changed/);
        expect(_textureOwners(f.source)).toBe(1);
        if (failure === "release") {
            releaseTexture(f.source);
            expect(f.texture.destroy).toHaveBeenCalledTimes(1);
        } else {
            f.engine._device = fixture().engine._device;
        }
        wait.resolve(null);
        await rejected;
        expect(f.device.createTexture.mock.results[1]!.value.destroy).toHaveBeenCalledTimes(1);
        if (failure === "release") {
            expect(_textureOwners(f.source)).toBe(0);
            expect(f.texture.destroy).toHaveBeenCalledTimes(1);
        } else {
            expect(_textureOwners(f.source)).toBe(1);
            releaseTexture(f.source);
        }
    });

    it("actual in-place texture recovery transfers only persistent caller ownership, never a preprocessing claim or a release to the replacement", async () => {
        const f = fixture();
        const replacement = fixture();
        const state = {} as DeviceLostRecoveryState;
        f.engine._deviceLostRecovery = state;
        f.source._recoverySource = {
            kind: "pixels",
            width: 64,
            height: 32,
            data: new Uint8Array(64 * 32 * 4),
            options: { addressModeU: "repeat", minFilter: "nearest", magFilter: "nearest" },
        };
        const wait = deferred<GPUError | null>();
        f.device.popErrorScope.mockReturnValueOnce(wait.promise);
        const work = processAreaLightTexture(f.engine, f.source);
        const rejected = expect(work).rejects.toThrow(/device changed/);
        expect(_textureOwners(f.source)).toBe(1);
        f.engine._device = replacement.engine._device;
        await rebuildTexture2D(f.engine, f.source);
        const recovered = { ...f.source };
        expect(recovered.texture).not.toBe(f.texture);
        expect(state._pendingOwnership?.[0]?.[1]).toBe(1);
        wait.resolve(null);
        await rejected;
        expect(f.source).toEqual(recovered);
        expect(_textureOwners(f.source)).toBe(0);
        const replacementGpu = replacement.device.createTexture.mock.results.at(-1)!.value;
        expect(replacementGpu.destroy).not.toHaveBeenCalled();
        expect(_textureOwners({ ...f.source, texture: f.texture as unknown as GPUTexture })).toBe(1);
        settleRebuiltTextureOwnership(state);
        expect(_textureOwners(f.source)).toBe(1);
        expect(getTextureSamplerDescriptor(f.engine, f.source.sampler)).toMatchObject({ addressModeU: "repeat", minFilter: "nearest", magFilter: "nearest" });
        releaseTexture(f.source);
        expect(_textureOwners(f.source)).toBe(0);
        expect(replacementGpu.destroy).toHaveBeenCalledTimes(1);
        releaseTexture(replacement.source);
    });

    it("rejects malformed and already released inputs before creating effects or destinations", async () => {
        const f = fixture();
        f.source.width = 0;
        await expect(processAreaLightTexture(f.engine, f.source)).rejects.toThrow(/Texture2D/);
        expect(f.device.createTexture).toHaveBeenCalledTimes(1);
        f.source.width = 64;
        releaseTexture(f.source);
        await expect(processAreaLightTexture(f.engine, f.source)).rejects.toThrow(/released/);
        expect(f.device.createShaderModule).not.toHaveBeenCalled();
    });
});
