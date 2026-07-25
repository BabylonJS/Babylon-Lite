/** SceneNode — common base for all scene entities with TRS, parent, and children.
 *
 *  Provides position, rotationQuaternion (source of truth), rotation (Euler XYZ proxy),
 *  scaling, parent, worldMatrix, worldMatrixVersion, and children. */

import type { Mat4 } from "../math/types.js";
import type { LiteMetadata } from "../metadata.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState, attachWorldMatrixState, composeTrsLocalMatrix } from "./world-matrix-state.js";
import { eulerToQuat, quatToEulerXYZ } from "../math/quat-euler.js";

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
    readonly position: ObservableVec3;
    /** Quaternion rotation — source of truth for the local matrix. */
    readonly rotationQuaternion: ObservableQuat;
    /** Euler XYZ bidirectional proxy — reads decompose current quat; writes update quat atomically. */
    readonly rotation: EulerProxy;
    readonly scaling: ObservableVec3;
    parent: IWorldMatrixProvider | null;
    readonly worldMatrix: Mat4;
    readonly worldMatrixVersion: number;
    /** @internal Raw local matrix for glTF matrix nodes. While set, it IS the local transform and
     *  `position`/`rotationQuaternion`/`scaling` are ignored. Clearing it hands control back to the
     *  TRS triple (what `setParent` does so it can move a `matrix`-declared glTF node). */
    _localMatrix?: Mat4;
    /** Self-visibility. Undefined/true = visible; `false` skips render + camera AABB.
     *  Cascade is materialized at write-time by `setSubtreeVisible`. */
    visible?: boolean;
    /** User metadata. glTF loads populate `metadata.gltf.extras` when source extras exist. */
    metadata?: LiteMetadata;
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
    // Read the raw matrix off the node, not off a captured local: clearing `_localMatrix`
    // (setParent on a glTF `matrix` node) must switch the node back to TRS-driven.
    const wm = createWorldMatrixState(() => {
        return node._localMatrix ?? composeTrsLocalMatrix(node.position, node.rotationQuaternion, node.scaling);
    });
    const onWmDirty = () => {
        if (!node._localMatrix) {
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
