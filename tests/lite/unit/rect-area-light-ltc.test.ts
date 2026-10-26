import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene.js";

function fixture() {
    const textures: Array<{ createView: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
        createTexture: vi.fn((_descriptor: GPUTextureDescriptor) => {
            const texture = { createView: vi.fn(() => ({ label: `view-${textures.length}` })), destroy: vi.fn() };
            textures.push(texture);
            return texture;
        }),
        createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        queue: { writeTexture: vi.fn() },
    };
    const engine = { _device: device } as unknown as EngineContext;
    const scene = { surface: { engine }, lights: [], _disposables: [] } as unknown as SceneContext;
    return { engine, scene, device, textures };
}

function payload(): ArrayBuffer {
    const data = new ArrayBuffer(65536);
    const view = new DataView(data);
    for (let i = 0; i < 32768; i++) {
        view.setUint16(i * 2, (0x1234 + i) & 65535, true);
    }
    return data;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.resetModules();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("area LTC data and lifetime", () => {
    it("rejects public dispose-before-first-enable without creating an owner, disposer, fetch, or GPU texture", async () => {
        const { createSceneContext, disposeScene } = await import("../../../packages/babylon-lite/src/scene/scene.js");
        const { enableRectAreaLights } = await import("../../../packages/babylon-lite/src/light/enable-rect-area-lights.js");
        const { prepareAreaLightLtc, hasAreaLightLtcOwner } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const { engine, device } = fixture();
        Object.assign(engine, { engine, _renderingContexts: [] });
        const scene = createSceneContext(engine, { defaultRenderTask: false });
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        disposeScene(scene);
        expect(scene._z).toBe(true);
        await expect(enableRectAreaLights(scene)).rejects.toThrow(/disposed/);
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow(/disposed/);
        expect(hasAreaLightLtcOwner(scene)).toBe(false);
        expect(scene._disposables).toHaveLength(0);
        expect(fetcher).not.toHaveBeenCalled();
        expect(device.createTexture).not.toHaveBeenCalled();
    });
    it("deinterleaves exact little-endian uint16 words, including the final texel", async () => {
        const { decodeAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const [a, b] = decodeAreaLightLtc(payload());
        expect(a.length).toBe(16384);
        expect(b.length).toBe(16384);
        expect(Array.from(a.slice(0, 8))).toEqual([0x1234, 0x1235, 0x1236, 0x1237, 0x123c, 0x123d, 0x123e, 0x123f]);
        expect(Array.from(b.slice(0, 4))).toEqual([0x1238, 0x1239, 0x123a, 0x123b]);
        expect(b[16383]).toBe((0x1234 + 32767) & 65535);
    });

    it.each([0, 65535, 65537, 131072])("rejects payload size %i", async (size) => {
        const { decodeAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        expect(() => decodeAreaLightLtc(new ArrayBuffer(size))).toThrow(/65536 bytes/);
    });

    it("deduplicates concurrent fetch/upload and matches half-float upload and linear clamp descriptors", async () => {
        const { prepareAreaLightLtc, bindAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const response = deferred<Response>();
        const fetcher = vi.fn(() => response.promise);
        vi.stubGlobal("fetch", fetcher);
        const { engine, scene, device, textures } = fixture();
        const other: SceneContext = { ...scene, _disposables: [] };
        const first = prepareAreaLightLtc(scene);
        expect(prepareAreaLightLtc(scene)).toBe(first);
        const second = prepareAreaLightLtc(other);
        response.resolve(new Response(payload()));
        await Promise.all([first, second]);
        expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin");
        expect(device.createTexture).toHaveBeenCalledTimes(2);
        expect(device.createTexture.mock.calls[0]![0]).toMatchObject({ size: [64, 64], format: "rgba16float", mipLevelCount: 1, usage: 6 });
        expect(device.queue.writeTexture.mock.calls[0]![1]).toBeInstanceOf(Uint16Array);
        expect(device.queue.writeTexture.mock.calls[0]![2]).toEqual({ bytesPerRow: 512, rowsPerImage: 64 });
        expect(device.createSampler.mock.calls[0]![0]).toMatchObject({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
        const entries: GPUBindGroupEntry[] = [];
        expect(bindAreaLightLtc(engine, entries, 7)).toBe(11);
        expect(entries.map((entry) => entry.binding)).toEqual([7, 8, 9, 10]);
        scene._disposables.forEach((dispose) => dispose());
        expect(textures[0]!.destroy).not.toHaveBeenCalled();
        other._disposables.forEach((dispose) => dispose());
        expect(textures[0]!.destroy).toHaveBeenCalledTimes(1);
        expect(textures[1]!.destroy).toHaveBeenCalledTimes(1);
        expect(() => bindAreaLightLtc(engine, [], 0)).toThrow(/current device/);
        other._disposables.forEach((dispose) => dispose());
        expect(textures[0]!.destroy).toHaveBeenCalledTimes(1);
    });

    it("surfaces HTTP/decode failures and allows retry without caching rejected requests", async () => {
        const { prepareAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(new ArrayBuffer(2)))
            .mockResolvedValueOnce(new Response(payload()));
        vi.stubGlobal("fetch", fetcher);
        const { scene } = fixture();
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow(/503/);
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow(/65536 bytes/);
        await expect(prepareAreaLightLtc(scene)).resolves.toBeUndefined();
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(scene._disposables).toHaveLength(1);
    });

    it("never uploads into a scene disposed during fetch", async () => {
        const { prepareAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const response = deferred<Response>();
        vi.stubGlobal(
            "fetch",
            vi.fn(() => response.promise)
        );
        const { scene, device } = fixture();
        const work = prepareAreaLightLtc(scene);
        const rejected = expect(work).rejects.toThrow(/disposed/);
        scene._disposables.forEach((dispose) => dispose());
        response.resolve(new Response(payload()));
        await rejected;
        expect(device.createTexture).not.toHaveBeenCalled();
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow(/disposed/);
    });

    it("destroys partial uploads on synchronous GPU failures and retries using cached CPU data", async () => {
        const { prepareAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const fetcher = vi.fn(async () => new Response(payload()));
        vi.stubGlobal("fetch", fetcher);
        const { scene, device, textures } = fixture();
        device.queue.writeTexture.mockImplementationOnce(() => {
            throw new Error("write failed");
        });
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow("write failed");
        expect(textures[0]!.destroy).toHaveBeenCalledTimes(1);
        await prepareAreaLightLtc(scene);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(textures).toHaveLength(3);
    });

    it("releases failed validation-scope uploads and surfaces GPU error messages", async () => {
        const { prepareAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(payload()))
        );
        const { scene, device, textures } = fixture();
        device.popErrorScope.mockResolvedValueOnce({ message: "bad texture" } as never);
        await expect(prepareAreaLightLtc(scene)).rejects.toThrow(/GPU upload failed: bad texture/);
        expect(textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
        await expect(prepareAreaLightLtc(scene)).resolves.toBeUndefined();
    });

    it("recreates device-specific handles and releases the old ownership without refetching", async () => {
        const { prepareAreaLightLtc, bindAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        const fetcher = vi.fn(async () => new Response(payload()));
        vi.stubGlobal("fetch", fetcher);
        const first = fixture();
        await prepareAreaLightLtc(first.scene);
        const second = fixture();
        first.engine._device = second.engine._device;
        expect(() => bindAreaLightLtc(first.engine, [], 0)).toThrow(/current device/);
        await prepareAreaLightLtc(first.scene);
        expect(first.textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
        expect(second.device.createTexture).toHaveBeenCalledTimes(2);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(bindAreaLightLtc(first.engine, [], 0)).toBe(4);
        first.scene._disposables.forEach((dispose) => dispose());
        expect(second.textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
    });

    it("cleans up when scene disposal occurs while validation is pending", async () => {
        const { prepareAreaLightLtc } = await import("../../../packages/babylon-lite/src/light/area-light-ltc.js");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(payload()))
        );
        const { scene, device, textures } = fixture();
        const validation = deferred<null>();
        device.popErrorScope.mockReturnValueOnce(validation.promise);
        const work = prepareAreaLightLtc(scene);
        const rejected = expect(work).rejects.toThrow(/disposed/);
        await vi.waitFor(() => expect(textures).toHaveLength(2));
        scene._disposables.forEach((dispose) => dispose());
        validation.resolve(null);
        await rejected;
        expect(textures.every((texture) => texture.destroy.mock.calls.length === 1)).toBe(true);
    });
});
