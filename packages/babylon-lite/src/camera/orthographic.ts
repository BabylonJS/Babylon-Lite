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

/** Live orthographic view-volume extents, in world units. Mutable and animatable:
 *  every setter invalidates the camera's projection cache, so assigning a field —
 *  by hand, from a render loop, or through a property animation targeting
 *  `"ortho.halfHeight"` — takes effect on the next frame.
 *
 *  A plane left `null` is derived from `halfHeight`: vertically as `±halfHeight`,
 *  horizontally as `±halfHeight * aspectRatio`, so the volume tracks the render
 *  target's aspect ratio and never squashes the image. Set a plane to a number for
 *  an off-center volume (Babylon's `orthoLeft` / `orthoRight` / `orthoBottom` /
 *  `orthoTop`); set it back to `null` to return to the derived extent. */
export interface OrthographicBounds {
    /** Vertical half-extent of the view volume. Halving it doubles the zoom. */
    halfHeight: number;
    /** Left clip plane, or null to derive `-halfHeight * aspectRatio`. */
    left: number | null;
    /** Right clip plane, or null to derive `halfHeight * aspectRatio`. */
    right: number | null;
    /** Bottom clip plane, or null to derive `-halfHeight`. */
    bottom: number | null;
    /** Top clip plane, or null to derive `halfHeight`. */
    top: number | null;
}

/** Initial extents accepted by `enableOrthographicCamera`. Every field is optional;
 *  omitted planes are derived from `halfHeight` (default 1). */
export interface OrthographicBoundsOptions {
    halfHeight?: number;
    left?: number | null;
    right?: number | null;
    bottom?: number | null;
    top?: number | null;
}

const PLANE_KEYS = ["left", "right", "bottom", "top"] as const;

/** Invalidate everything downstream of the projection.
 *
 *  Clearing `_projVer` / `_vpVer` alone is *not* enough. Per-frame consumers gate their
 *  GPU uploads on a camera change key, and the forward pass's scene UBO
 *  (`_writePassSceneUBO`) returns early when camera identity, that key, aspect, fog,
 *  image processing and environment are all unchanged — ShaderMaterial, text, clustered
 *  lighting, TAA and CSM have equivalent gates. The camera transform does not move when
 *  only the view volume changes, so a steady-state scene would keep rendering the
 *  previously uploaded view-projection even though the matrix getters returned a fresh
 *  matrix.
 *
 *  Bumping `_projRev` is what makes the change reach the GPU: `_cameraChangeKey` folds it
 *  into the version those consumers key on. It is deliberately a *separate* counter from
 *  `worldMatrixVersion` — marking the camera transform dirty would additionally invalidate
 *  the camera's children and, under floating origin, retrigger origin rebasing across
 *  every renderable (`wrapRenderableForFO`), none of which a view-volume change warrants.
 *
 *  `_projVer` / `_vpVer` are cleared too because the matrix caches in `camera.ts` key on
 *  `worldMatrixVersion`, which by design does not move here. */
function invalidateProjection(camera: Camera): void {
    camera._projRev = (camera._projRev ?? 0) + 1;
    camera._projVer = undefined;
    camera._vpVer = undefined;
}

/** Build the live bounds object. Each field is an accessor that invalidates the camera's
 *  projection state on change. Nothing in the shared `getProjectionMatrix` cache check has to
 *  know about orthographic state, so perspective-only scenes are unaffected. Properties are
 *  defined (not merely optional) so animation property paths like `"ortho.halfHeight"`
 *  resolve. `halfHeight` is deliberately a separate `number`-only accessor: the derived
 *  extents multiply through it, so accepting `null` there would silently produce a degenerate
 *  (NaN) projection, whereas `null` is meaningful on the four planes. */
function createOrthographicBounds(camera: Camera, options: OrthographicBoundsOptions): OrthographicBounds {
    let halfHeight = options.halfHeight ?? 1;
    const planes: Record<string, number | null> = {
        left: options.left ?? null,
        right: options.right ?? null,
        bottom: options.bottom ?? null,
        top: options.top ?? null,
    };
    const bounds = {} as OrthographicBounds;
    Object.defineProperty(bounds, "halfHeight", {
        get(): number {
            return halfHeight;
        },
        set(v: number) {
            if (halfHeight !== v) {
                halfHeight = v;
                invalidateProjection(camera);
            }
        },
        enumerable: true,
        configurable: true,
    });
    for (const key of PLANE_KEYS) {
        Object.defineProperty(bounds, key, {
            get(): number | null {
                return planes[key]!;
            },
            set(v: number | null) {
                if (planes[key] !== v) {
                    planes[key] = v;
                    invalidateProjection(camera);
                }
            },
            enumerable: true,
            configurable: true,
        });
    }
    return bounds;
}

function writeOrthoProjection(camera: Camera, aspectRatio: number, out: Mat4Storage): void {
    const b = camera.ortho!;
    const halfHeight = b.halfHeight;
    const halfWidth = halfHeight * aspectRatio;
    mat4OrthoOffCenterLHToRef(out, b.left ?? -halfWidth, b.right ?? halfWidth, b.bottom ?? -halfHeight, b.top ?? halfHeight, camera.nearPlane, camera.farPlane);
}

/** Switch a camera to an orthographic projection, and return its live `ortho` bounds.
 *
 *  Depth still comes from `camera.nearPlane` / `camera.farPlane`; `camera.fov` has no
 *  effect in this mode — an orthographic camera zooms by changing `halfHeight`.
 *
 *  The returned object is also reachable as `camera.ortho`, and stays mutable (see
 *  `OrthographicBounds`), so this only needs to be called once per camera. Calling it
 *  again replaces the bounds with a fresh object. */
export function enableOrthographicCamera(camera: Camera, bounds?: OrthographicBoundsOptions): OrthographicBounds {
    _installOrthographicProjector(writeOrthoProjection);
    const ortho = createOrthographicBounds(camera, bounds ?? {});
    camera.ortho = ortho;
    invalidateProjection(camera);
    return ortho;
}

/** Switch a camera back to its perspective projection (driven by `camera.fov`). */
export function disableOrthographicCamera(camera: Camera): void {
    camera.ortho = null;
    // `mat4PerspectiveLHToRef` only writes the terms a perspective matrix needs, relying on the
    // rest of a freshly allocated (zeroed) cache. Clear the extra terms the orthographic writer
    // introduced so the perspective matrix is not rebuilt on top of an off-center, w=1 volume.
    // Owned here rather than in the shared writer so perspective-only scenes pay nothing.
    const p = camera._projCache;
    p[12] = 0;
    p[13] = 0;
    p[15] = 0;
    invalidateProjection(camera);
}
