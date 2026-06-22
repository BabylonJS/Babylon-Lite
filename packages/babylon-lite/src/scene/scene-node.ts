/** SceneNode — common base for all scene entities with TRS, parent, and children.
 *
 *  Provides position, rotationQuaternion (source of truth), rotation (Euler XYZ proxy),
 *  scaling, parent, worldMatrix, worldMatrixVersion, and children. */

import type { Mat4 } from "../math/types.js";
import type { LiteMetadata } from "../metadata.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { mat4Compose } from "../math/mat4-compose.js";
import { mat4Identity } from "../math/mat4-identity.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState, attachWorldMatrixState } from "./world-matrix-state.js";

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

/** Common base for all scene entities: TRS transform, parent/children hierarchy, and a cached world matrix. */
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
    /** User metadata. glTF loads populate `metadata.gltf.extras` when source extras exist. */
    metadata?: LiteMetadata;
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

/** Create a live bidirectional EulerProxy backed by the given ObservableQuat.
 *
 *  Euler⇄quaternion is many-to-one and `quatToEulerXYZ` is unstable at gimbal lock
 *  (e.g. yaw near ±π/2), so re-deriving Euler from the quaternion on every read makes
 *  per-axis updates (`node.rotation.x = …; node.rotation.y = …`) lossy and can flip the
 *  node. To stay stable, the proxy caches the Euler triple it last applied and reuses it
 *  while the quaternion is unchanged; it only re-derives from the quaternion when the
 *  quaternion was written externally (detected via its version counter). */
export function createEulerProxy(rq: ObservableQuat): EulerProxy {
    let ex = 0;
    let ey = 0;
    let ez = 0;
    // Snapshot of rq.version at the last sync. -1 forces an initial derive.
    let syncedVersion = -1;

    const sync = (): void => {
        if (rq.version !== syncedVersion) {
            const e = quatToEulerXYZ(rq.x, rq.y, rq.z, rq.w);
            ex = e[0];
            ey = e[1];
            ez = e[2];
            syncedVersion = rq.version;
        }
    };

    const apply = (x: number, y: number, z: number): void => {
        ex = x;
        ey = y;
        ez = z;
        const [a, b, c, d] = eulerToQuat(x, y, z);
        rq.set(a, b, c, d);
        // The cached Euler is authoritative for this quaternion value, so adopt the
        // version we just produced — avoids an immediate lossy re-derive on next read.
        syncedVersion = rq.version;
    };

    return {
        get x() {
            sync();
            return ex;
        },
        set x(v: number) {
            sync();
            apply(v, ey, ez);
        },
        get y() {
            sync();
            return ey;
        },
        set y(v: number) {
            sync();
            apply(ex, v, ez);
        },
        get z() {
            sync();
            return ez;
        },
        set z(v: number) {
            sync();
            apply(ex, ey, v);
        },
        set: apply,
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
    attachWorldMatrixState(node, wm);
    return node;
}
