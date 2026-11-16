import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";
import type * as EnvHelpers from "../../../packages/babylon-lite/src/loader-env/env-helpers";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { loadProceduralSkyEnvironment, updateProceduralSkyEnvironment } from "../../../packages/babylon-lite/src/loader-env/procedural-sky-environment";

const mocks = vi.hoisted(() => {
    let releaseModule!: () => void;
    let moduleStarted!: () => void;
    return {
        moduleGate: new Promise<void>((resolve) => {
            releaseModule = resolve;
        }),
        moduleEntered: new Promise<void>((resolve) => {
            moduleStarted = resolve;
        }),
        releaseModule: () => releaseModule(),
        moduleStarted: () => moduleStarted(),
        loadBrdfImage: vi.fn<(...args: unknown[]) => Promise<ImageBitmap>>(),
        decodeBrdfPng: vi.fn<(...args: unknown[]) => GPUTexture>(),
        prepareMipmaps: vi.fn(() => []),
        recordPreparedMipmaps: vi.fn(),
    };
});

vi.mock("../../../packages/babylon-lite/src/loader-env/env-helpers.js", async (importOriginal) => ({
    ...(await importOriginal<typeof EnvHelpers>()),
    loadBrdfImage: mocks.loadBrdfImage,
}));
vi.mock("../../../packages/babylon-lite/src/loader-env/rgbd-decode.js", async () => {
    mocks.moduleStarted();
    await mocks.moduleGate;
    return { decodeBrdfPng: mocks.decodeBrdfPng };
});
vi.mock("../../../packages/babylon-lite/src/texture/mipmap-preparation.js", () => ({
    prepareMipmaps: mocks.prepareMipmaps,
    recordPreparedMipmaps: mocks.recordPreparedMipmaps,
}));

const options = {
    sunDirection: [0.35, 0.82, 0.45] as const,
    luminance: 1,
    turbidity: 10,
    rayleigh: 2,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
    brdfUrl: "/brdf.png",
    _yield: async () => undefined,
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function bitmap(): ImageBitmap {
    return { close: vi.fn() } as unknown as ImageBitmap;
}

function texture(): GPUTexture {
    return { createView: () => ({}) as GPUTextureView, destroy: vi.fn() } as unknown as GPUTexture;
}

function fixture() {
    const cubes: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    const brdfs: GPUTexture[] = [];
    const images: ImageBitmap[] = [];
    mocks.loadBrdfImage.mockImplementation(async () => {
        const image = bitmap();
        images.push(image);
        return image;
    });
    mocks.decodeBrdfPng.mockImplementation(() => {
        const brdf = texture();
        brdfs.push(brdf);
        return brdf;
    });
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const device = {
        createTexture: vi.fn(() => {
            const cube = texture();
            cubes.push(cube);
            return cube;
        }),
        createBuffer: vi.fn(() => {
            const buffer = { destroy: vi.fn() } as unknown as GPUBuffer;
            buffers.push(buffer);
            return buffer;
        }),
        createShaderModule: vi.fn(() => ({}) as GPUShaderModule),
        createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) }) as unknown as GPUComputePipeline),
        createBindGroup: vi.fn(() => ({}) as GPUBindGroup),
        createSampler: vi.fn(() => ({}) as GPUSampler),
        createCommandEncoder: vi.fn(() => ({ beginComputePass: () => pass, finish: () => ({}) }) as unknown as GPUCommandEncoder),
        queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    };
    const engine = { _device: device } as unknown as EngineContext;
    const scene = { surface: { engine }, _disposables: [], _frameGraph: { _tasks: [] } } as unknown as SceneContext;
    const disposeScene = () => {
        scene._z = true;
        for (const dispose of scene._disposables.splice(0)) {
            dispose();
        }
    };
    return { scene, device, cubes, buffers, brdfs, images, disposeScene };
}

