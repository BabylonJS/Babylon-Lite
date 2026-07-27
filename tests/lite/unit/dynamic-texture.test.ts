import { describe, expect, it } from "vitest";
import { createDynamicTexture, updateDynamicTexture, type DynamicTexture2D } from "../../../packages/babylon-lite/src/texture/dynamic-texture";
import { rebuildDynamicTexture2D } from "../../../packages/babylon-lite/src/texture/dynamic-texture-recovery";
import { acquireTexture, releaseTexture } from "../../../packages/babylon-lite/src/resource/gpu-pool";
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

function makeEngine(cap: Captured, opts: { throwOnCopy?: boolean } = {}): EngineContext {
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
                if (opts.throwOnCopy) {
                    // Mirrors WebGPU throwing InvalidStateError when the source (e.g. a
                    // closed ImageBitmap/VideoFrame) is no longer usable.
                    throw new DOMException("source is detached", "InvalidStateError");
                }
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

describe("createDynamicTexture device-lost recovery", () => {
    /** Enable recovery by making `engine._dlr` truthy. createDynamicTexture stamps
     *  the recovery source (pure data only — no logic) inline when it is. */
    function withRecovery(engine: EngineContext): void {
        (engine as unknown as { _dlr: unknown })._dlr = {};
    }

    it("registers a pure-data 'dynamic' recovery source (creation params, no logic)", () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        withRecovery(engine);
        const tex = createDynamicTexture(engine, 64, 32, { srgb: true, mipMaps: true });

        const src = (tex as unknown as { _recoverySource?: Record<string, unknown> })._recoverySource;
        expect(src?.kind).toBe("dynamic");
        expect(src?.source).toBeNull(); // no source retained until the first update
        expect(src?.width).toBe(64);
        expect(src?.height).toBe(32);
        expect(src?.format).toBe("rgba8unorm-srgb");
        expect(src?.levels).toBe(7); // log2(64)+1
        expect(src?.samplerDesc).toBeDefined();
        // The rebuild logic is NOT stamped here; it lives in the recovery module.
        expect(src?.rebuild).toBeUndefined();
    });

    it("rebuildDynamicTexture2D re-allocates with the same format/mips/usage", async () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        withRecovery(engine);
        const tex = createDynamicTexture(engine, 64, 32, { srgb: true, mipMaps: true });

        cap.createDesc = undefined as GPUTextureDescriptor | undefined;
        await rebuildDynamicTexture2D(engine, tex);
        expect(cap.createDesc?.format).toBe("rgba8unorm-srgb");
        expect(cap.createDesc?.mipLevelCount).toBe(7); // log2(64)+1
        const usage = cap.createDesc?.usage ?? 0;
        expect(usage & GPUTextureUsage.COPY_DST).toBeTruthy();
        expect(usage & GPUTextureUsage.RENDER_ATTACHMENT).toBeTruthy();
        // No source retained yet, so the blank rebuild performs no blit.
        expect(cap.copyCalls).toHaveLength(0);
    });

    it("does not touch _recoverySource when recovery is disabled", () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        const tex = createDynamicTexture(engine, 8, 8);
        expect((tex as unknown as { _recoverySource?: unknown })._recoverySource).toBeUndefined();
    });

    it("refreshes the retained source on update so a rebuild re-blits latest pixels", async () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        withRecovery(engine);
        const tex = createDynamicTexture(engine, 16, 16);
        const source = fakeSource(16, 16);
        updateDynamicTexture(engine, tex, source, { invertY: false, premultiplyAlpha: true });

        const src = (
            tex as unknown as {
                _recoverySource?: { source: unknown; flipY: boolean; premultipliedAlpha: boolean };
            }
        )._recoverySource;
        expect(src?.source).toBe(source);
        expect(src?.flipY).toBe(false);
        expect(src?.premultipliedAlpha).toBe(true);

        // A rebuild now re-blits the retained source with its flip/premultiply flags.
        cap.copyCalls.length = 0;
        await rebuildDynamicTexture2D(engine, tex);
        expect(cap.copyCalls).toHaveLength(1);
        const call = cap.copyCalls[0]!;
        expect((call.src as { source: unknown; flipY?: boolean }).source).toBe(source);
        expect((call.src as { flipY?: boolean }).flipY).toBe(false);
        expect((call.dst as { premultipliedAlpha?: boolean }).premultipliedAlpha).toBe(true);
    });

    it("survives a closed retained source: degrades to blank instead of aborting recovery", async () => {
        const cap = newCap();
        const engine = makeEngine(cap, { throwOnCopy: true });
        withRecovery(engine);
        const tex = createDynamicTexture(engine, 16, 16);
        // Retain a source, then simulate the caller closing it: the next re-blit throws.
        const source = fakeSource(16, 16);
        (tex as unknown as { _recoverySource: { source: unknown } })._recoverySource.source = source;

        // The rebuild must not propagate the InvalidStateError (which would abort the
        // whole device recovery); it resolves with a valid, blank texture instead.
        await expect(rebuildDynamicTexture2D(engine, tex)).resolves.toBeUndefined();
        expect(tex.width).toBe(16);
        expect(tex.height).toBe(16);
        // The dead source reference is dropped so a later loss neither retries nor pins it.
        expect((tex as unknown as { _recoverySource: { source: unknown } })._recoverySource.source).toBeNull();
    });

    it("restores the creation-time ownership ref so the rebuilt texture outlives its materials", async () => {
        const cap = newCap();
        const engine = makeEngine(cap);
        withRecovery(engine);
        const tex = createDynamicTexture(engine, 16, 16); // creation acquire → ref 1 on GPUTexture A

        await rebuildDynamicTexture2D(engine, tex); // swaps to GPUTexture B and must re-acquire → ref 1

        // Simulate a material acquiring then releasing the rebuilt texture. The restored
        // creation ref must keep it alive (release returns false), not destroy it at 0.
        acquireTexture(tex); // material binds → ref 2
        expect(releaseTexture(tex)).toBe(false); // material unbinds → ref 1, survives
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
