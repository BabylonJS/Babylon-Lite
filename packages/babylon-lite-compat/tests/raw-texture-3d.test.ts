import { describe, expect, it, vi } from "vitest";

/**
 * `RawTexture3D` wraps Babylon Lite's `createTexture3DFromPixels` (the volumetric
 * analog of `createTexture2DFromPixels`, used for colour-grading LUTs / colour cubes).
 * The real upload needs a GPU device, so these tests mock the Lite factory to a
 * plain handle and verify the compat wrapper's pure surface GPU-free: argument
 * forwarding, byte coercion (null → zero volume, ArrayBufferView → RGBA bytes),
 * the `width`/`height`/`depth` getters, and `update` re-uploading.
 */
vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        createTexture3DFromPixels: vi.fn((_engine: unknown, data: Uint8Array, width: number, height: number, depth: number) => ({
            width,
            height,
            depth,
            _data: data,
        })),
    };
});

import { createTexture3DFromPixels } from "babylon-lite";
import { RawTexture3D, BaseTexture } from "../src/textures/textures";

const createTexture3DFromPixelsMock = vi.mocked(createTexture3DFromPixels);

/** Minimal `Scene` stand-in exposing only the engine handle `RawTexture3D` reads. */
function fakeScene(): { getEngine(): { _lite: object } } {
    const engine = { _lite: {} };
    return { getEngine: () => engine };
}

describe("RawTexture3D", () => {
    it("is a BaseTexture flagged as 3D with BJS class name", () => {
        const tex = new RawTexture3D(new Uint8Array(2 * 2 * 2 * 4), 2, 2, 2, 5, fakeScene() as never);
        expect(tex).toBeInstanceOf(BaseTexture);
        expect(tex.getClassName()).toBe("RawTexture3D");
        expect(tex.is3D).toBe(true);
        // The BJS `format` argument is recorded for parity.
        expect(tex.format).toBe(5);
    });

    it("forwards the RGBA byte buffer and dimensions to the Lite factory", () => {
        createTexture3DFromPixelsMock.mockClear();
        const data = new Uint8Array(4 * 4 * 4 * 4);
        const tex = new RawTexture3D(data, 4, 4, 4, 5, fakeScene() as never);
        expect(createTexture3DFromPixelsMock).toHaveBeenCalledTimes(1);
        const call = createTexture3DFromPixelsMock.mock.calls[0]!;
        expect(call[1]).toBe(data);
        expect([call[2], call[3], call[4]]).toEqual([4, 4, 4]);
        expect(tex.width).toBe(4);
        expect(tex.height).toBe(4);
        expect(tex.depth).toBe(4);
    });

    it("coerces a null data argument into a zero-filled RGBA volume", () => {
        createTexture3DFromPixelsMock.mockClear();
        new RawTexture3D(null, 2, 3, 4, 5, fakeScene() as never);
        const bytes = createTexture3DFromPixelsMock.mock.calls[0]![1];
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBe(2 * 3 * 4 * 4);
        expect(bytes.every((b) => b === 0)).toBe(true);
    });

    it("coerces a non-Uint8Array ArrayBufferView into a tightly packed byte view over the same buffer", () => {
        createTexture3DFromPixelsMock.mockClear();
        // A Float32Array of four values (16 bytes) backing a 1x1x1 volume, which only
        // needs width*height*depth*4 = 4 RGBA8 bytes. The helper trims the trailing
        // bytes so the upload stays tightly packed, without copying off the buffer.
        const view = new Float32Array([1, 2, 3, 4]);
        new RawTexture3D(view, 1, 1, 1, 5, fakeScene() as never);
        const bytes = createTexture3DFromPixelsMock.mock.calls[0]![1];
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBe(4);
        expect(bytes.buffer).toBe(view.buffer);
    });

    it("re-uploads on update() using the recorded dimensions", () => {
        const tex = new RawTexture3D(new Uint8Array(1 * 1 * 1 * 4), 1, 1, 1, 5, fakeScene() as never);
        createTexture3DFromPixelsMock.mockClear();
        const next = new Uint8Array(1 * 1 * 1 * 4).fill(255);
        tex.update(next);
        expect(createTexture3DFromPixelsMock).toHaveBeenCalledTimes(1);
        const call = createTexture3DFromPixelsMock.mock.calls[0]!;
        expect(call[1]).toBe(next);
        expect([call[2], call[3], call[4]]).toEqual([1, 1, 1]);
    });

    it("resolves whenReadyAsync immediately (synchronous GPU handle)", async () => {
        const tex = new RawTexture3D(new Uint8Array(1 * 1 * 1 * 4), 1, 1, 1, 5, fakeScene() as never);
        await expect(tex.whenReadyAsync()).resolves.toBeUndefined();
    });
});