describe("procedural sky scene lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // The lazy decoder's first import is deliberately held to exercise that await boundary.
    it("cancels during decoder-module loading and closes the already-loaded bitmap", async () => {
        const f = fixture();
        const loading = loadProceduralSkyEnvironment(f.scene, options);
        await mocks.moduleEntered;
        f.disposeScene();
        mocks.releaseModule();
        await expect(loading).rejects.toThrow(/cancelled/);
        expect(f.images[0]!.close).toHaveBeenCalledOnce();
        expect(mocks.decodeBrdfPng).not.toHaveBeenCalled();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(f.scene._disposables).toHaveLength(0);
    });

    it("reserves the scene before the first await and rejects a simultaneous second load", async () => {
        const f = fixture();
        const gate = deferred<void>();
        const first = loadProceduralSkyEnvironment(f.scene, { ...options, _yield: () => gate.promise });
        await expect(loadProceduralSkyEnvironment(f.scene, options)).rejects.toThrow(/already loading/);
        expect(mocks.loadBrdfImage).toHaveBeenCalledOnce();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        gate.resolve();
        const environment = await first;
        expect(f.scene._envTextures).toBe(environment._textures);
        expect(f.scene._disposables).toHaveLength(1);
        f.disposeScene();
        expect(environment._disposed).toBe(true);
        for (const resource of [...f.cubes, ...f.brdfs, ...f.buffers]) {
            expect(resource.destroy).toHaveBeenCalledOnce();
        }
    });

    it("stops a load disposed during irradiance integration before GPU allocation", async () => {
        const f = fixture();
        const gate = deferred<void>();
        const loading = loadProceduralSkyEnvironment(f.scene, { ...options, _yield: () => gate.promise });
        await Promise.resolve();
        f.disposeScene();
        gate.resolve();
        await expect(loading).rejects.toThrow(/cancelled/);
        expect(f.images[0]!.close).toHaveBeenCalledOnce();
        expect(mocks.decodeBrdfPng).not.toHaveBeenCalled();
        expect(f.device.createTexture).not.toHaveBeenCalled();
    });

    it("closes a bitmap that arrives after scene disposal", async () => {
        const f = fixture();
        const imageReady = deferred<ImageBitmap>();
        mocks.loadBrdfImage.mockReturnValueOnce(imageReady.promise);
        const loading = loadProceduralSkyEnvironment(f.scene, options);
        f.disposeScene();
        const lateImage = bitmap();
        imageReady.resolve(lateImage);
        await expect(loading).rejects.toThrow(/cancelled/);
        expect(lateImage.close).toHaveBeenCalledOnce();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(f.scene._disposables).toHaveLength(0);
    });

    it("cleans a late bitmap after a sibling failure without interfering with a successful retry", async () => {
        const f = fixture();
        const imageReady = deferred<ImageBitmap>();
        mocks.loadBrdfImage.mockReturnValueOnce(imageReady.promise);
        await expect(
            loadProceduralSkyEnvironment(f.scene, {
                ...options,
                _yield: async () => {
                    throw new Error("irradiance failed");
                },
            })
        ).rejects.toThrow("irradiance failed");
        expect(f.scene._disposables).toHaveLength(0);
        const retry = await loadProceduralSkyEnvironment(f.scene, options);
        const lateImage = bitmap();
        imageReady.resolve(lateImage);
        await Promise.resolve();
        expect(lateImage.close).toHaveBeenCalledOnce();
        expect(f.scene._envTextures).toBe(retry._textures);
        expect(f.scene._disposables).toHaveLength(1);
        expect(retry._disposed).toBe(false);
        f.disposeScene();
    });

    it.each(["registered", "environment"] as const)("rejects ownership lost to a %s scene during loading", async (change) => {
        const f = fixture();
        const gate = deferred<void>();
        const loading = loadProceduralSkyEnvironment(f.scene, { ...options, _yield: () => gate.promise });
        const other = {} as EnvironmentTextures;
        if (change === "registered") {
            f.scene._built = true;
        } else {
            f.scene._envTextures = other;
        }
        gate.resolve();
        await expect(loading).rejects.toThrow(/cancelled/);
        expect(f.device.createTexture).not.toHaveBeenCalled();
        if (change === "environment") {
            expect(f.scene._envTextures).toBe(other);
        }
        expect(f.scene._disposables).toHaveLength(0);
    });

    it.each(["pipeline", "buffer", "upload", "submit"] as const)("cleans local resources after a %s failure and allows retry", async (failure) => {
        const f = fixture();
        const fail = () => {
            throw new Error(`${failure} failed`);
        };
        if (failure === "pipeline") f.device.createComputePipeline.mockImplementationOnce(fail);
        if (failure === "buffer") f.device.createBuffer.mockImplementationOnce(fail);
        if (failure === "upload") f.device.queue.writeBuffer.mockImplementationOnce(fail);
        if (failure === "submit") f.device.queue.submit.mockImplementationOnce(fail);
        await expect(loadProceduralSkyEnvironment(f.scene, options)).rejects.toThrow(`${failure} failed`);
        for (const resource of [...f.cubes, ...f.brdfs, ...f.buffers]) {
            expect(resource.destroy).toHaveBeenCalledOnce();
        }
        expect(f.images[0]!.close).toHaveBeenCalledOnce();
        expect(f.scene._envTextures).toBeUndefined();
        expect(f.scene._disposables).toHaveLength(0);
        const environment = await loadProceduralSkyEnvironment(f.scene, options);
        expect(f.scene._envTextures).toBe(environment._textures);
        f.disposeScene();
    });

    it("rejects updates after disposal and cancels an update already in progress without submitting", async () => {
        const f = fixture();
        const gate = deferred<void>();
        let pause = false;
        const environment = await loadProceduralSkyEnvironment(f.scene, { ...options, _yield: () => (pause ? gate.promise : Promise.resolve()) });
        const before = Array.from(environment._textures.irradianceSH);
        f.device.queue.submit.mockClear();
        f.device.queue.writeBuffer.mockClear();
        pause = true;
        const updating = updateProceduralSkyEnvironment(environment, { ...options, turbidity: 5 });
        f.disposeScene();
        gate.resolve();
        await expect(updating).rejects.toThrow(/disposed/);
        await expect(updateProceduralSkyEnvironment(environment, options)).rejects.toThrow(/disposed/);
        expect(f.device.queue.submit).not.toHaveBeenCalled();
        expect(f.device.queue.writeBuffer).not.toHaveBeenCalled();
        expect(Array.from(environment._textures.irradianceSH)).toEqual(before);
        await expect(loadProceduralSkyEnvironment(f.scene, options)).rejects.toThrow(/disposed/);
    });

    it("rejects updates as soon as scene disposal begins, before deferred cleanup runs", async () => {
        const f = fixture();
        const environment = await loadProceduralSkyEnvironment(f.scene, options);
        f.scene._z = true;
        expect(environment._disposed).toBe(false);
        f.device.queue.submit.mockClear();
        f.device.queue.writeBuffer.mockClear();
        await expect(updateProceduralSkyEnvironment(environment, options)).rejects.toThrow(/disposed/);
        expect(f.device.queue.submit).not.toHaveBeenCalled();
        expect(f.device.queue.writeBuffer).not.toHaveBeenCalled();
        f.disposeScene();
        expect(environment._disposed).toBe(true);
    });

    it("cleans a decoder result returned after ownership is lost inside the decoder", async () => {
        const f = fixture();
        const brdf = texture();
        mocks.decodeBrdfPng.mockImplementationOnce(() => {
            f.disposeScene();
            return brdf;
        });
        await expect(loadProceduralSkyEnvironment(f.scene, options)).rejects.toThrow(/cancelled/);
        expect(brdf.destroy).toHaveBeenCalledOnce();
        expect(f.images[0]!.close).toHaveBeenCalledOnce();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(f.scene._disposables).toHaveLength(0);
    });
});
