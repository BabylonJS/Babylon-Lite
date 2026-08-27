import type { Bounds2D, Vec2 } from "../math/types.js";
import type { Sprite2DView } from "./sprite-2d.js";

/**
 * Project a world-space point through `view` into the layer's logical backing-store screen space.
 * A non-full render-pass viewport is applied after this transform; see {@link sprite2DScreenToWorldToRef}.
 */
export function sprite2DWorldToScreenToRef<T extends Vec2>(view: Sprite2DView, worldX: number, worldY: number, result: T): T {
    const dx = worldX - view.positionPx[0];
    const dy = worldY - view.positionPx[1];
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    result.x = (dx * cos - dy * sin) * view.zoom;
    result.y = (dx * sin + dy * cos) * view.zoom;
    return result;
}

/**
 * Unproject a point from the layer's logical backing-store screen space into world space.
 * For a depth-hosted layer under a non-full camera viewport, remap absolute framebuffer
 * coordinates from the resolved camera viewport into the full render-target dimensions first.
 */
export function sprite2DScreenToWorldToRef<T extends Vec2>(view: Sprite2DView, screenX: number, screenY: number, result: T): T {
    const inverseZoom = inverseViewZoom(view);
    const x = screenX * inverseZoom;
    const y = screenY * inverseZoom;
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    result.x = view.positionPx[0] + x * cos + y * sin;
    result.y = view.positionPx[1] - x * sin + y * cos;
    return result;
}

/** Write the rotation-safe world-space AABB visible through `view` for its logical screen size. */
export function getSprite2DVisibleBoundsToRef<T extends Bounds2D>(view: Sprite2DView, screenWidthPx: number, screenHeightPx: number, result: T): T {
    const inverseZoom = inverseViewZoom(view);
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    const rightX = screenWidthPx * inverseZoom * cos;
    const rightY = -screenWidthPx * inverseZoom * sin;
    const bottomX = screenHeightPx * inverseZoom * sin;
    const bottomY = screenHeightPx * inverseZoom * cos;
    const x = view.positionPx[0];
    const y = view.positionPx[1];
    result.minX = Math.min(x, x + rightX, x + bottomX, x + rightX + bottomX);
    result.minY = Math.min(y, y + rightY, y + bottomY, y + rightY + bottomY);
    result.maxX = Math.max(x, x + rightX, x + bottomX, x + rightX + bottomX);
    result.maxY = Math.max(y, y + rightY, y + bottomY, y + rightY + bottomY);
    return result;
}

/** Position `view` so the supplied world point appears at the center of its logical screen space. */
export function centerSprite2DView<T extends Sprite2DView>(view: T, worldX: number, worldY: number, screenWidthPx: number, screenHeightPx: number): T {
    const inverseZoom = inverseViewZoom(view);
    const halfWidth = screenWidthPx * 0.5 * inverseZoom;
    const halfHeight = screenHeightPx * 0.5 * inverseZoom;
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    view.positionPx[0] = worldX - halfWidth * cos - halfHeight * sin;
    view.positionPx[1] = worldY + halfWidth * sin - halfHeight * cos;
    return view;
}

function inverseViewZoom(view: Sprite2DView): number {
    if (view.zoom === 0) {
        throw new RangeError("Sprite2DView.zoom must be non-zero.");
    }
    return 1 / view.zoom;
}
