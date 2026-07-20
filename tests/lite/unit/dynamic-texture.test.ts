import { describe, expect, it } from "vitest";
import { createDynamicTexture, updateDynamicTexture, type DynamicTexture2D } from "../../../packages/babylon-lite/src/texture/dynamic-texture";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";

interface Captured {
    createDesc?: GPUTextureDescriptor;
    viewDesc?: GPUTextureViewDescriptor;
    samplerDesc?: GPUSamplerDescriptor;
    writeCalls: number;
    copyCalls: Array<{ src: GPUCopyExternalImageSourceInfo; dst: GPUCopyExternalImageDestInfo; size: GPUExtent3DStrict }>;
}

/** A fake canvas source (any external-image source works; the mock never reads it). */
function fakeSource(width = 8, height = 8): HTMLCanvasElement {
    return { width, height } as unknown as HTMLCanvasElement;
}

function makeEngine(cap: Captured): EngineContext {
    const device = {
        createTexture: (desc: GPUTextureDescriptor) => {
            cap.createDesc = desc;
            return {
                mipLevelCount: desc.mipLevelCount ?? 1,
                createView: (v?: GPUTextureViewDescriptor) => ((cap.viewDesc = v), { _kind: "view" }),
                destroy: () => undefined,
            } as unknown as GPUTexture;
        },
        createSampler: (desc: GPUSamplerDescriptor) => ((cap.samplerDesc = desc), { _kind: "sampler" } as unknown as GPUSampler),
        queue: {
            writeTexture: () => {
                cap.writeCalls++;
            },
            copyExternalImageToTexture: (src: GPUCopyExternalImageSourceInfo, dst: GPUCopyExternalImageDestInfo, size: GPUExtent3DStrict) => {
                cap.copyCalls.push({ src, dst, size });
            },
        },
    };
    return { _device: device as unknown as GPUDevice } as unknown as EngineContext;
}

function newCap(): Captured {
    return { writeCalls: 0, copyCalls: [] };
}

describe("createDynamicTexture", () => {
    it("allocates a blank, write-capable texture of the requested size (no upload)", () => {
        const cap = newCap();
        const tex = createDynamicTexture(makeEngine(cap), 256, 64);

        expect(cap.createDesc?.size).toEqual({ width: 256, height: 64 });
        expect(cap.createDesc?.format).toBe("rgba8unorm");
        expect(cap.createDesc?.mipLevelCount).toBe(1);
        // copyExternalImageToTexture requires COPY_DST | RENDER_ATTACHMENT on the destination.
        const usage = cap.createDesc?.usage ?? 0;
        expect(usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        expect(usage & GPUTextureUsage.TEXTURE_BINDING).toBeTruthy();
        // Blank: nothing is uploaded at creation.
        expect(cap.writeCalls).toBe(0);
        expect(cap.copyCalls).toHaveLength(0);
        expect(tex.width).toBe(256);
        expect(tex.height).toBe(64);
    });

    it("defaults to a linear + clamp-to-edge sampler with no mips", () => {
        const cap = newCap();
        createDynamicTexture(makeEngine(cap), 32, 32);
        expect(cap.samplerDesc?.minFilter).toBe("linear");
        expect(cap.samplerDesc?.magFilter).toBe("linear");
        expect(cap.samplerDesc?.addressModeU).toBe("clamp-to-edge");
        expect(cap.samplerDesc?.addressModeV).toBe("clamp-to-edge");
    });

    it("honours sRGB, sampler, and mip options", () => {
        const cap = newCap();
        createDynamicTexture(makeEngine(cap), 64, 64, { srgb: true, mipMaps: true, minFilter: "nearest", addressModeU: "repeat" });
        expect(cap.createDesc?.format).toBe("rgba8unorm-srgb");
        expect(cap.createDesc?.mipLevelCount).toBe(7); // log2(64)+1
        expect(cap.samplerDesc?.minFilter).toBe("nearest");
        expect(cap.samplerDesc?.addressModeU).toBe("repeat");
    });

    it("rejects sub-1 dimensions", () => {
        expect(() => createDynamicTexture(makeEngine(newCap()), 0, 8)).toThrow(/>= 1/);
    });
});

describe("updateDynamicTexture", () => {
    it("blits the source with flipY (Y-up default) and no CPU readback", () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        const tex = createDynamicTexture(engine, 128, 32);
        const source = fakeSource(128, 32);
        updateDynamicTexture(engine, tex, source);

        expect(cap.writeCalls).toBe(0); // never reads back / re-uploads bytes
        expect(cap.copyCalls).toHaveLength(1);
        const call = cap.copyCalls[0]!;
        expect((call.src as { source: unknown; flipY?: boolean }).source).toBe(source);
        expect((call.src as { flipY?: boolean }).flipY).toBe(true);
        expect((call.dst as { premultipliedAlpha?: boolean }).premultipliedAlpha).toBe(false);
        expect(call.size).toEqual([128, 32]);
    });

    it("honours invertY:false and premultiplyAlpha:true", () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        const tex = createDynamicTexture(engine, 16, 16);
        updateDynamicTexture(engine, tex, fakeSource(16, 16), { invertY: false, premultiplyAlpha: true });
        const call = cap.copyCalls[0]!;
        expect((call.src as { flipY?: boolean }).flipY).toBe(false);
        expect((call.dst as { premultipliedAlpha?: boolean }).premultipliedAlpha).toBe(true);
    });
});

describe("DynamicTexture2D brand", () => {
    it("only accepts a createDynamicTexture result (compile-time)", () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        const dyn = createDynamicTexture(engine, 8, 8);
        updateDynamicTexture(engine, dyn, fakeSource()); // ✅ branded

        const plain: Texture2D = { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 8, height: 8 };
        // @ts-expect-error a plain Texture2D lacks the dynamic-texture brand
        updateDynamicTexture(engine, plain, fakeSource());

        // Assignable the other way: a DynamicTexture2D is a Texture2D.
        const asBase: Texture2D = dyn;
        expect(asBase.width).toBe(8);
        // Type-only guard so the unused-import lint stays quiet.
        const _typed: DynamicTexture2D = dyn;
        expect(_typed).toBe(dyn);
    });
});
