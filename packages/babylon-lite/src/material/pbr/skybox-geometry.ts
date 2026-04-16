/** Shared skybox cube geometry + world matrix helpers.
 *  Used by solid-color skybox, DDS skybox, and HDR skybox variants. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { Mat4 } from "../../math/types.js";

/** Skybox box geometry (24 verts, 36 indices — matches Babylon). */
export function createSkyboxBuffers(engine: EngineContextInternal, S = 15): { posBuffer: GPUBuffer; idxBuffer: GPUBuffer; idxCount: number } {
    // prettier-ignore
    const positions = new Float32Array([
     S,-S, S, -S,-S, S, -S, S, S,  S, S, S,
     S, S,-S, -S, S,-S, -S,-S,-S,  S,-S,-S,
     S, S,-S,  S,-S,-S,  S,-S, S,  S, S, S,
    -S, S, S, -S,-S, S, -S,-S,-S, -S, S,-S,
    -S, S, S, -S, S,-S,  S, S,-S,  S, S, S,
     S,-S, S,  S,-S,-S, -S,-S,-S, -S,-S, S,
  ]);
    // prettier-ignore
    const indices = new Uint16Array([
     2, 1, 0,  3, 2, 0,   6, 5, 4,  7, 6, 4,
    10, 9, 8, 11,10, 8,  14,13,12, 15,14,12,
    18,17,16, 19,18,16,  22,21,20, 23,22,20,
  ]);

    return {
        posBuffer: createBuf(engine, positions, GPUBufferUsage.VERTEX),
        idxBuffer: createBuf(engine, indices, GPUBufferUsage.INDEX),
        idxCount: 36,
    };
}

export function createBuf(engine: EngineContextInternal, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({
        size: Math.max(data.byteLength, 4),
        usage: usage | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
}

/** Build an identity world matrix translated to rootPosition (no scaling). */
export function buildSkyboxWorldMatrix(rootPosition: [number, number, number]): Mat4 {
    const world = new Float32Array(16) as Mat4;
    world[0] = 1;
    world[5] = 1;
    world[10] = 1;
    world[15] = 1;
    world[12] = rootPosition[0];
    world[13] = rootPosition[1];
    world[14] = rootPosition[2];
    return world;
}
