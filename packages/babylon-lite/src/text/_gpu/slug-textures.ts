/** Owns the curve + band rgba32float GPU textures shared across a SharedAtlas's lifetime.
 *  Lazy-init: created on first bind, recreated only when capacity grows. */

import { TEX_WIDTH } from "../internal.js";
import type { SharedAtlas, SharedAtlasGpu } from "../internal.js";

const ROW_FLOATS = TEX_WIDTH * 4;
const BYTES_PER_ROW = ROW_FLOATS * 4;

function nextPow2Rows(rows: number): number {
    let r = 1;
    while (r < rows) {
        r <<= 1;
    }
    return r;
}

function rowsForTexels(texels: number): number {
    if (texels <= 0) {
        return 1;
    }
    return Math.ceil(texels / TEX_WIDTH);
}

function createAtlasTexture(device: GPUDevice, rows: number, label: string): GPUTexture {
    return device.createTexture({
        label,
        format: "rgba32float",
        size: { width: TEX_WIDTH, height: rows, depthOrArrayLayers: 1 },
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
}

/** Upload all used texels (rows up to rowsUsed) of `cpuData` to `tex`. */
function uploadAll(device: GPUDevice, tex: GPUTexture, cpuData: Float32Array, texelsUsed: number): void {
    if (texelsUsed === 0) {
        return;
    }
    const rows = rowsForTexels(texelsUsed);
    const bytes = rows * BYTES_PER_ROW;
    device.queue.writeTexture(
        { texture: tex },
        cpuData.buffer as ArrayBuffer,
        { offset: cpuData.byteOffset, bytesPerRow: BYTES_PER_ROW, rowsPerImage: rows },
        { width: TEX_WIDTH, height: rows, depthOrArrayLayers: 1 }
    );
    void bytes;
}

/** Ensure `atlas._gpu` matches the current device and has enough rows for all used texels.
 *  Returns true when textures were (re)created — caller must rebuild any bind groups. */
export function ensureSharedAtlasGpu(device: GPUDevice, atlas: SharedAtlas): { rebuilt: boolean; gpu: SharedAtlasGpu } {
    let gpu = atlas._gpu;
    const curveRowsNeeded = rowsForTexels(atlas.curveTexelsUsed);
    const bandRowsNeeded = rowsForTexels(atlas.bandTexelsUsed);

    if (gpu && gpu.device !== device) {
        gpu.curveTex.destroy();
        gpu.bandTex.destroy();
        gpu = null;
    }

    let rebuilt = false;
    if (!gpu) {
        const curveRows = nextPow2Rows(Math.max(1, curveRowsNeeded));
        const bandRows = nextPow2Rows(Math.max(1, bandRowsNeeded));
        gpu = {
            device,
            curveTex: createAtlasTexture(device, curveRows, "text-slug-curves"),
            bandTex: createAtlasTexture(device, bandRows, "text-slug-bands"),
            curveTexRows: curveRows,
            bandTexRows: bandRows,
            uploadedVersion: -1,
        };
        atlas._gpu = gpu;
        rebuilt = true;
    } else {
        if (curveRowsNeeded > gpu.curveTexRows) {
            gpu.curveTex.destroy();
            gpu.curveTexRows = nextPow2Rows(curveRowsNeeded);
            gpu.curveTex = createAtlasTexture(device, gpu.curveTexRows, "text-slug-curves");
            gpu.uploadedVersion = -1;
            rebuilt = true;
        }
        if (bandRowsNeeded > gpu.bandTexRows) {
            gpu.bandTex.destroy();
            gpu.bandTexRows = nextPow2Rows(bandRowsNeeded);
            gpu.bandTex = createAtlasTexture(device, gpu.bandTexRows, "text-slug-bands");
            gpu.uploadedVersion = -1;
            rebuilt = true;
        }
    }

    if (gpu.uploadedVersion !== atlas.version) {
        uploadAll(device, gpu.curveTex, atlas.curveTexData, atlas.curveTexelsUsed);
        uploadAll(device, gpu.bandTex, atlas.bandTexData, atlas.bandTexelsUsed);
        gpu.uploadedVersion = atlas.version;
    }

    return { rebuilt, gpu };
}
