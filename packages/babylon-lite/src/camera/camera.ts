import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4MultiplyInto, mat4PerspectiveLHToRef } from "../math/mat4.js";

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
    /** @internal Cached view matrix + version. */
    _viewCache?: Float32Array;
    _viewVer?: number;
    /** @internal Cached projection matrix + version + aspect. */
    _projCache?: Float32Array;
    _projVer?: number;
    _projAspect?: number;
    /** @internal Cached view-projection matrix + version + aspect. */
    _vpCache?: Float32Array;
    _vpVer?: number;
    _vpAspect?: number;
}

/** Babylon-compatible normalized camera viewport. x/y/width/height are fractions of the render target. */
export interface NormalizedViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Compute the view matrix for a camera. Cached per worldMatrixVersion. */
export function getViewMatrix(camera: Camera): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._viewVer === ver && camera._viewCache) {
        return camera._viewCache as unknown as Mat4;
    }
    if (!camera._viewCache) {
        camera._viewCache = new Float32Array(16);
    }
    const v = camera._viewCache;
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
    if (!camera._projCache) {
        camera._projCache = new Float32Array(16);
    }
    mat4PerspectiveLHToRef(camera._projCache, camera.fov, aspectRatio, camera.nearPlane, camera.farPlane);
    camera._projVer = ver;
    camera._projAspect = aspectRatio;
    return camera._projCache as unknown as Mat4;
}

/** Compute the view-projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const ver = camera.worldMatrixVersion;
    if (camera._vpVer === ver && camera._vpAspect === aspectRatio && camera._vpCache) {
        return camera._vpCache as unknown as Mat4;
    }
    if (!camera._vpCache) {
        camera._vpCache = new Float32Array(16);
    }
    mat4MultiplyInto(camera._vpCache, 0, getProjectionMatrix(camera, aspectRatio), 0, getViewMatrix(camera), 0);
    camera._vpVer = ver;
    camera._vpAspect = aspectRatio;
    return camera._vpCache as unknown as Mat4;
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
