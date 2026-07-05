import { describe, expect, it } from "vitest";
import { createTexture3DFromPixels } from "../../../packages/babylon-lite/src/texture/pixels-texture";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface Captured {
    createDesc?: GPUTextureDescriptor;
    writeSize?: GPUExtent3DStrict;
    writeLayout?: GPUTexelCopyBufferLayout;
    viewDesc?: GPUTextureViewDescriptor;
    samplerDesc?: GPUSamplerDescriptor;
}

function makeEngine(cap: Captured): EngineContext {
    const device = {
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return { createView: (v?: GPUTextureViewDescriptor) => ((cap.viewDesc = v), { _kind: "view" }), destroy: () => undefined } as unknown as GPUTexture;
        },
        queue: {
            writeTexture: (_dst: unknown, _data: unknown, layout: GPUTexelCopyBufferLayout, size: GPUExtent3DStrict) => {
                cap.writeLayout = layout;
                cap.writeSize = size;
            },
        },
        createSampler: (desc: GPUSamplerDescriptor) => ((cap.samplerDesc = desc), { _kind: "sampler" } as unknown as GPUSampler),
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

describe("createTexture3DFromPixels", () => {
    it("uploads a 3D texture and returns a handle with depth + a 3d view", () => {
        const cap: Captured = {};
        const engine = makeEngine(cap);
        const data = new Uint8Array(2 * 2 * 2 * 4);

        const tex = createTexture3DFromPixels(engine, data, 2, 2, 2);

        expect(cap.createDesc?.dimension).toBe("3d");
        expect(cap.createDesc?.size).toEqual({ width: 2, height: 2, depthOrArrayLayers: 2 });
        expect(cap.createDesc?.format).toBe("rgba8unorm");
        expect(cap.writeLayout).toEqual({ bytesPerRow: 2 * 4, rowsPerImage: 2 });
        expect(cap.writeSize).toEqual({ width: 2, height: 2, depthOrArrayLayers: 2 });
        expect(cap.viewDesc).toEqual({ dimension: "3d" });
        expect(tex.depth).toBe(2);
        expect(tex.width).toBe(2);
        expect(tex.height).toBe(2);
    });

    it("defaults to a linear clamp-to-edge sampler on all three axes", () => {
        const cap: Captured = {};
        createTexture3DFromPixels(makeEngine(cap), new Uint8Array(4), 1, 1, 1);

        expect(cap.samplerDesc).toMatchObject({
            addressModeU: "clamp-to-edge",
            addressModeV: "clamp-to-edge",
            addressModeW: "clamp-to-edge",
            minFilter: "linear",
            magFilter: "linear",
        });
    });

    it("honors srgb, filter and addressMode overrides", () => {
        const cap: Captured = {};
        createTexture3DFromPixels(makeEngine(cap), new Uint8Array(4), 1, 1, 1, { srgb: true, filter: "nearest", addressMode: "repeat" });

        expect(cap.createDesc?.format).toBe("rgba8unorm-srgb");
        expect(cap.samplerDesc).toMatchObject({ addressModeW: "repeat", minFilter: "nearest", magFilter: "nearest" });
    });

    it("throws on a degenerate dimension", () => {
        expect(() => createTexture3DFromPixels(makeEngine({}), new Uint8Array(4), 0, 1, 1)).toThrow(/>= 1/);
    });

    it("throws when the buffer is too short for width*height*depth*4", () => {
        expect(() => createTexture3DFromPixels(makeEngine({}), new Uint8Array(4 * 2 * 2 * 2 - 1), 2, 2, 2)).toThrow(/data too short/);
    });
});
