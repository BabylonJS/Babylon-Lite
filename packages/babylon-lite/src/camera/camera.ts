import type { Vec3, Mat4 } from "../math/types.js";
import type { SceneNode } from "../scene/scene-node.js";
import { mat4PerspectiveLH, mat4Multiply } from "../math/mat4.js";

/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Pure state, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    children: SceneNode[];
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

// ─── Per-camera matrix cache (lazy, auto-created) ────────────────────
interface CameraCache {
    view: Float32Array & Mat4;
    viewVer: number;
    proj: Float32Array & Mat4;
    projVer: number;
    projAspect: number;
    vp: Float32Array & Mat4;
    vpVer: number;
    vpAspect: number;
}

const _caches = new WeakMap<Camera, CameraCache>();

function getCache(cam: Camera): CameraCache {
    let c = _caches.get(cam);
    if (!c) {
        c = {
            view: new Float32Array(16) as Float32Array & Mat4,
            viewVer: -1,
            proj: new Float32Array(16) as Float32Array & Mat4,
            projVer: -1,
            projAspect: -1,
            vp: new Float32Array(16) as Float32Array & Mat4,
            vpVer: -1,
            vpAspect: -1,
        };
        _caches.set(cam, c);
    }
    return c;
}

/** Compute the view matrix for a camera. Cached per worldMatrixVersion. */
export function getViewMatrix(camera: Camera): Mat4 {
    const c = getCache(camera);
    const ver = camera.worldMatrixVersion;
    if (ver === c.viewVer) {
        return c.view;
    }
    const w = camera.worldMatrix;
    c.view[0] = w[0]!;
    c.view[1] = w[4]!;
    c.view[2] = w[8]!;
    c.view[3] = 0;
    c.view[4] = w[1]!;
    c.view[5] = w[5]!;
    c.view[6] = w[9]!;
    c.view[7] = 0;
    c.view[8] = w[2]!;
    c.view[9] = w[6]!;
    c.view[10] = w[10]!;
    c.view[11] = 0;
    c.view[12] = -(w[0]! * w[12]! + w[1]! * w[13]! + w[2]! * w[14]!);
    c.view[13] = -(w[4]! * w[12]! + w[5]! * w[13]! + w[6]! * w[14]!);
    c.view[14] = -(w[8]! * w[12]! + w[9]! * w[13]! + w[10]! * w[14]!);
    c.view[15] = 1;
    c.viewVer = ver;
    return c.view;
}

/** Compute the projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const c = getCache(camera);
    const ver = camera.worldMatrixVersion;
    if (ver === c.projVer && aspectRatio === c.projAspect) {
        return c.proj;
    }
    const p = mat4PerspectiveLH(camera.fov, aspectRatio, camera.nearPlane, camera.farPlane);
    c.proj.set(p);
    c.projVer = ver;
    c.projAspect = aspectRatio;
    return c.proj;
}

/** Compute the view-projection matrix for a camera. Cached per worldMatrixVersion + aspect. */
export function getViewProjectionMatrix(camera: Camera, aspectRatio: number): Mat4 {
    const c = getCache(camera);
    const ver = camera.worldMatrixVersion;
    if (ver === c.vpVer && aspectRatio === c.vpAspect) {
        return c.vp;
    }
    const vp = mat4Multiply(getProjectionMatrix(camera, aspectRatio), getViewMatrix(camera));
    c.vp.set(vp);
    c.vpVer = ver;
    c.vpAspect = aspectRatio;
    return c.vp;
}

/** Get the world-space position of a camera. */
export function getCameraPosition(camera: Camera): Vec3 {
    const w = camera.worldMatrix;
    return { x: w[12]!, y: w[13]!, z: w[14]! };
}
