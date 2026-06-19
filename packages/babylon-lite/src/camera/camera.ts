import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { mat4PerspectiveLHToRef } from "../math/mat4-perspective-lh-to-ref.js";
import type { Mat4Storage } from "../math/types.js";

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

/** Compute the projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._projVer === ver && camera._projAspect === aspectRatio) {
        return camera._projCache as unknown as Mat4;
    }
    const p = camera._projCache;
    mat4PerspectiveLHToRef(p, camera.fov, aspectRatio, camera.nearPlane, camera.farPlane);
    camera._projVer = ver;
    camera._projAspect = aspectRatio;
    return p as unknown as Mat4;
}

/** Compute the view-projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = camera.worldMatrixVersion;
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
