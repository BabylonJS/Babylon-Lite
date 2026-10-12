import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import { align } from "./buffer-alignment.js";

/** Create an empty UNIFORM + COPY_DST buffer. `byteLength` is aligned to 16 bytes. */
export function createEmptyUniformBuffer(engine: EngineContext, byteLength: number, label?: string): GPUBuffer {
    return engine._device.createBuffer({
        label,
        size: align(byteLength, 16),
        usage: BU.UNIFORM | BU.COPY_DST,
    });
}
