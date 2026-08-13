import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { mat4PerspectiveLHToRef } from "../math/mat4-perspective-lh-to-ref.js";
import type { Mat4Storage } from "../math/types.js";
import type { OrthographicBounds } from "./orthographic.js";

/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Pure state, no scene knowledge (pillar 4b).
 *
 *  The view/projection matrix caches below are allocated by the camera factory
 *  via the process-global `allocateMat4()` singleton — F32 by default, F64
 *  after any HPM engine is constructed (see
 *  `docs/lite/architecture/36-high-precision-matrix.md`). The storage
 *  type is fixed at construction and never changes. */
export interface Camera {
    /** Optional source/debug name. Imported glTF cameras use the glTF camera name,
     *  or `camera{index}` when the source definition is unnamed. */
    name?: string;
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    /** @internal View matrix cache. Pre-allocated by the camera factory via
     *  `allocateMat4()`. F32 by default, F64 after an HPM engine is created. */
    _viewCache: Mat4Storage;
    /** @internal */
    _viewVer?: number;
    /** @internal Projection matrix cache. Same allocator as `_viewCache`. */
    _projCache: Mat4Storage;
    /** @internal */
    _projVer?: number;
    /** @internal */
    _projAspect?: number;
    /** @internal View-projection matrix cache. Same allocator. */
    _vpCache: Mat4Storage;
    /** @internal */
    _vpVer?: number;
    /** @internal */
    _vpAspect?: number;
    /** @internal Marker: when set by an LWR-enabled scene, `getViewMatrix`
     *  zeros the view matrix translation column (the GPU sees the camera at
     *  the origin in the eye-relative frame, matching the mesh-world UBO
     *  pack that subtracted the camera position). Set by scene `_update` when
     *  the engine has `useFloatingOrigin: true`; never unset. Non-LWR cameras
     *  leave the field undefined and `getViewMatrix` produces a standard view
     *  matrix. */
    _useFloatingOrigin?: boolean;
    /** @internal Monotonic counter bumped whenever the *projection* changes
     *  independently of the camera transform: by `_cameraChangeKey` when it
     *  observes a `fov` / `nearPlane` / `farPlane` write, and by the orthographic
     *  feature module (`enableOrthographicCamera` / `disableOrthographicCamera`
     *  and every `ortho` bounds setter).
     *
     *  Projection-dependent per-frame consumers gate their GPU uploads on the
     *  camera's `worldMatrixVersion`, which does not move when only the view
     *  volume does; they fold this counter into the same key so the change
     *  reaches the GPU. It is deliberately separate from `worldMatrixVersion`:
     *  a projection change must NOT be mistaken for camera motion, which would
     *  additionally invalidate the camera's children and — under floating
     *  origin — retrigger origin rebasing across every renderable.
     *
     *  Initialized on the first `_cameraChangeKey` call: the `fov` / `nearPlane` /
     *  `farPlane` snapshot below starts `undefined`, so that first call always
     *  observes a drift and bumps this to 1. Consumers therefore never read it
     *  as `undefined` — they reach it only through `_cameraChangeKey`. */
    _projRev?: number;
    /** @internal Last `fov` / `nearPlane` / `farPlane` observed by `_cameraChangeKey`.
     *  These are plain writable fields on a plain-data camera (pillar 4b′), so a write
     *  cannot notify anyone; the change key polls them by value instead and bumps
     *  `_projRev` when they drift. See `_cameraChangeKey`. */
    _projFov?: number;
    /** @internal See `_projFov`. */
    _projNear?: number;
    /** @internal See `_projFov`. */
    _projFar?: number;
    /** Live orthographic view-volume extents, installed by `enableOrthographicCamera`
     *  and mutable/animatable thereafter. Null or undefined means the camera projects
     *  perspectively through `fov`. */
    ortho?: OrthographicBounds | null;
}

/** Babylon-compatible normalized camera viewport. x/y/width/height are fractions of the render target. */
export interface NormalizedViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Compute the view matrix for a camera. Cached per worldMatrixVersion.
 *
 *  Floating-origin awareness: when `camera._useFloatingOrigin` is set
 *  (LWR — wired by the scene's `_update` when the active scene camera is
 *  bound to an LWR engine), the view matrix translation column is forced
 *  to zero. The GPU vertex shader then sees the camera at the origin in
 *  the eye-relative frame, matching the mesh-world UBO pack which
 *  subtracted the camera position from world translations. View × world
 *  in the shader produces eye-relative vertex coordinates at full
 *  precision regardless of how far from world-origin the scene is.
 *
 *  When the flag is unset (standard non-LWR rendering), this path is
 *  bit-identical to a normal `R_inv * -cameraPos` view matrix. */
export function getViewMatrix(camera: Camera): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._viewVer === ver) {
        return camera._viewCache as unknown as Mat4;
    }
    const v = camera._viewCache;
    const w = camera.worldMatrix;
    const useFO = camera._useFloatingOrigin;
    const cx = useFO ? 0 : w[12]!;
    const cy = useFO ? 0 : w[13]!;
    const cz = useFO ? 0 : w[14]!;
    v[0] = w[0]!;
    v[1] = w[4]!;
    v[2] = w[8]!;
    v[3] = 0;
    v[4] = w[1]!;
    v[5] = w[5]!;
    v[6] = w[9]!;
    v[7] = 0;
    v[8] = w[2]!;
    v[9] = w[6]!;
    v[10] = w[10]!;
    v[11] = 0;
    v[12] = -(w[0]! * cx + w[1]! * cy + w[2]! * cz);
    v[13] = -(w[4]! * cx + w[5]! * cy + w[6]! * cz);
    v[14] = -(w[8]! * cx + w[9]! * cy + w[10]! * cz);
    v[15] = 1;
    camera._viewVer = ver;
    return v as unknown as Mat4;
}

