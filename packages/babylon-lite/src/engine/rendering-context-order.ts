import type { RenderingContext } from "./engine.js";
import type { SurfaceContext } from "./surface.js";

/**
 * Move a registered rendering context to `index` in `surface`'s render order.
 *
 * `index` is the context's final position and is clamped to the registry bounds.
 * Returns false (and changes nothing) when `context` is not registered on `surface`.
 * Contexts render in list order, so an overlay such as a utility layer should sit
 * immediately after the scene it composites onto.
 * @throws RangeError when `index` is not an integer.
 */
export function moveRenderingContext(surface: SurfaceContext, context: RenderingContext, index: number): boolean {
    if (!Number.isInteger(index)) {
        throw new RangeError("Rendering context index must be an integer.");
    }
    const list = surface._renderingContexts;
    const i = list.indexOf(context);
    if (i === -1) {
        return false;
    }
    list.splice(i, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, context);
    return true;
}
