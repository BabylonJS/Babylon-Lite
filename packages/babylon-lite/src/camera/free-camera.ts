import type { Camera } from "./camera.js";
import type { Vec3, Mat4 } from "../math/types.js";
import { mat4LookAtLH } from "../math/mat4-look-at-lh.js";
import { Vec3Up } from "../math/vec3-up.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../scene/world-matrix-state.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import type { SceneNode } from "../scene/scene-node.js";

/** FreeCamera — positioned in world space, looking at a target point.
 *  Matches Babylon.js FreeCamera: position + target, left-handed.
 *  Plain data + methods. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: position and target use ObservableVec3,
 *  _yaw/_pitch use Object.defineProperty. */
export interface FreeCamera extends Camera, IWorldMatrixProvider, IParentable {
    position: ObservableVec3;
    target: ObservableVec3;
    /** Movement speed. Default 2.0 (matches BJS). */
    speed: number;
    /** Mouse rotation sensitivity (higher = less sensitive). Default 2000 (matches BJS). */
    angularSensitivity: number;
    /** Inertia damping factor (0 = instant stop, 0.9 = smooth). Default 0.9 (matches BJS). */
    inertia: number;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** @internal FreeCamera with internal yaw/pitch state. Not re-exported from index.ts. */
export interface FreeCameraInternal extends FreeCamera {
    _yaw: number;
    _pitch: number;
}

/** Create a FreeCamera at the given position looking at target. Pure data, no scene knowledge. */
export function createFreeCamera(position: Vec3, target: Vec3): FreeCamera {
    // Compute initial yaw/pitch from position→target direction
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const dz = target.z - position.z;

    const _localMat = new Float32Array(16) as Mat4;

    function cameraLocalWorldMatrix(): Mat4 {
        const view = mat4LookAtLH(cam.position, cam.target, Vec3Up);
        // Camera-to-world = transpose upper 3×3 of view + eye position
        _localMat[0] = view[0]!;
        _localMat[1] = view[4]!;
        _localMat[2] = view[8]!;
        _localMat[3] = 0;
        _localMat[4] = view[1]!;
        _localMat[5] = view[5]!;
        _localMat[6] = view[9]!;
        _localMat[7] = 0;
        _localMat[8] = view[2]!;
        _localMat[9] = view[6]!;
        _localMat[10] = view[10]!;
        _localMat[11] = 0;
        _localMat[12] = cam.position.x;
        _localMat[13] = cam.position.y;
        _localMat[14] = cam.position.z;
        _localMat[15] = 1;
        return _localMat;
    }

    const wm = createWorldMatrixState(cameraLocalWorldMatrix);
    const onDirty = () => wm.markLocalDirty();

    let _yaw = Math.atan2(dx, dz);
    let _pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));

    const cam: FreeCamera = {
        position: new ObservableVec3(position.x, position.y, position.z, onDirty),
        target: new ObservableVec3(target.x, target.y, target.z, onDirty),
        fov: 0.8,
        nearPlane: 1,
        farPlane: 10000,
        speed: 2.0,
        angularSensitivity: 2000,
        inertia: 0.9,
        children: [] as SceneNode[],

        get parent() {
            return wm.parent;
        },
        set parent(v) {
            wm.parent = v;
        },
        get worldMatrix() {
            return wm.getWorldMatrix();
        },
        get worldMatrixVersion() {
            return wm.getWorldMatrixVersion();
        },
    } as FreeCamera;

    // Push-based dirty for yaw/pitch
    Object.defineProperty(cam, "_yaw", {
        get() {
            return _yaw;
        },
        set(v: number) {
            if (_yaw !== v) {
                _yaw = v;
                onDirty();
            }
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(cam, "_pitch", {
        get() {
            return _pitch;
        },
        set(v: number) {
            if (_pitch !== v) {
                _pitch = v;
                onDirty();
            }
        },
        configurable: true,
        enumerable: true,
    });

    // Tag so children parented to this camera get push invalidation (O(1) reads).
    attachWorldMatrixState(cam, wm);

    return cam;
}
