import type { Vec3, Mat4 } from "../math/types.js";

/** Minimal camera contract — any camera that can provide view/projection matrices.
 *  Both ArcRotateCamera and FreeCamera implement this interface.
 *  Plain data, no scene knowledge (pillar 4b). */
export interface Camera {
    fov: number;
    nearPlane: number;
    farPlane: number;
    readonly worldMatrixVersion: number;
    getViewMatrix(): Mat4;
    getProjectionMatrix(aspectRatio: number): Mat4;
    getViewProjectionMatrix(aspectRatio: number): Mat4;
    getPosition(): Vec3;
}
