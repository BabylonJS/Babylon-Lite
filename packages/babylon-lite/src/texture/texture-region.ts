import type { EngineContext } from "../engine/engine.js";
import type { Texture2D } from "./texture-2d.js";

/**
 * Destination box and source layout of {@link updateTextureRegion}. Plain mutable state: keep one per call
 * site and update its fields, so a per-frame upload allocates nothing.
 */
export interface TextureRegion {
    /** Destination origin in texels. Default 0. */
    x?: number;
    y?: number;
    /** First destination array layer. Default 0. */
    layer?: number;
    mipLevel?: number;
    width: number;
    height: number;
    /** Number of consecutive array layers written. Default 1. */
    layerCount?: number;
    /** Source bytes between two rows (any multiple of the texel size; no 256-byte alignment is needed for queue writes). */
    bytesPerRow: number;
    /** Source rows between two layers. Default `height`. */
    rowsPerImage?: number;
    /** Source byte offset inside `data`. Default 0. */
    dataOffset?: number;
}

interface CopyDestination {
    texture: GPUTexture;
    mipLevel: number;
    origin: { x: number; y: number; z: number };
}

// Reused descriptors: `writeTexture` copies its arguments synchronously, so sharing them across calls is safe.
let _destination: CopyDestination | null = null;
let _layout: { offset: number; bytesPerRow: number; rowsPerImage: number } | null = null;
let _size: { width: number; height: number; depthOrArrayLayers: number } | null = null;

function checkInteger(name: string, value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`updateTextureRegion: ${name} must be an integer in [${min}, ${max}], received ${value}.`);
    }
}

/**
 * Upload CPU bytes into a box of any texture Lite created with copy-destination usage, in the texture's own
 * format (rgba16float tiles, r32uint tables, ...), into any mip level and array layers. The data is read
 * through `data.buffer` at `data.byteOffset + dataOffset`, so no view is created; the region object is the
 * caller's and is reused. Ordered on the queue before the next submitted frame.
 */
export function updateTextureRegion(engine: EngineContext, texture: Texture2D, data: ArrayBufferView, region: TextureRegion): void {
    const gpu = texture.texture;
    const x = region.x ?? 0;
    const y = region.y ?? 0;
    const layer = region.layer ?? 0;
    const mipLevel = region.mipLevel ?? 0;
    const layerCount = region.layerCount ?? 1;
    const rowsPerImage = region.rowsPerImage ?? region.height;
    const dataOffset = region.dataOffset ?? 0;
    checkInteger("mipLevel", mipLevel, 0, gpu.mipLevelCount - 1);
    const mipWidth = Math.max(1, gpu.width >> mipLevel);
    const mipHeight = Math.max(1, gpu.height >> mipLevel);
    checkInteger("width", region.width, 1, mipWidth);
    checkInteger("height", region.height, 1, mipHeight);
    checkInteger("x", x, 0, mipWidth - region.width);
    checkInteger("y", y, 0, mipHeight - region.height);
    checkInteger("layerCount", layerCount, 1, gpu.depthOrArrayLayers);
    checkInteger("layer", layer, 0, gpu.depthOrArrayLayers - layerCount);
    checkInteger("rowsPerImage", rowsPerImage, region.height, Number.MAX_SAFE_INTEGER);
    checkInteger("bytesPerRow", region.bytesPerRow, 1, Number.MAX_SAFE_INTEGER);
    checkInteger("dataOffset", dataOffset, 0, data.byteLength);
    // The last row only needs its texels, but every earlier row and layer spans the full stride.
    const stridedBytes = region.bytesPerRow * (rowsPerImage * (layerCount - 1) + region.height - 1);
    if (dataOffset + stridedBytes >= data.byteLength) {
        throw new Error(
            `updateTextureRegion: ${data.byteLength} source bytes cannot hold ${region.width}×${region.height}×${layerCount} texels at ${region.bytesPerRow} bytes per row.`
        );
    }

    const destination = (_destination ??= { texture: gpu, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } });
    destination.texture = gpu;
    destination.mipLevel = mipLevel;
    destination.origin.x = x;
    destination.origin.y = y;
    destination.origin.z = layer;
    const layout = (_layout ??= { offset: 0, bytesPerRow: 0, rowsPerImage: 0 });
    layout.offset = data.byteOffset + dataOffset;
    layout.bytesPerRow = region.bytesPerRow;
    layout.rowsPerImage = rowsPerImage;
    const size = (_size ??= { width: 0, height: 0, depthOrArrayLayers: 1 });
    size.width = region.width;
    size.height = region.height;
    size.depthOrArrayLayers = layerCount;
    engine._device.queue.writeTexture(destination, data.buffer as ArrayBuffer, layout, size);
}