/** Orthographic projection writer, installed only by `enableOrthographicCamera`. Module-local with a
 *  single exported setter: when `enableOrthographicCamera` is absent from the bundle the setter
 *  tree-shakes, the bundler proves this is always null, and the orthographic branch below folds away —
 *  perspective-only scenes stay byte-identical. */
let _orthoProjector: ((camera: Camera, aspectRatio: number, out: Mat4Storage) => void) | null = null;

/** @internal Install orthographic projection support (called by `enableOrthographicCamera`). */
export function _installOrthographicProjector(write: (camera: Camera, aspectRatio: number, out: Mat4Storage) => void): void {
    _orthoProjector = write;
}

/** @internal Change key for every projection-dependent per-frame consumer, and for the
 *  projection matrix caches themselves.
 *
 *  Consumers gate their GPU uploads on a version number. `camera.worldMatrixVersion` alone
 *  is not that number: it does not move when only the view volume changes, so a steady-state
 *  scene keeps rendering a stale view-projection after a `fov`, `nearPlane`, `farPlane` or
 *  orthographic-bounds write.
 *
 *  `fov` / `nearPlane` / `farPlane` are plain writable fields on a plain-data camera
 *  (pillar 4b′) — a write cannot notify anyone — so this polls them by value and folds a
 *  drift into `_projRev`. Polling here rather than installing accessors in every camera
 *  factory keeps the projection contract in ONE place, costs nothing per camera type, and
 *  works for a hand-rolled object satisfying `Camera` (the same reason
 *  `world-matrix-state.ts` polls a foreign parent's version instead of pushing to it).
 *  Orthographic bounds are pushed, not polled: that module owns setters already.
 *
 *  Both terms of the returned sum are monotonically non-decreasing, so the sum is too and
 *  any change in either strictly increases it — it cannot alias. (Same version-summing idiom
 *  as `shadow-base.ts` and `gltf-feature-lights-punctual.ts`.) This relies on the `Camera`
 *  contract that `worldMatrixVersion` never decreases; every in-engine camera satisfies it
 *  (the counter only ever increments, including across reparenting), and a custom `Camera`
 *  implementation must too or a change can be missed.
 *
 *  Deliberately NOT folded into `worldMatrixVersion` itself: a projection change must not be
 *  mistaken for camera motion, which would invalidate the camera's children and, under
 *  floating origin, retrigger origin rebasing across every renderable (`wrapRenderableForFO`).
 *  Those consumers keep reading `worldMatrixVersion`. */
export function _cameraChangeKey(camera: Camera): number {
    if (camera._projFov !== camera.fov || camera._projNear !== camera.nearPlane || camera._projFar !== camera.farPlane) {
        camera._projFov = camera.fov;
        camera._projNear = camera.nearPlane;
        camera._projFar = camera.farPlane;
        camera._projRev = (camera._projRev ?? 0) + 1;
    }
    return camera.worldMatrixVersion + (camera._projRev ?? 0);
}

/** Compute the projection matrix for a camera. Cached per `_cameraChangeKey` + aspect. */
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = _cameraChangeKey(camera);
    if (camera._projVer === ver && camera._projAspect === aspectRatio) {
        return camera._projCache as unknown as Mat4;
    }
    const p = camera._projCache;
    if (_orthoProjector !== null && camera.ortho) {
        _orthoProjector(camera, aspectRatio, p);
    } else {
        mat4PerspectiveLHToRef(p, camera.fov, aspectRatio, camera.nearPlane, camera.farPlane);
    }
    camera._projVer = ver;
    camera._projAspect = aspectRatio;
    return p as unknown as Mat4;
}

/** Compute the view-projection matrix for a camera. Cached per `_cameraChangeKey` + aspect. */
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = _cameraChangeKey(camera);
    if (camera._vpVer === ver && camera._vpAspect === aspectRatio) {
        return camera._vpCache as unknown as Mat4;
    }
    const vp = camera._vpCache;
    mat4MultiplyInto(vp, 0, getProjectionMatrix(camera, aspectRatio) as unknown as Mat4Storage, 0, getViewMatrix(camera) as unknown as Mat4Storage, 0);
    camera._vpVer = ver;
    camera._vpAspect = aspectRatio;
    return vp as unknown as Mat4;
}

/** Get the world-space position of a camera. */
export function getCameraPosition(camera: Camera): Vec3 {
    const w = camera.worldMatrix;
    return { x: w[12]!, y: w[13]!, z: w[14]! };
}

/** Returns the render-target aspect ratio adjusted for the camera's normalized viewport, or the raw ratio if none. */
export function getEffectiveAspectRatio(camera: Camera | null | undefined, targetWidth: number, targetHeight: number): number {
    const v = camera?.viewport;
    return (targetWidth / targetHeight) * (v ? v.width / v.height : 1);
}
