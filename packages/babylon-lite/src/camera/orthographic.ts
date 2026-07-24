/**
 * Opt-in entry point for orthographic camera projection.
 *
 * The explicit enable keeps every perspective-only scene byte-identical: without
 * this module `_installOrthographicProjector` tree-shakes, the bundler proves the
 * projector seam in `camera.ts` is always null, and the orthographic branch in
 * `getProjectionMatrix` folds away entirely.
 *
 * Works with any camera that satisfies the `Camera` contract (ArcRotate, Free,
 * Geospatial, …) — the projection is orthogonal to how the camera is positioned.
 */
import type { Camera } from "./camera.js";
import { _installOrthographicProjector } from "./camera.js";
import { mat4OrthoOffCenterLHToRef } from "../math/mat4-ortho-lh-to-ref.js";
import type { Mat4Storage } from "../math/types.js";

/** Orthographic view-volume extents, in world units.
 *
 *  Any plane left undefined is derived from `halfHeight`: vertically as
 *  `±halfHeight`, horizontally as `±halfHeight * aspectRatio` — so the default
 *  volume tracks the render target's aspect ratio and never squashes the image.
 *  Supply explicit planes (Babylon's `orthoLeft` / `orthoRight` / `orthoBottom` /
 *  `orthoTop`) for an off-center volume. */
export interface OrthographicBounds {
    /** Vertical half-extent of the view volume. Default 1. */
    halfHeight?: number;
    /** Left clip plane. Default `-halfHeight * aspectRatio`. */
    left?: number;
    /** Right clip plane. Default `halfHeight * aspectRatio`. */
    right?: number;
    /** Bottom clip plane. Default `-halfHeight`. */
    bottom?: number;
    /** Top clip plane. Default `halfHeight`. */
    top?: number;
}

function writeOrthoProjection(camera: Camera, aspectRatio: number, out: Mat4Storage): void {
    const b = camera._ortho!;
    const halfHeight = b.halfHeight ?? 1;
    const halfWidth = halfHeight * aspectRatio;
    mat4OrthoOffCenterLHToRef(out, b.left ?? -halfWidth, b.right ?? halfWidth, b.bottom ?? -halfHeight, b.top ?? halfHeight, camera.nearPlane, camera.farPlane);
}

/** Switch a camera to an orthographic projection.
 *
 *  Call before `registerScene`, or at any time afterwards to change the extents —
 *  each call re-arms the camera's projection cache, so this is also how an
 *  orthographic camera zooms (`camera.fov` has no effect in this mode). Depth
 *  still comes from `camera.nearPlane` / `camera.farPlane`.
 *
 *  With only `halfHeight` supplied the camera frames `2 * halfHeight` world units
 *  vertically, widened to the render target's aspect ratio. */
export function enableOrthographicCamera(camera: Camera, bounds?: OrthographicBounds): void {
    _installOrthographicProjector(writeOrthoProjection);
    camera._ortho = bounds ?? {};
    camera._projVer = undefined;
    camera._vpVer = undefined;
}

/** Switch a camera back to its perspective projection (driven by `camera.fov`). */
export function disableOrthographicCamera(camera: Camera): void {
    camera._ortho = null;
    // `mat4PerspectiveLHToRef` only writes the terms a perspective matrix needs, relying on the
    // rest of a freshly allocated (zeroed) cache. Clear the extra terms the orthographic writer
    // introduced so the perspective matrix is not rebuilt on top of an off-center, w=1 volume.
    // Owned here rather than in the shared writer so perspective-only scenes pay nothing.
    const p = camera._projCache;
    p[12] = 0;
    p[13] = 0;
    p[15] = 0;
    camera._projVer = undefined;
    camera._vpVer = undefined;
}
