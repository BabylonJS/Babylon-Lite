import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { mat4PerspectiveLHToRef } from "../math/mat4-perspective-lh-to-ref.js";
import type { Mat4Storage } from "../math/_mat4-storage.js";

/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Pure state, no scene knowledge (pillar 4b).
 *
 *  Note: camera factories (`createArcRotateCamera`, `createFreeCamera`) take
 *  the engine at construction so the matrix caches below are allocated from
 *  the engine's precision policy (F32 by default, F64 with HPM on). The
 *  storage type is fixed at construction and never changes. */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    /** @internal View matrix cache. Pre-allocated by the camera factory from the
     *  engine's `_matrixPolicy` allocator. F32 by default, F64 with HPM on. */
    _viewCache: Mat4Storage;
    _viewVer?: number;
    /** @internal Projection matrix cache. Same allocator as `_viewCache`. */
    _projCache: Mat4Storage;
    _projVer?: number;
    _projAspect?: number;
    /** @internal View-projection matrix cache. Same allocator. */
    _vpCache: Mat4Storage;
    _vpVer?: number;
    _vpAspect?: number;
    /** @internal Floating-origin offset reference, wired by the scene's `_update`
     *  when the camera is the active `scene.camera`. When non-null, `getViewMatrix`
     *  bakes the offset into the view matrix translation so the GPU sees
     *  eye-relative coordinates. Null = no LWR / standard view matrix. */
    _floatingOriginOffset?: readonly [number, number, number] | null;
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
 *  Floating-origin awareness: when `camera._floatingOriginOffset` is set
 *  (LWR M1 — wired by the scene's `_update` when the camera is the active
 *  scene camera and the scene is FO-enabled), the offset is subtracted from
 *  the camera world position BEFORE the translation column is computed via
 *  the (R_inv * -cameraPos) form. The effect is that the view matrix
 *  translation becomes `-R_inv * (cameraPos - offset)`, which is small when
 *  offset == cameraPos (the standard floating-origin bookkeeping). Mesh
 *  world matrices are also offset-subtracted at upload via
 *  packMat4IntoF32WithOffset, so vertex-shader `view * world` math is
 *  preserved end-to-end.
 *
 *  When the offset is null (FO disabled, or camera not currently scene.camera),
 *  this path is bit-identical to a standard view matrix construction. */
export function getViewMatrix(camera: Camera): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._viewVer === ver) {
        return camera._viewCache as unknown as Mat4;
    }
    const v = camera._viewCache;
    const w = camera.worldMatrix;
    const off = camera._floatingOriginOffset;
    const cx = off ? w[12]! - off[0]! : w[12]!;
    const cy = off ? w[13]! - off[1]! : w[13]!;
    const cz = off ? w[14]! - off[2]! : w[14]!;
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

export function getEffectiveAspectRatio(camera: Camera | null | undefined, targetWidth: number, targetHeight: number): number {
    const v = camera?.viewport;
    return (targetWidth / targetHeight) * (v ? v.width / v.height : 1);
}
