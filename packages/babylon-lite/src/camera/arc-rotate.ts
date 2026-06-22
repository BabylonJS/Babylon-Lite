import type { Camera, NormalizedViewport } from "./camera.js";
import type { Vec3, Mat4 } from "../math/types.js";
import { mat4LookAtLH } from "../math/mat4-look-at-lh.js";
import { Vec3Up } from "../math/vec3-up.js";
import type { IWorldMatrixProvider, IParentable } from "../scene/parentable.js";
import { createWorldMatrixState, attachWorldMatrixState } from "../scene/world-matrix-state.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { Mat4Storage } from "../math/types.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

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

    /** Mouse-drag orbit sensitivity (HIGHER = slower rotation). Babylon default 1000. */
    angularSensibility: number;
    /** Right-drag panning sensitivity in pixels-per-unit (LOWER = faster pan). Babylon default 50. */
    panningSensibility: number;
    /** Wheel-zoom sensitivity (HIGHER = slower zoom). Babylon default 3. */
    wheelPrecision: number;

    /** Per-frame inertial offsets — accumulated by input, applied & decayed each frame. */
    inertialAlphaOffset: number;
    inertialBetaOffset: number;
    inertialRadiusOffset: number;
    inertialPanningX: number;
    inertialPanningY: number;

    /**
     * Optional orbit limits enforced by {@link attachControl}'s per-frame loop.
     * `undefined` means unbounded on that side. Set these via {@link setCameraLimits}
     * so the current pose is clamped immediately (and inertia zeroed at the wall),
     * avoiding any overshoot-then-snap jiggle. Angles are in radians.
     */
    lowerAlphaLimit?: number;
    upperAlphaLimit?: number;
    lowerBetaLimit?: number;
    upperBetaLimit?: number;
    lowerRadiusLimit?: number;
    upperRadiusLimit?: number;

    /** @internal Self-clamp hook installed by {@link setCameraLimits}. The
     *  alpha/beta/radius setters invoke it immediately after every mutation, so
     *  the camera is never observably out of its orbit limits — at any point a
     *  per-frame callback (e.g. a camera-pinned skybox) reads it. This is what
     *  makes a direct pinch write or inertial overshoot snap to the wall in the
     *  same statement that caused it, with no one-frame "blink". Undefined until
     *  limits are set, so cameras that never call setCameraLimits carry none of
     *  the clamp code and the setters' `?.()` call is a single dead check. */
    _clampToLimits?: () => void;

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

    // Reusable local-world matrix.
    const _localMat: Mat4 = allocateMat4();

    function cameraLocalWorldMatrix(): Mat4 {
        const eye = localEyePosition();
        const v = mat4LookAtLH(eye, cam.target, Vec3Up);
        const m = _localMat as unknown as Mat4Storage;
        // Transpose upper 3×3 of view = camera-to-world rotation; translation = eye.
        m[0] = v[0]!;
        m[1] = v[4]!;
        m[2] = v[8]!;
        m[3] = 0;
        m[4] = v[1]!;
        m[5] = v[5]!;
        m[6] = v[9]!;
        m[7] = 0;
        m[8] = v[2]!;
        m[9] = v[6]!;
        m[10] = v[10]!;
        m[11] = 0;
        m[12] = eye.x;
        m[13] = eye.y;
        m[14] = eye.z;
        m[15] = 1;
        return _localMat;
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
        angularSensibility: 1000,
        panningSensibility: 50,
        wheelPrecision: 3,
        inertialAlphaOffset: 0,
        inertialBetaOffset: 0,
        inertialRadiusOffset: 0,
        inertialPanningX: 0,
        inertialPanningY: 0,

        // Matrix caches use the process-global allocator — F32 by default,
        // F64 after an HPM engine is created. Same backing as the camera world
        // matrix above, so the camera's storage precision is uniform.
        _viewCache: allocateMat4() as unknown as Mat4Storage,
        _projCache: allocateMat4() as unknown as Mat4Storage,
        _vpCache: allocateMat4() as unknown as Mat4Storage,

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
                    // Self-clamp into orbit limits the instant a value changes, so
                    // no caller (pinch direct-write, inertia, auto-rotate) can leave
                    // the camera transiently out of bounds for any per-frame reader.
                    // No-op (and no clamp code bundled) until setCameraLimits runs.
                    cam._clampToLimits?.();
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
