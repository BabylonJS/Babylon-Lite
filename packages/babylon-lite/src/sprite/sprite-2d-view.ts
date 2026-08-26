import type { Vec2 } from "../math/types.js";
import type { Sprite2DView } from "./sprite-2d.js";

/** Axis-aligned world-space bounds visible through a {@link Sprite2DView}. */
export interface Sprite2DVisibleBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Project a world-space point through `view` into backing-store screen pixels. */
export function sprite2DWorldToScreenToRef<T extends Vec2>(view: Sprite2DView, worldX: number, worldY: number, result: T): T {
    const dx = worldX - view.positionPx[0];
    const dy = worldY - view.positionPx[1];
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    result.x = (dx * cos - dy * sin) * view.zoom;
    result.y = (dx * sin + dy * cos) * view.zoom;
    return result;
}

/** Unproject a backing-store screen-pixel point through `view` into world space. */
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

/** Write the rotation-safe world-space AABB visible through `view` for a backing-store viewport size. */
export function getSprite2DVisibleBoundsToRef<T extends Sprite2DVisibleBounds>(view: Sprite2DView, viewportWidthPx: number, viewportHeightPx: number, result: T): T {
    const inverseZoom = inverseViewZoom(view);
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    const rightX = viewportWidthPx * inverseZoom * cos;
    const rightY = -viewportWidthPx * inverseZoom * sin;
    const bottomX = viewportHeightPx * inverseZoom * sin;
    const bottomY = viewportHeightPx * inverseZoom * cos;
    const x = view.positionPx[0];
    const y = view.positionPx[1];
    result.minX = Math.min(x, x + rightX, x + bottomX, x + rightX + bottomX);
    result.minY = Math.min(y, y + rightY, y + bottomY, y + rightY + bottomY);
    result.maxX = Math.max(x, x + rightX, x + bottomX, x + rightX + bottomX);
    result.maxY = Math.max(y, y + rightY, y + bottomY, y + rightY + bottomY);
    return result;
}

/** Position `view` so the supplied world point appears at the backing-store viewport center. */
export function centerSprite2DView<T extends Sprite2DView>(view: T, worldX: number, worldY: number, viewportWidthPx: number, viewportHeightPx: number): T {
    const inverseZoom = inverseViewZoom(view);
    const halfWidth = viewportWidthPx * 0.5 * inverseZoom;
    const halfHeight = viewportHeightPx * 0.5 * inverseZoom;
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
