import type { Vec3, Mat4 } from "../math/types.js";
import { Vec3Up } from "../math/vec3.js";
import { mat4LookAtLH, mat4Identity } from "../math/mat4.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import { createWorldMatrixState } from "../scene/world-matrix-state.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import type { SceneNode } from "../scene/scene-node.js";

/** ArcRotateCamera — orbits around a target point.
 *  Uses Babylon.js convention: left-handed, alpha=rotation around Y, beta=elevation.
 *  Plain data + methods. Does NOT know about the scene.
 *
 *  Push-based dirty tracking: alpha/beta/radius use Object.defineProperty,
 *  target uses ObservableVec3. Changes call wm.markLocalDirty() immediately.
 *
 *  Inertia follows the Babylon.js model: input handlers accumulate per-frame
 *  offsets (inertialAlphaOffset, etc.) which are applied and exponentially
 *  decayed each frame by the controls module. */
export interface ArcRotateCamera extends IWorldMatrixProvider, IParentable {
    alpha: number;
    beta: number;
    radius: number;
    target: Vec3;
    fov: number;
    nearPlane: number;
    farPlane: number;
    children: SceneNode[];

    /** Inertia coefficient for rotation and zoom (0 = instant stop, 0.9 = default, 1 = no decay). */
    inertia: number;
    /** Inertia coefficient for panning (0 = instant stop, 0.9 = default). */
    panningInertia: number;

    /** Per-frame inertial offsets — accumulated by input, applied & decayed each frame. */
    inertialAlphaOffset: number;
    inertialBetaOffset: number;
    inertialRadiusOffset: number;
    inertialPanningX: number;
    inertialPanningY: number;

    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
}

/** Create a bare ArcRotateCamera with given params. Pure data, no scene knowledge. */
export function createArcRotateCamera(alpha: number, beta: number, radius: number, target: Vec3): ArcRotateCamera {
    function localEyePosition(): Vec3 {
        const cosA = Math.cos(cam.alpha),
            sinA = Math.sin(cam.alpha);
        const cosB = Math.cos(cam.beta);
        let sinB = Math.sin(cam.beta);
        if (sinB === 0) {
            sinB = 0.0001;
        }
        return {
            x: cam.target.x + cam.radius * cosA * sinB,
            y: cam.target.y + cam.radius * cosB,
            z: cam.target.z + cam.radius * sinA * sinB,
        };
    }

    function cameraLocalWorldMatrix(): Mat4 {
        const eye = localEyePosition();
        const view = mat4LookAtLH(eye, cam.target, Vec3Up);
        // Transpose upper 3×3 of view = camera-to-world rotation
        const m = mat4Identity();
        m[0] = view[0]!;
        m[1] = view[4]!;
        m[2] = view[8]!;
        m[4] = view[1]!;
        m[5] = view[5]!;
        m[6] = view[9]!;
        m[8] = view[2]!;
        m[9] = view[6]!;
        m[10] = view[10]!;
        m[12] = eye.x;
        m[13] = eye.y;
        m[14] = eye.z;
        return m;
    }

    const wm = createWorldMatrixState(cameraLocalWorldMatrix);
    const onDirty = () => wm.markLocalDirty();

    let _alpha = alpha,
        _beta = beta,
        _radius = radius;

    const cam: ArcRotateCamera = {
        alpha: 0 as number, // placeholder — overridden by defineProperty below
        beta: 0 as number,
        radius: 0 as number,
        target: new ObservableVec3(target.x, target.y, target.z, onDirty) as unknown as Vec3,
        fov: 0.8,
        nearPlane: 0.1,
        farPlane: 1000,
        children: [] as SceneNode[],

        inertia: 0.9,
        panningInertia: 0.9,
        inertialAlphaOffset: 0,
        inertialBetaOffset: 0,
        inertialRadiusOffset: 0,
        inertialPanningX: 0,
        inertialPanningY: 0,

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
    };

    // Push-based dirty tracking for scalar camera params that affect worldMatrix
    Object.defineProperty(cam, "alpha", {
        get() {
            return _alpha;
        },
        set(v: number) {
            if (_alpha !== v) {
                _alpha = v;
                onDirty();
            }
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(cam, "beta", {
        get() {
            return _beta;
        },
        set(v: number) {
            if (_beta !== v) {
                _beta = v;
                onDirty();
            }
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(cam, "radius", {
        get() {
            return _radius;
        },
        set(v: number) {
            if (_radius !== v) {
                _radius = v;
                onDirty();
            }
        },
        configurable: true,
        enumerable: true,
    });

    return cam;
}
