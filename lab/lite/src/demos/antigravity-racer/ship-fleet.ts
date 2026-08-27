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

import type { HierarchyInstancePool, SceneContext, SceneNode, Vec3 } from "babylon-lite";
import { addHierarchyInstance, addToScene, mat4Compose, mat4Multiply, setHierarchyInstanceCount, setHierarchyInstanceMatrix } from "babylon-lite";

import { instantiateModel, type RacerAssets } from "./assets.js";
import { bjsEulerToQuat } from "./bjs-euler.js";
import { SHIP_MODEL_YAW } from "./constants.js";

export interface ShipFleet {
    readonly root: SceneNode;
    readonly pool: HierarchyInstancePool;
    /** Place ship `index`. `orientation` is the world (right, up, forward) rotation quaternion. */
    setShipTransform(index: number, worldPos: Vec3, orientation: { x: number; y: number; z: number; w: number }, wobble: Vec3, tiltZ: number): void;
    /** Show/hide the whole fleet (used while the track editor is open). */
    setVisibleCount(count: number): void;
}

/** Clone the ship model and build a pool of `count` racers, all initially at the origin. */
export function createShipFleet(assets: RacerAssets, count: number): ShipFleet {
    const { root, pool } = instantiateModel(assets.shipTemplate, count);
    const identity = mat4Compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);
    for (let i = 0; i < count; i++) {
        addHierarchyInstance(pool, identity);
    }
    return {
        root,
        pool,
        setShipTransform(index, worldPos, orientation, wobble, tiltZ): void {
            const local = bjsEulerToQuat(0, SHIP_MODEL_YAW, tiltZ);
            const shipTransform = mat4Compose(wobble.x, wobble.y, wobble.z, local.x, local.y, local.z, local.w, 1, 1, 1);
            const shipMesh = mat4Compose(worldPos.x, worldPos.y, worldPos.z, orientation.x, orientation.y, orientation.z, orientation.w, 1, 1, 1);
            setHierarchyInstanceMatrix(pool, index, mat4Multiply(shipMesh, shipTransform));
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
