import type { EngineContext } from "../engine/engine.js";
import { createEmptyUniformBuffer } from "./empty-uniform-buffer.js";

/** Create a UNIFORM + COPY_DST buffer and write initial data. Size is aligned to 16 bytes. */
export function createUniformBuffer(engine: EngineContext, data: ArrayBufferView, label?: string): GPUBuffer {
    const device = engine._device;
    const buffer = createEmptyUniformBuffer(engine, data.byteLength, label);
    try {
        device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    } catch (error) {
        buffer.destroy();
        throw error;
    }
    return buffer;
}
