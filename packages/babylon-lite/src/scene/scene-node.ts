/** SceneNode — common base for all scene entities with TRS, parent, and children.
 *
 *  Provides position, rotationQuaternion (source of truth), rotation (Euler XYZ proxy),
 *  scaling, parent, worldMatrix, worldMatrixVersion, and children. */

import type { Mat4, Mat4Storage, Quat, Vec3 } from "../math/types.js";
import type { LiteMetadata } from "../metadata.js";
import type { IWorldMatrixProvider } from "./parentable.js";
import { ObservableVec3 } from "../math/observable-vec3.js";
import { ObservableQuat } from "../math/observable-quat.js";
import { createWorldMatrixState, attachWorldMatrixState, composeTrsLocalMatrixIntoBuffer } from "./world-matrix-state.js";
import { eulerXYZToQuatTuple, quatToEulerXYZTuple } from "../math/quat-euler.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

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
    /** @internal Raw glTF matrices ignore TRS writes until `setParent` seeds an editable baseline. */
    _localMatrixLocked?: boolean;
    /** Self-visibility. Undefined/true = visible; `false` skips render + camera AABB.
     *  Cascade is materialized at write-time by `setSubtreeVisible`. */
    visible?: boolean;
    /** User metadata. glTF loads populate `metadata.gltf.extras` when source extras exist. */
    metadata?: LiteMetadata;
    /** @internal Creates an independent clone for specialized SceneNode implementations. */
    _cloneNode?: () => SceneNode;
}

/** Create a live bidirectional EulerProxy backed by the given ObservableQuat.
 *
 *  Euler⇄quaternion is many-to-one and `quatToEulerXYZTuple` is unstable at gimbal lock
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
            const e = quatToEulerXYZTuple(rq.x, rq.y, rq.z, rq.w);
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
        const [a, b, c, d] = eulerXYZToQuatTuple(x, y, z);
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

export function createSceneNodeFromMatrix(name: string, matrix: Mat4, translation?: Vec3, rotation?: Quat, scale?: Vec3): SceneNode {
    const node = createSceneNodeCore(
        name,
        matrix,
        translation?.x,
        translation?.y,
        translation?.z,
        rotation?.x,
        rotation?.y,
        rotation?.z,
        rotation?.w,
        scale?.x,
        scale?.y,
        scale?.z
    );
    node._localMatrixLocked = translation ? undefined : true;
    return node;
}

function createSceneNodeCore(name: string, matrix: Mat4 | null, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1): SceneNode {
    const node = initSceneNodeTransform({ name, children: [] }, px, py, pz, qx, qy, qz, qw, sx, sy, sz);
    if (matrix) {
        node._localMatrix = matrix;
    }
    return node;
}

/** Add the common SceneNode transform contract to an existing object. */
export function initSceneNodeTransform<T extends SceneNode>(partialNode: Partial<T>, px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1): T {
    let localMatrix: Mat4 | undefined;
    // Read the raw matrix off the node, not off a captured local: clearing `_localMatrix`
    // (setParent on a glTF `matrix` node) must switch the node back to TRS-driven.
    const wm = createWorldMatrixState(() => {
        if (node._localMatrix) {
            return node._localMatrix;
        }
        localMatrix ??= allocateMat4();
        composeTrsLocalMatrixIntoBuffer(localMatrix as unknown as Mat4Storage, position, rq, scaling);
        return localMatrix;
    });
    const onWmDirty = () => {
        if (node._localMatrixLocked) {
            return;
        }
        node._localMatrix = undefined;
        wm.markLocalDirty();
    };

    const position = new ObservableVec3(px, py, pz, onWmDirty);
    const rq = new ObservableQuat(qx, qy, qz, qw, onWmDirty);
    const rotation = createEulerProxy(rq);
    const scaling = new ObservableVec3(sx, sy, sz, onWmDirty);

    const node = {
        ...partialNode,
        position,
        rotationQuaternion: rq,
        rotation,
        scaling,
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
    } as T;
    attachWorldMatrixState(node, wm);
    return node;
}
