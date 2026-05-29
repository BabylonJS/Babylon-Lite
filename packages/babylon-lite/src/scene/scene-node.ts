/** SceneNode — common base for all scene entities with TRS, parent, and children.
 *
 *  Provides position, rotationQuaternion (source of truth), rotation (Euler XYZ proxy),
 *  scaling, parent, worldMatrix, worldMatrixVersion, and children. */

import type { Mat4 } from "../math/types.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4Compose } from "../math/mat4-compose.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState } from "./world-matrix-state.js";

// ─── EulerProxy ──────────────────────────────────────────────────────

/** Bidirectional Euler XYZ view over a quaternion.
 *  Reads decompose the current quaternion on the fly; writes convert Euler→quat atomically. */
export interface EulerProxy {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
}

// ─── SceneNode ───────────────────────────────────────────────────────

export interface SceneNode {
    name: string;
    children: SceneNode[];
    position: ObservableVec3;
    /** Quaternion rotation — source of truth for the local matrix. */
    rotationQuaternion: ObservableQuat;
    /** Euler XYZ bidirectional proxy — reads decompose current quat; writes update quat atomically. */
    rotation: EulerProxy;
    scaling: ObservableVec3;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    /** @internal Raw local matrix for glTF matrix nodes. */
    _localMatrix?: Mat4;
    /** Self-visibility. Undefined/true = visible; `false` skips render + camera AABB.
     *  Cascade is materialized at write-time by `setSubtreeVisible`. */
    visible?: boolean;
}

// ─── Math helpers ─────────────────────────────────────────────────────

/** Euler XYZ → quaternion (intrinsic XYZ order). */
export function eulerToQuat(rx: number, ry: number, rz: number): [number, number, number, number] {
    const cx = Math.cos(rx * 0.5),
        sx_ = Math.sin(rx * 0.5);
    const cy = Math.cos(ry * 0.5),
        sy_ = Math.sin(ry * 0.5);
    const cz = Math.cos(rz * 0.5),
        sz_ = Math.sin(rz * 0.5);
    return [sx_ * cy * cz + cx * sy_ * sz_, cx * sy_ * cz - sx_ * cy * sz_, cx * cy * sz_ + sx_ * sy_ * cz, cx * cy * cz - sx_ * sy_ * sz_];
}

/** Quaternion → Euler XYZ (inverse of eulerToQuat). */
export function quatToEulerXYZ(qx: number, qy: number, qz: number, qw: number): [number, number, number] {
    const sinY = 2 * (qx * qz + qw * qy);
    const ry = Math.asin(Math.max(-1, Math.min(1, sinY)));
    const rx = Math.atan2(-(2 * (qy * qz - qw * qx)), 1 - 2 * (qx * qx + qy * qy));
    const rz = Math.atan2(-(2 * (qx * qy - qw * qz)), 1 - 2 * (qy * qy + qz * qz));
    return [rx, ry, rz];
}

/** Create a live bidirectional EulerProxy backed by the given ObservableQuat. */
export function createEulerProxy(rq: ObservableQuat): EulerProxy {
    const e = () => quatToEulerXYZ(rq.x, rq.y, rq.z, rq.w);
    const s = (x: number, y: number, z: number) => {
        const [a, b, c, d] = eulerToQuat(x, y, z);
        rq.set(a, b, c, d);
    };
    return {
        get x() {
            return e()[0];
        },
        set x(v: number) {
            const r = e();
            s(v, r[1], r[2]);
        },
        get y() {
            return e()[1];
        },
        set y(v: number) {
            const r = e();
            s(r[0], v, r[2]);
        },
        get z() {
            return e()[2];
        },
        set z(v: number) {
            const r = e();
            s(r[0], r[1], v);
        },
        set: s,
    };
}

// ─── Factory ──────────────────────────────────────────────────────────

/** Create a SceneNode with given TRS (position and scaling in cartesian, rotation as quaternion). */
export function createSceneNode(name: string, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1): SceneNode {
    return createSceneNodeCore(name, null, px, py, pz, qx, qy, qz, qw, sx, sy, sz);
}

export function createSceneNodeFromMatrix(name: string, matrix: Mat4): SceneNode {
    return createSceneNodeCore(name, matrix);
}

function createSceneNodeCore(name: string, matrix: Mat4 | null, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1): SceneNode {
    const wm = createWorldMatrixState(() => {
        if (matrix) {
            return matrix;
        }
        const p = node.position,
            rq = node.rotationQuaternion,
            s = node.scaling;
        const isIdentity = p.x === 0 && p.y === 0 && p.z === 0 && rq.x === 0 && rq.y === 0 && rq.z === 0 && rq.w === 1 && s.x === 1 && s.y === 1 && s.z === 1;
        return isIdentity ? mat4Identity() : mat4Compose(p.x, p.y, p.z, rq.x, rq.y, rq.z, rq.w, s.x, s.y, s.z);
    });
    const onWmDirty = () => {
        if (!matrix) {
            wm.markLocalDirty();
        }
    };

    const rq = new ObservableQuat(qx, qy, qz, qw, onWmDirty);

    const node: SceneNode = {
        name,
        children: [],
        position: new ObservableVec3(px, py, pz, onWmDirty),
        rotationQuaternion: rq,
        rotation: createEulerProxy(rq),
        scaling: new ObservableVec3(sx, sy, sz, onWmDirty),
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
    if (matrix) {
        node._localMatrix = matrix;
    }
    return node;
}
