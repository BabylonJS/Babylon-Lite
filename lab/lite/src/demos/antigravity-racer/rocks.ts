/**
 * Antigravity Racer — the decorative boulders.
 *
 * The same CC BY 4.0 "Obj_Nat_Rock_01" model the source playground scatters, at
 * the seven exact transforms authored there (see `ROCK_TRANSFORMS`), drawn as
 * one thin-instance pool.
 *
 * The playground places each boulder by replacing the loaded root's transform,
 * which removes Babylon's glTF handedness-conversion root. The Lite clone drops
 * that root transform before its seven authored TRS matrices are applied, so
 * geometry, placement, orientation, and non-uniform scale all match the source.
 */

import type { HierarchyInstancePool, SceneContext, SceneNode } from "babylon-lite";
import { addHierarchyInstance, addToScene, mat4Compose } from "babylon-lite";

import { instantiateModel, type RacerAssets } from "./assets.js";
import { bjsEulerToQuat } from "./bjs-euler.js";
import { ROCK_TRANSFORMS } from "./constants.js";

export interface RockField {
    readonly root: SceneNode;
    readonly pool: HierarchyInstancePool;
}

export function createRocks(assets: RacerAssets): RockField {
    const { root, pool } = instantiateModel(assets.rockTemplate, ROCK_TRANSFORMS.length, true);
    for (const t of ROCK_TRANSFORMS) {
        const q = bjsEulerToQuat(t.rotation[0], t.rotation[1], t.rotation[2]);
        const trs = mat4Compose(t.position[0], t.position[1], t.position[2], q.x, q.y, q.z, q.w, t.scaling[0], t.scaling[1], t.scaling[2]);
        addHierarchyInstance(pool, trs);
    }
    // `rocks[i].receiveShadows = true` in the playground; they are also shadow casters (wired by world.ts).
    for (const mesh of pool.meshes) {
        mesh.receiveShadows = true;
    }
    return { root, pool };
}

export function addRocksToScene(scene: SceneContext, rocks: RockField): void {
    addToScene(scene, rocks.root);
}
