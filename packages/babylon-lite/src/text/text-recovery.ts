import type { EngineContext } from "../engine/engine.js";
import type { TextRenderer } from "./text-renderer.js";
import { _rebuildTextRendererGpu } from "./text-renderer.js";

/**
 * Rebuild every registered TextRenderer on the replacement device.
 * This module is reached only through the Text recovery adapter's lazy import.
 */
export function rebuildRegisteredTextRenderers(engine: EngineContext): void {
    for (const surface of engine.surfaces) {
        for (const context of surface._renderingContexts) {
            if (context._kind !== "text-renderer") {
                continue;
            }
            _rebuildTextRendererGpu(context as TextRenderer);
        }
    }
}
