import type { EngineContext } from "../engine/engine.js";
import { BU } from "../engine/gpu-flags.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";

/** @internal Constant zero defaults consume no per-vertex or per-slab-slot allocation. */
export function _enableVertexDefaults(engine: EngineContext): void {
    if (engine._getVertexDefaultBuffer) {
        return;
    }
    let buffer: GPUBuffer | null = null;
    let device: GPUDevice | undefined;
    engine._getVertexDefaultBuffer = (gpu) => {
        if (gpu._vertexCount === undefined) {
            return null;
        }
        if (buffer && device === engine._device) {
            return buffer;
        }
        const next = engine._device.createBuffer({ label: "mesh-zero-vertex", size: 16, usage: BU.VERTEX | BU.COPY_DST });
        if (buffer) {
            buffer.destroy();
        } else {
            registerManagedResourceDisposer(engine, () => {
                buffer?.destroy();
                buffer = null;
            });
        }
        buffer = next;
        device = engine._device;
        return next;
    };
}
