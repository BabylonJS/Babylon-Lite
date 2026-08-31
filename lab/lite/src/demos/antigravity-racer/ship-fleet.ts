/**
 * Antigravity Racer — the ship fleet.
 *
 * Every racer is the SAME model the source playground loads (the CC BY 4.0
 * "RHS-X"), drawn as one thin-instance pool: the model is cloned once per mode
 * and each of the eight ships is a per-instance world matrix, so the whole grid
 * costs one draw per source primitive.
 *
 * The instance matrix reproduces the playground's two-level ship transform
 * exactly:
 *
 *   ShipMesh      — world placement: position = worldPos, rotation = the
 *                   (right, up, direction) basis the simulation maintains.
 *   ShipTransform — local: position = the anti-gravity wobble, rotation =
 *                   Babylon Euler (0, π, tilt) — the π yaw is the source's
 *                   `_ShipTransform.rotation.y = Math.PI`, which turns the model
 *                   around to face along the track.
 *
 * `instance = ShipMesh · ShipTransform` (column-major, so ShipTransform applies
 * first), composed on top of the model's own glTF hierarchy by the pool.
 */

import type { HierarchyInstancePool, Mat4, SceneContext, SceneNode, Vec3 } from "babylon-lite";
import { addHierarchyInstance, addToScene, mat4Compose, setHierarchyInstanceCount, setHierarchyInstanceMatrix } from "babylon-lite";

import { instantiateModel, type RacerAssets } from "./assets.js";
import { bjsEulerToQuatInto } from "./bjs-euler.js";
import { SHIP_MODEL_YAW } from "./constants.js";

export interface ShipFleet {
    readonly root: SceneNode;
    readonly pool: HierarchyInstancePool;
    /** Place ship `index`. `orientation` is the world (right, up, forward) rotation quaternion. */
    setShipTransform(index: number, worldPos: Vec3, orientation: { x: number; y: number; z: number; w: number }, wobble: Vec3, tiltZ: number): void;
    /** Show/hide the whole fleet (used while the track editor is open). */
    setVisibleCount(count: number): void;
}

function composeMatrix(dst: Float32Array, tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number): void {
    const xx = qx * qx;
    const yy = qy * qy;
    const zz = qz * qz;
    const xy = qx * qy;
    const xz = qx * qz;
    const yz = qy * qz;
    const wx = qw * qx;
    const wy = qw * qy;
    const wz = qw * qz;
    dst[0] = 1 - 2 * (yy + zz);
    dst[1] = 2 * (xy + wz);
    dst[2] = 2 * (xz - wy);
    dst[3] = 0;
    dst[4] = 2 * (xy - wz);
    dst[5] = 1 - 2 * (xx + zz);
    dst[6] = 2 * (yz + wx);
    dst[7] = 0;
    dst[8] = 2 * (xz + wy);
    dst[9] = 2 * (yz - wx);
    dst[10] = 1 - 2 * (xx + yy);
    dst[11] = 0;
    dst[12] = tx;
    dst[13] = ty;
    dst[14] = tz;
    dst[15] = 1;
}

function multiplyMatrices(dst: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let column = 0; column < 4; column++) {
        const offset = column * 4;
        const b0 = b[offset]!;
        const b1 = b[offset + 1]!;
        const b2 = b[offset + 2]!;
        const b3 = b[offset + 3]!;
        dst[offset] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
        dst[offset + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
        dst[offset + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
        dst[offset + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
    }
}

/** Clone the ship model and build a pool of `count` racers, all initially at the origin. */
export function createShipFleet(assets: RacerAssets, count: number): ShipFleet {
    const { root, pool } = instantiateModel(assets.shipTemplate, count);
    const identity = mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
    for (let i = 0; i < count; i++) {
        addHierarchyInstance(pool, identity);
    }
    for (let i = 0; i < pool.meshes.length; i++) {
        pool.meshes[i]!.receiveShadows = true;
    }
    // Per-fleet scratch matrices to avoid per-tick allocations.
    const _localMat = new Float32Array(16);
    const _worldMat = new Float32Array(16);
    const _resultMat = new Float32Array(16);
    const _localQuat = { x: 0, y: 0, z: 0, w: 1 };
    return {
        root,
        pool,
        setShipTransform(index, worldPos, orientation, wobble, tiltZ): void {
            bjsEulerToQuatInto(0, SHIP_MODEL_YAW, tiltZ, _localQuat);
            composeMatrix(_localMat, wobble.x, wobble.y, wobble.z, _localQuat.x, _localQuat.y, _localQuat.z, _localQuat.w);
            composeMatrix(_worldMat, worldPos.x, worldPos.y, worldPos.z, orientation.x, orientation.y, orientation.z, orientation.w);
            multiplyMatrices(_resultMat, _worldMat, _localMat);
            setHierarchyInstanceMatrix(pool, index, _resultMat as unknown as Mat4);
        },
        setVisibleCount(visible): void {
            setHierarchyInstanceCount(pool, visible);
        },
    };
}

/** Add the fleet's model hierarchy to a scene (safe to call for several scenes — split-screen). */
export function addShipFleetToScene(scene: SceneContext, fleet: ShipFleet): void {
    addToScene(scene, fleet.root);
}
