import type { Camera, NormalizedViewport } from "./camera.js";
import type { Vec3, Mat4 } from "../math/types.js";
import { mat4LookAtLH } from "../math/mat4-look-at-lh.js";
import { Vec3Up } from "../math/vec3-up.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../scene/world-matrix-state.js";
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
export interface ArcRotateCamera extends Camera, IWorldMatrixProvider, IParentable {
    alpha: number;
    beta: number;
    radius: number;
    target: Vec3;
    fov: number;
    nearPlane: number;
    farPlane: number;
    viewport?: NormalizedViewport;
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
        const v = mat4LookAtLH(eye, cam.target, Vec3Up);
        // Transpose upper 3×3 of view = camera-to-world rotation; translation = eye.
        return new Float32Array([v[0]!, v[4]!, v[8]!, 0, v[1]!, v[5]!, v[9]!, 0, v[2]!, v[6]!, v[10]!, 0, eye.x, eye.y, eye.z, 1]) as Mat4;
    }

    const wm = createWorldMatrixState(cameraLocalWorldMatrix);
    const onDirty = (): void => wm.markLocalDirty();

    const scalars = { alpha, beta, radius };

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

    // Push-based dirty tracking for scalar camera params that affect worldMatrix.
    for (const key of ["alpha", "beta", "radius"] as const) {
        Object.defineProperty(cam, key, {
            get: () => scalars[key],
            set: (v: number) => {
                if (scalars[key] !== v) {
                    scalars[key] = v;
                    onDirty();
                }
            },
            configurable: true,
            enumerable: true,
        });
    }

    // Tag so children parented to this camera get push invalidation (O(1) reads).
    attachWorldMatrixState(cam, wm);

    return cam;
}
