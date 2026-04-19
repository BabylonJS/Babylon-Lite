import type { EngineContextInternal } from "../engine/engine.js";

/** Round `n` up to the nearest multiple of `to` (must be a positive integer). */
export function align(n: number, to: number): number {
    return (n + to - 1) & ~(to - 1);
}

/** Create a UNIFORM + COPY_DST buffer and write initial data. Size is aligned to 16 bytes. */
export function createUniformBuffer(engine: EngineContextInternal, data: ArrayBufferView, label?: string): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({
        label,
        size: align(data.byteLength, 16),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    return buf;
}

/** Create an empty UNIFORM + COPY_DST buffer. `byteLength` is aligned to 16 bytes. */
export function createEmptyUniformBuffer(engine: EngineContextInternal, byteLength: number, label?: string): GPUBuffer {
    return engine.device.createBuffer({
        label,
        size: align(byteLength, 16),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
}

/** Create a mapped-at-creation buffer (for VERTEX/INDEX/STORAGE uploads). Size is padded to ≥4 and 4-byte aligned. */
export function createMappedBuffer(engine: EngineContextInternal, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const size = align(Math.max(data.byteLength, 4), 4);
    const buf = engine.device.createBuffer({
        size,
        usage: usage | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
}
