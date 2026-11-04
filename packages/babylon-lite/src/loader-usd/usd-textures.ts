import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { acquireTexture, getOrCreateSampler } from "../resource/gpu-pool.js";
import { uploadTex } from "../loader-gltf/gltf-pbr-builder.js";
import type { UsdRecord } from "./usd-protocol.js";
import { UsdOp, usdBytes, usdField, usdFloats } from "./usd-protocol.js";
import { usdAbortable } from "./usd-abort.js";

/** @internal Decoded protocol-v5 texture plus its authored value transform. */
export interface UsdTextureSource {
    readonly texture: Texture2D;
    readonly scale: Float32Array;
    readonly bias: Float32Array;
    readonly sourceColorSpace: number;
}

/** @internal Decode and upload each referenced protocol texture once. */
export function createUsdTextureLoader(engine: EngineContext, records: readonly UsdRecord[], data: ArrayBuffer, owned: Texture2D[], signal?: AbortSignal) {
    const descriptors = new Map<number, UsdRecord>();
    const cache = new Map<number, Promise<UsdTextureSource>>();
    for (const record of records) {
        if (record.op === UsdOp.Texture) {
            const id = usdField(record, 0);
            if (descriptors.has(id)) {
                throw new Error(`Duplicate USD texture ${id}`);
            }
            descriptors.set(id, record);
        }
    }

    return async (id: number): Promise<UsdTextureSource> => {
        signal?.throwIfAborted();
        const cached = cache.get(id);
        if (cached) {
            return cached;
        }
        const record = descriptors.get(id);
        if (!record) {
            throw new Error(`Missing USD texture ${id}`);
        }
        const loading = loadUsdTexture(engine, record, data, owned, signal);
        cache.set(id, loading);
        try {
            return await loading;
        } catch (error) {
            cache.delete(id);
            throw error;
        }
    };
}

async function loadUsdTexture(engine: EngineContext, record: UsdRecord, data: ArrayBuffer, owned: Texture2D[], signal?: AbortSignal): Promise<UsdTextureSource> {
    const mime = ["", "image/png", "image/jpeg", "image/bmp", "image/webp"][usdField(record, 3)];
    const modes: GPUAddressMode[] = ["clamp-to-edge", "repeat", "mirror-repeat"];
    const addressModeU = modes[usdField(record, 8)];
    const addressModeV = modes[usdField(record, 9)];
    const sourceColorSpace = usdField(record, 10);
    if (!mime || !addressModeU || !addressModeV || usdField(record, 6) !== 0 || sourceColorSpace > 2) {
        throw new Error("Unsupported USD texture encoding, wrap mode, UV set, or color space");
    }
    const transform = usdFloats(data, usdField(record, 7), 5);
    const valueTransform = usdFloats(data, usdField(record, 11), 8);
    if (![...transform, ...valueTransform].every(Number.isFinite)) {
        throw new Error("Invalid USD texture transform");
    }
    const bytes = usdBytes(data, usdField(record, 4), usdField(record, 5));
    const { generateMipmaps } = await import("../texture/generate-mipmaps.js");
    signal?.throwIfAborted();
    const bitmap = await usdAbortable(createImageBitmap(new Blob([bytes], { type: mime }), { premultiplyAlpha: "none", colorSpaceConversion: "none" }), signal, (late) =>
        late.close()
    );
    try {
        signal?.throwIfAborted();
        const sampler = getOrCreateSampler(engine, { addressModeU, addressModeV, minFilter: "linear", magFilter: "linear", mipmapFilter: "linear" });
        const texture = uploadTex(engine, bitmap, sourceColorSpace !== 1, sampler, generateMipmaps);
        acquireTexture(texture);
        owned.push(texture);
        texture.uScale = transform[0];
        texture.vScale = transform[1];
        texture.uAng = transform[4];
        texture.uOffset = transform[2]! - transform[1]! * Math.sin(transform[4]!);
        texture.vOffset = 1 - transform[1]! * Math.cos(transform[4]!) - transform[3]!;
        return {
            texture,
            scale: valueTransform.subarray(0, 4),
            bias: valueTransform.subarray(4, 8),
            sourceColorSpace,
        };
    } finally {
        if (!engine._dlr) {
            bitmap.close();
        }
    }
}
