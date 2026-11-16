import { BU } from "../engine/gpu-flags.js";

/** @internal Read RGBA8 level zero without flipping rows, dropping alpha, or flushing an active frame. */
export async function readTexturePixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array<ArrayBuffer>> {
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const staging = device.createBuffer({ label: "texture-pixels-readback", size: bytesPerRow * height, usage: BU.MAP_READ | BU.COPY_DST });
    try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow, rowsPerImage: height }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange());
        const pixels = new Uint8Array(width * height * 4);
        for (let row = 0; row < height; row++) {
            pixels.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
        }
        return pixels;
    } finally {
        staging.unmap();
        staging.destroy();
    }
}
