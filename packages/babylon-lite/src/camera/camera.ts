import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import { mat4PerspectiveLHToRef } from "../math/mat4-perspective-lh-to-ref.js";
import { asMat4Storage, type Mat4Storage } from "../math/_mat4-storage.js";

/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Pure state, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    /** @internal Cached view matrix + version. Allocated through the bound
     *  precision policy on first read (F32 fallback for unbound cameras). */
    _viewCache?: Mat4Storage;
    _viewVer?: number;
    /** @internal Cached projection matrix + version + aspect. */
    _projCache?: Mat4Storage;
    _projVer?: number;
    _projAspect?: number;
    /** @internal Cached view-projection matrix + version + aspect. */
    _vpCache?: Mat4Storage;
    _vpVer?: number;
    _vpAspect?: number;
    /** @internal Bound scene precision policy (set by addToScene on first attach). */
    _boundPolicy?: import("../scene/_scene-precision.js").ScenePrecisionPolicy | null;
    /** @internal Reallocate matrix-owning caches via the bound allocator. Invoked on first bind. */
    _rebindAllocator?: (allocator: import("../math/_matrix-allocator.js").MatrixAllocator) => void;
}

/** Babylon-compatible normalized camera viewport. x/y/width/height are fractions of the render target. */
export interface NormalizedViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Allocate a Mat4 cache via the camera's bound precision policy.
 *  Falls back to Float32Array if the camera has not been attached to a scene yet. */
function allocateCameraCache(camera: Camera): Mat4Storage {
    const alloc = camera._boundPolicy?.allocator;
    return alloc ? asMat4Storage(alloc.allocate()) : new Float32Array(16);
}

/** Compute the view matrix for a camera. Cached per worldMatrixVersion. */
export function getViewMatrix(camera: Camera): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._viewVer === ver && camera._viewCache) {
        return camera._viewCache as unknown as Mat4;
    }
    const v = camera._viewCache ?? (camera._viewCache = allocateCameraCache(camera));
    const w = camera.worldMatrix;
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
    v[12] = -(w[0]! * w[12]! + w[1]! * w[13]! + w[2]! * w[14]!);
    v[13] = -(w[4]! * w[12]! + w[5]! * w[13]! + w[6]! * w[14]!);
    v[14] = -(w[8]! * w[12]! + w[9]! * w[13]! + w[10]! * w[14]!);
    v[15] = 1;
    camera._viewVer = ver;
    return v as unknown as Mat4;
}

/** Compute the projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._projVer === ver && camera._projAspect === aspectRatio && camera._projCache) {
        return camera._projCache as unknown as Mat4;
    }
    const p = camera._projCache ?? (camera._projCache = allocateCameraCache(camera));
    mat4PerspectiveLHToRef(p, camera.fov, aspectRatio, camera.nearPlane, camera.farPlane);
    camera._projVer = ver;
    camera._projAspect = aspectRatio;
    return p as unknown as Mat4;
}

/** Compute the view-projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._vpVer === ver && camera._vpAspect === aspectRatio && camera._vpCache) {
        return camera._vpCache as unknown as Mat4;
    }
    const vp = camera._vpCache ?? (camera._vpCache = allocateCameraCache(camera));
    mat4MultiplyInto(vp, 0, asMat4Storage(getProjectionMatrix(camera, aspectRatio)), 0, asMat4Storage(getViewMatrix(camera)), 0);
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
