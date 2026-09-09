import type { Mat4, Vec3 } from "../math/types.js";
import type { PixelViewport } from "./viewport.js";

/** Dimensions and active backing-pixel viewport used by world-to-screen projection. */
export interface ScreenProjectionOptions {
    /** Active viewport in canvas backing pixels, with its origin at the top left. */
    viewport: PixelViewport;
    /** Full canvas backing-store width in device pixels. */
    backingWidth: number;
    /** Full canvas backing-store height in device pixels. */
    backingHeight: number;
    /** World-space position represented by zero in the supplied matrices. Omit for absolute-world matrices. */
    worldOrigin?: Vec3;
    /** Canvas-relative CSS width. Must be supplied together with {@link cssHeight}. */
    cssWidth?: number;
    /** Canvas-relative CSS height. Must be supplied together with {@link cssWidth}. */
    cssHeight?: number;
}

/**
 * Projected world point. `x`/`y` are canvas backing pixels; `cssX`/`cssY` are
 * canvas-relative CSS pixels; `z` is WebGPU NDC depth.
 */
export interface ScreenProjectionResult extends Vec3 {
    cssX: number;
    cssY: number;
    /** Homogeneous clip-space W before perspective divide. */
    clipW: number;
    /** True when the point's left-handed view-space Z is at or behind the camera plane. */
    behindCamera: boolean;
    /** True when the point is outside any WebGPU clip plane or is non-finite. */
    clipped: boolean;
    /** True when the point cannot appear inside the viewport's 2D rectangle, including negative clip W. */
    offscreen: boolean;
}

function validateOptions(options: ScreenProjectionOptions): void {
    const { viewport, backingWidth, backingHeight, worldOrigin, cssWidth, cssHeight } = options;
    if (
        !Number.isFinite(viewport.x) ||
        !Number.isFinite(viewport.y) ||
        !(viewport.width > 0) ||
        !Number.isFinite(viewport.width) ||
        !(viewport.height > 0) ||
        !Number.isFinite(viewport.height) ||
        !(backingWidth > 0) ||
        !Number.isFinite(backingWidth) ||
        !(backingHeight > 0) ||
        !Number.isFinite(backingHeight)
    ) {
        throw new RangeError("ScreenProjectionOptions backing dimensions and viewport extents must be positive and finite; viewport offsets must be finite.");
    }
    if (worldOrigin && (!Number.isFinite(worldOrigin.x) || !Number.isFinite(worldOrigin.y) || !Number.isFinite(worldOrigin.z))) {
        throw new RangeError("ScreenProjectionOptions world origin must be finite.");
    }
    if (
        (cssWidth === undefined) !== (cssHeight === undefined) ||
        (cssWidth !== undefined && (!(cssWidth > 0) || !Number.isFinite(cssWidth))) ||
        (cssHeight !== undefined && (!(cssHeight > 0) || !Number.isFinite(cssHeight)))
    ) {
        throw new RangeError("ScreenProjectionOptions CSS dimensions must both be positive and finite.");
    }
}

/**
 * Project a world-space point into canvas backing pixels and canvas-relative CSS pixels,
 * writing every output field into `result`.
 *
 * `view` is required separately from `viewProjection` so `behindCamera` works for
 * orthographic projections, whose homogeneous W remains 1. Coordinates are not clamped:
 * finite offscreen points keep their extrapolated positions for edge-indicator placement.
 *
 * This function performs no allocations. When the matrices use a rebased coordinate frame,
 * set `options.worldOrigin` to the absolute world position represented by their origin.
 * Derive the matrices and viewport once per frame
 * with `getViewMatrix`, `getViewProjectionMatrix`, `getEffectiveAspectRatio`, and
 * `resolveCameraViewport`, then reuse both `options` and `result` for each projected point.
 */
export function projectWorldToScreenToRef<T extends ScreenProjectionResult>(point: Vec3, view: Mat4, viewProjection: Mat4, options: ScreenProjectionOptions, result: T): T {
    validateOptions(options);

    const v = view;
    const vp = viewProjection;
    const origin = options.worldOrigin;
    const x = point.x - (origin?.x ?? 0);
    const y = point.y - (origin?.y ?? 0);
    const z = point.z - (origin?.z ?? 0);
    const viewZ = x * v[2]! + y * v[6]! + z * v[10]! + v[14]!;
    const clipX = x * vp[0]! + y * vp[4]! + z * vp[8]! + vp[12]!;
    const clipY = x * vp[1]! + y * vp[5]! + z * vp[9]! + vp[13]!;
    const clipZ = x * vp[2]! + y * vp[6]! + z * vp[10]! + vp[14]!;
    const clipW = x * vp[3]! + y * vp[7]! + z * vp[11]! + vp[15]!;
    const behindCamera = viewZ <= 0;

    result.clipW = clipW;
    result.behindCamera = behindCamera;

    if (!Number.isFinite(viewZ) || !Number.isFinite(clipX) || !Number.isFinite(clipY) || !Number.isFinite(clipZ) || !Number.isFinite(clipW) || clipW === 0) {
        result.x = result.y = result.z = result.cssX = result.cssY = Number.NaN;
        result.clipped = true;
        result.offscreen = true;
        return result;
    }

    const invW = 1 / clipW;
    const ndcX = clipX * invW;
    const ndcY = clipY * invW;
    const ndcZ = clipZ * invW;
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(ndcZ)) {
        result.x = result.y = result.z = result.cssX = result.cssY = Number.NaN;
        result.clipped = true;
        result.offscreen = true;
        return result;
    }

    const viewport = options.viewport;
    result.x = viewport.x + (ndcX + 1) * viewport.width * 0.5;
    result.y = viewport.y + (1 - ndcY) * viewport.height * 0.5;
    result.z = ndcZ;
    result.cssX = result.x * ((options.cssWidth ?? options.backingWidth) / options.backingWidth);
    result.cssY = result.y * ((options.cssHeight ?? options.backingHeight) / options.backingHeight);

    const outsideXY = ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1;
    const nonDisplayable = behindCamera || clipW < 0;
    result.offscreen = nonDisplayable || outsideXY;
    result.clipped = result.offscreen || ndcZ < 0 || ndcZ > 1;
    return result;
}

/**
 * Allocating convenience wrapper for {@link projectWorldToScreenToRef}.
 * Use the `ToRef` form when projecting repeatedly.
 */
export function projectWorldToScreen(point: Vec3, view: Mat4, viewProjection: Mat4, options: ScreenProjectionOptions): ScreenProjectionResult {
    return projectWorldToScreenToRef(point, view, viewProjection, options, {
        x: 0,
        y: 0,
        z: 0,
        cssX: 0,
        cssY: 0,
        clipW: 0,
        behindCamera: false,
        clipped: false,
        offscreen: false,
    });
}
