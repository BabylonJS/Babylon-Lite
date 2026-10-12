import { describe, expect, it } from "vitest";
import { createSolidTexture2D } from "../../../packages/babylon-lite/src/texture/solid-texture";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface Captured {
    createDesc?: GPUTextureDescriptor;
    writeData?: ArrayBufferView;
    destroyed: number;
}

function makeEngine(cap: Captured): EngineContext {
    const device = {
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                createView: () => ({ _kind: "view" }) as unknown as GPUTextureView,
                destroy: () => {
                    cap.destroyed++;
                },
            } as unknown as GPUTexture;
        },
        createSampler: () => ({ _kind: "sampler" }) as unknown as GPUSampler,
        queue: {
            writeTexture: (_dst: unknown, data: ArrayBufferView) => {
                cap.writeData = data;
            },
        },
    } as unknown as GPUDevice;
    return { _device: device } as unknown as EngineContext;
}

describe("createSolidTexture2D", () => {
    it("writes the colour as straight RGBA8 into a 1x1 texture", () => {
        const cap: Captured = { destroyed: 0 };
        const engine = makeEngine(cap);

        createSolidTexture2D(engine, 1, 0.5, 0, 1);

        expect(cap.createDesc?.size).toEqual({ width: 1, height: 1 });
        expect(cap.createDesc?.format).toBe("rgba8unorm");
        expect(Array.from(cap.writeData as Uint8Array)).toEqual([255, 128, 0, 255]);
    });

    it("takes a creation-time ownership ref so the texture outlives its materials", () => {
        const cap: Captured = { destroyed: 0 };
        const engine = makeEngine(cap);

        // Creation acquire → ref 1. Without it the ref count starts at 0 and the first
        // release below would destroy a texture the material still points at, leaving
        // every later frame submitting a dead texture.
        const tex = createSolidTexture2D(engine, 1, 1, 1, 1);

        acquireTexture(tex); // a mesh's renderable binds it → ref 2
        expect(releaseTexture(tex)).toBe(false); // that mesh leaves the scene → ref 1, survives
        expect(cap.destroyed).toBe(0);
    });

    it("survives every mesh releasing it and is destroyed only when the creator releases too", () => {
        const cap: Captured = { destroyed: 0 };
        const engine = makeEngine(cap);
        const tex = createSolidTexture2D(engine, 0.2, 0.2, 0.2, 1);

        // Two meshes share the material's solid texture, then both go away.
        acquireTexture(tex);
        acquireTexture(tex);
        expect(releaseTexture(tex)).toBe(false);
        expect(releaseTexture(tex)).toBe(false);
        expect(cap.destroyed).toBe(0);

        // Only the creator's own release frees it.
        expect(releaseTexture(tex)).toBe(true);
        expect(cap.destroyed).toBe(1);
    });
});
