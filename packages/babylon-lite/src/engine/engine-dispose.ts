import { stopEngine, type EngineContext } from "./engine.js";
import { disposeGpuResourceRetirements } from "./gpu-resource-retirement.js";

/** Release all engine-owned GPU resources (device + every attached surface's swapchain
 *  context). Rendering contexts own their own GPU resources (frame graphs, render
 *  targets) and dispose them separately. */
export function disposeEngine(engine: EngineContext): void {
    // Claim retirement batches before stopEngine fences them: the device is destroyed below.
    disposeGpuResourceRetirements(engine);
    stopEngine(engine);
    const surfaces = engine._surfaces;
    for (const surface of surfaces) {
        surface._renderingContexts.length = 0;
        surface._ro?.disconnect();
        surface._context.unconfigure();
    }
    surfaces.length = 0;
    try {
        engine._disposeManagedResources?.();
        engine._disposeStorageBuffers?.();
    } finally {
        engine._device.destroy();
    }
}
